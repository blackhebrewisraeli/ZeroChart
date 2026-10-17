import type { Asset } from '@/lib/assets';
import { fetchHistoricalCandles, isBinanceCrypto } from '@/lib/binance';
import { atrAsync, macdAsync, rsiAsync } from '@/lib/financeClient';
import type { MacdResult } from '@/lib/indicators';
import {
  computeMultiFactorBreakdown,
  type MultiFactorBreakdown,
  type MultiFactorInputs,
} from '@/lib/multiFactor';
import { recommendPositionSize } from '@/lib/risk';
import {
  ASSET_COUNT_BY_RISK,
  type Allocation,
  type PortfolioPreferences,
} from '@/lib/portfolioBuilder';

/** OHLC-derived series for one asset, fetched in a single request. */
export interface HistoryData {
  closes: Float64Array;
  highs: Float64Array;
  lows: Float64Array;
}

/**
 * Worker-backed indicator bundle for the Multi-Factor Score. `macd` and
 * `atr14` are optional so injected test deps can supply a partial bundle —
 * missing series fall back to the static asset-table proxies.
 */
export interface IndicatorBundle {
  rsi14: Float64Array;
  macd?: MacdResult;
  atr14?: Float64Array;
}

export interface QuantDeps {
  fetchHistory: (ticker: string) => Promise<HistoryData>;
  computeIndicators: (history: HistoryData) => Promise<IndicatorBundle>;
}

const EMPTY_HISTORY: HistoryData = {
  closes: new Float64Array(0),
  highs: new Float64Array(0),
  lows: new Float64Array(0),
};

const defaultDeps: QuantDeps = {
  fetchHistory: async (ticker) => {
    const candles = await fetchHistoricalCandles(ticker, '1d', 200);
    if (candles.length === 0) return EMPTY_HISTORY;
    return {
      closes: Float64Array.from(candles.map((candle) => candle.close)),
      highs: Float64Array.from(candles.map((candle) => candle.high)),
      lows: Float64Array.from(candles.map((candle) => candle.low)),
    };
  },
  computeIndicators: async (history) => {
    const closes = Array.from(history.closes);
    const highs = Array.from(history.highs);
    const lows = Array.from(history.lows);
    // All heavy math runs in the finance Web Worker (cached per input series).
    const [rsi14, macdSeries, atrSeries] = await Promise.all([
      rsiAsync(closes, 14),
      macdAsync(closes, 12, 26, 9),
      atrAsync(highs, lows, closes, 14),
    ]);
    return { rsi14, macd: macdSeries, atr14: atrSeries };
  },
};

/** Last defined value of a warm-up-padded indicator series, if any. */
function lastFinite(series: Float64Array | undefined): number | null {
  if (!series) return null;
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const value = series[i];
    if (value !== undefined && Number.isFinite(value)) return value;
  }
  return null;
}

/** A valid positive live price for the asset, if the provider gave us one. */
function validPrice(asset: Asset): number | null {
  const price = asset.current_price;
  if (price !== null && Number.isFinite(price) && price > 0) return price;
  return null;
}

/**
 * Static ATR proxy when no candle history exists: price × |provider risk %|.
 * The provider column `risk_pct` is signed in the wild (about half the live
 * rows are negative), but volatility is a magnitude — taking the absolute
 * value lets every priced asset with risk data still be sized. Zero (or
 * missing) magnitude cannot size a trade, so it reports null.
 */
function atrProxy(asset: Asset, price: number | null): number | null {
  const risk = asset.risk_pct;
  if (price === null || risk === null || !Number.isFinite(risk)) return null;
  const magnitude = Math.abs(risk);
  return magnitude > 0 ? price * magnitude : null;
}

/** Multi-factor inputs derived from the static asset table (no history). */
function staticInputs(asset: Asset): MultiFactorInputs {
  const finite = (value: number | null) =>
    value !== null && Number.isFinite(value) ? value : null;
  return {
    rsi: finite(asset.rsi_14),
    momentumPercent: finite(asset.change_24h),
    // Signed provider risk → unsigned volatility magnitude (see atrProxy).
    volatilityPercent:
      asset.risk_pct !== null && Number.isFinite(asset.risk_pct) ? Math.abs(asset.risk_pct) : null,
  };
}

