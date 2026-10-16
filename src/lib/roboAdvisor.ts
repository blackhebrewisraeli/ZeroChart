import { calculateSignalScore, type Asset } from '@/lib/assets';
import { fetchHistoricalKlines, isBinanceCrypto } from '@/lib/binance';
import { rsiAsync, smaAsync } from '@/lib/financeClient';
import {
  ASSET_COUNT_BY_RISK,
  type Allocation,
  type PortfolioPreferences,
} from '@/lib/portfolioBuilder';

export interface QuantMetrics {
  price: number;
  sma50: number | null;
  sma200: number | null;
  rsi14: number | null;
  volatility: number;
}

export interface IndicatorBundle {
  sma50: Float64Array;
  sma200: Float64Array;
  rsi14: Float64Array;
}

export interface QuantDeps {
  fetchCloses: (ticker: string) => Promise<Float64Array>;
  computeIndicators: (closes: Float64Array) => Promise<IndicatorBundle>;
}

const defaultDeps: QuantDeps = {
  fetchCloses: async (ticker) => {
    const klines = await fetchHistoricalKlines(ticker, '1d', 200);
    return Float64Array.from(klines.map((kline) => kline.close));
  },
  computeIndicators: async (closes) => {
    const values = Array.from(closes);
    const [sma50, sma200, rsi14] = await Promise.all([
      smaAsync(values, 50),
      smaAsync(values, 200),
      rsiAsync(values, 14),
    ]);
    return { sma50, sma200, rsi14 };
  },
};

/** Standard deviation of period-over-period returns (a fraction). */
export function computeVolatility(closes: Float64Array): number {
  if (closes.length < 2) return 0;

  const returns: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    const previous = closes[i - 1];
    const current = closes[i];
    if (previous === undefined || current === undefined || previous <= 0) continue;
    returns.push((current - previous) / previous);
  }
  if (returns.length === 0) return 0;

  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) / returns.length;
  return Math.sqrt(variance);
}

/**
 * Scores an asset 0-100 from trend alignment, RSI zone, and inverse volatility.
 * Higher = a larger slice of the final portfolio.
 */
export function calculateAssetScore(metrics: QuantMetrics): number {
  const { price, sma50, sma200, rsi14, volatility } = metrics;
  let score = 0;

  const validSma50 = sma50 !== null && Number.isFinite(sma50) && sma50 > 0;
  const validSma200 = sma200 !== null && Number.isFinite(sma200) && sma200 > 0;
  const aboveSma50 = validSma50 && price > sma50;
  const sma50AboveSma200 = validSma50 && validSma200 && sma50 > sma200;

  // Trend alignment (0..40).
  if (aboveSma50) score += 20;
  if (sma50AboveSma200) score += 20;

  // RSI zones.
  if (rsi14 !== null && Number.isFinite(rsi14)) {
    if (rsi14 > 70) {
      score -= 15; // overbought
    } else if (rsi14 >= 40 && rsi14 <= 60) {
      score += aboveSma50 ? 30 : 15; // healthy zone; extra reward in an uptrend
    } else if (rsi14 < 30) {
      score += 5; // oversold
    }
  }

  // Inverse volatility (0..30): erratic assets are penalized.
  if (Number.isFinite(volatility) && volatility > 0) {
    score += 30 / (1 + volatility * 100);
  }

  return Math.min(100, Math.max(0, Math.round(score)));
}

function lastFinite(series: Float64Array): number | null {
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const value = series[i];
    if (value !== undefined && Number.isFinite(value)) return value;
  }
  return null;
}

async function scoreAsset(asset: Asset, deps: QuantDeps): Promise<{ asset: Asset; score: number }> {
  if (!isBinanceCrypto(asset.ticker)) {
    // No Binance history for stocks/forex — fall back to the static signal.
    return { asset, score: calculateSignalScore(asset) };
  }

  try {
    const closes = await deps.fetchCloses(asset.ticker);
    if (closes.length < 2) return { asset, score: calculateSignalScore(asset) };

    const { sma50, sma200, rsi14 } = await deps.computeIndicators(closes);
    const lastClose = closes[closes.length - 1];
    const price =
      asset.current_price !== null &&
      Number.isFinite(asset.current_price) &&
      asset.current_price > 0
        ? asset.current_price
        : (lastClose ?? 0);

    return {
      asset,
      score: calculateAssetScore({
        price,
        sma50: lastFinite(sma50),
        sma200: lastFinite(sma200),
        rsi14: lastFinite(rsi14),
        volatility: computeVolatility(closes),
      }),
    };
  } catch {
    return { asset, score: calculateSignalScore(asset) };
  }
}

/**
 * Builds a portfolio by fetching each crypto asset's history, computing SMA/RSI
 * in the Web Worker, scoring each asset quantitatively, and allocating capital
 * proportionally to the normalized scores.
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
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, ASSET_COUNT_BY_RISK[preferences.riskProfile]);

  if (qualified.length === 0) return [];

  const totalScore = qualified.reduce((sum, item) => sum + item.score, 0);

  return qualified.map(({ asset, score }) => {
    const weight = score / totalScore;
    const allocatedAmount = Number((preferences.totalCapital * weight).toFixed(2));
    return { ticker: asset.ticker, weight, allocatedAmount };
  });
}