export interface ScoredAsset {
  asset: Asset;
  /** White-box Multi-Factor result: score, sub-scores, weights, regime, rationale. */
  breakdown: MultiFactorBreakdown;
  /** Resolved price (live or last close) used for sizing; null when unknown. */
  price: number | null;
  /** ATR(14) in price units — real for crypto, a risk-% proxy otherwise. */
  atr: number | null;
}

function staticScore(asset: Asset): ScoredAsset {
  const price = validPrice(asset);
  return {
    asset,
    breakdown: computeMultiFactorBreakdown(staticInputs(asset)),
    price,
    atr: atrProxy(asset, price),
  };
}

/**
 * Scores one asset with the Multi-Factor model (RSI · MACD · ATR regime).
 * Crypto history is fetched once as OHLC and the indicator math runs in the
 * finance Web Worker; stocks/forex (and fetch failures) fall back to the
 * static asset-table proxies for the same three factors. Never rejects.
 */
export async function scoreAsset(
  asset: Asset,
  deps: QuantDeps = defaultDeps,
): Promise<ScoredAsset> {
  if (!isBinanceCrypto(asset.ticker)) return staticScore(asset);

  try {
    const history = await deps.fetchHistory(asset.ticker);
    if (history.closes.length < 2) return staticScore(asset);

    const bundle = await deps.computeIndicators(history);
    const price = validPrice(asset) ?? lastFinite(history.closes);
    const atr = lastFinite(bundle.atr14) ?? atrProxy(asset, price);
    const statics = staticInputs(asset);
    const histogram = lastFinite(bundle.macd?.histogram);

    const inputs: MultiFactorInputs = {
      rsi: lastFinite(bundle.rsi14) ?? statics.rsi,
      momentumPercent:
        histogram !== null && price !== null && price > 0
          ? histogram / price
          : statics.momentumPercent,
      volatilityPercent:
        atr !== null && price !== null && price > 0 ? atr / price : statics.volatilityPercent,
    };

    return { asset, breakdown: computeMultiFactorBreakdown(inputs), price, atr };
  } catch {
    return staticScore(asset);
  }
}

/**
 * Builds a portfolio by fetching each crypto asset's OHLC history, computing
 * RSI/MACD/ATR in the Web Worker, scoring every candidate with the
 * Multi-Factor model, allocating capital proportionally to the normalized
 * scores, and attaching an ATR-based suggested position size that risks
 * exactly 2% of the requested capital.
 */
export async function buildQuantPortfolio(
  options: {
    preferences: PortfolioPreferences;
    availableAssets: Asset[];
    excludeTickers?: ReadonlySet<string>;
  },
  deps: QuantDeps = defaultDeps,
): Promise<Allocation[]> {
  const { preferences, availableAssets, excludeTickers = new Set<string>() } = options;

  const candidates = availableAssets.filter((asset) => !excludeTickers.has(asset.ticker));
  if (candidates.length === 0) return [];

  const scored = await Promise.all(candidates.map((asset) => scoreAsset(asset, deps)));
  const qualified = scored
    .filter((item) => item.breakdown.score > 0)
    .sort((a, b) => b.breakdown.score - a.breakdown.score)
    .slice(0, ASSET_COUNT_BY_RISK[preferences.riskProfile]);

  if (qualified.length === 0) return [];

  const totalScore = qualified.reduce((sum, item) => sum + item.breakdown.score, 0);
  const capital = preferences.totalCapital;

  return qualified.map(({ asset, breakdown, price, atr }) => {
    const { score, components, regime, rationale } = breakdown;
    const weight = score / totalScore;
    const allocatedAmount = Number((capital * weight).toFixed(2));
    // The suggested size is bounded by this asset's allocation so the risk
    // model can never recommend a notional worth more than the budget (or,
    // indirectly, more than the total capital) — M1-T2, F-1.2a.
    const sizing =
      price !== null && atr !== null && atr > 0
        ? recommendPositionSize({ capital, price, atr, allocatedCapital: allocatedAmount })
        : null;
    return {
      ticker: asset.ticker,
      weight,
      allocatedAmount,
      score,
      components,
      regime,
      rationale,
      suggestedShares: sizing ? sizing.shares : null,
    };
  });
}
