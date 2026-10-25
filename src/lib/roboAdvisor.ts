import type { Asset } from '@/lib/assets';
import { fetchHistoricalCandles } from '@/lib/binance';
import type { CanonicalResult, EngineCandle } from '@/lib/canonicalModel';
import { evaluateCandlesAsync } from '@/lib/financeClient';
import { recommendPositionSize } from '@/lib/risk';
import {
  allocateScoreCandidates,
  qualifiesForRiskProfile,
  RISK_PROFILE_POLICIES,
  selectPortfolioCandidates,
  type Allocation,
  type PortfolioPreferences,
  type RiskProfile,
} from '@/lib/portfolioBuilder';
export { qualifiesForRiskProfile, RISK_PROFILE_POLICIES } from '@/lib/portfolioBuilder';

export interface QuantDeps {
  /** Daily OHLC candles, oldest first; `[]` when the ticker has no candle source. */
  fetchCandles: (ticker: string) => Promise<readonly EngineCandle[]>;
}

export interface PortfolioBuildDiagnostics {
  totalCandidates: number;
  eligible: number;
  insufficientData: number;
  networkFailures: number;
  belowMinimumScore: number;
  highVolatility: number;
  nonPositiveMomentum: number;
}

type ScoreAttempt = { result: CanonicalResult; networkFailed: boolean };

/**
 * 200 daily candles from Binance: well past MIN_CANDLES, and long enough for
 * the Wilder/EMA smoothers to converge on TradingView's full-history values.
 * Stocks and forex have no candle source yet and resolve to `[]`.
 */
const defaultDeps: QuantDeps = {
  fetchCandles: (ticker) => fetchHistoricalCandles(ticker, '1d', 200),
};

/**
 * The canonical engine result for one ticker: its candles, scored in the
 * finance Web Worker. Never rejects — a failed fetch simply has no candles.
 */
async function scoreTickerAttempt(
  ticker: string,
  deps: QuantDeps = defaultDeps,
): Promise<ScoreAttempt> {
  try {
    const candles = await deps.fetchCandles(ticker);
    return { result: await evaluateCandlesAsync(candles), networkFailed: false };
  } catch {
    return { result: await evaluateCandlesAsync([]), networkFailed: true };
  }
}

export async function scoreTicker(
  ticker: string,
  deps: QuantDeps = defaultDeps,
): Promise<CanonicalResult> {
  return (await scoreTickerAttempt(ticker, deps)).result;
}

/** A valid positive live price for the asset, if the provider gave us one. */
function validPrice(asset: Asset): number | null {
  const price = asset.current_price;
  if (price !== null && Number.isFinite(price) && price > 0) return price;
  return null;
}

/**
 * Builds a portfolio from the canonical engine: every candidate is scored on
 * its own candle history, assets the engine reports as INSUFFICIENT_DATA are
 * skipped (never scored from proxies), capital is allocated proportionally to
 * the remaining scores, and each holding gets an ATR-based suggested position
 * size that risks exactly 2% of the requested capital.
 */
export async function buildQuantPortfolio(
  options: {
    preferences: PortfolioPreferences;
    availableAssets: Asset[];
    excludeTickers?: ReadonlySet<string>;
    /** Reports why candidates were skipped without changing allocation rules. */
    onDiagnostics?: (diagnostics: PortfolioBuildDiagnostics) => void;
  },
  deps: QuantDeps = defaultDeps,
): Promise<Allocation[]> {
  const {
    preferences,
    availableAssets,
    excludeTickers = new Set<string>(),
    onDiagnostics,
  } = options;

  const candidates = availableAssets.filter((asset) => !excludeTickers.has(asset.ticker));
  const diagnostics: PortfolioBuildDiagnostics = {
    totalCandidates: candidates.length,
    eligible: 0,
    insufficientData: 0,
    networkFailures: 0,
    belowMinimumScore: 0,
    highVolatility: 0,
    nonPositiveMomentum: 0,
  };
  if (candidates.length === 0) {
    onDiagnostics?.(diagnostics);
    return [];
  }

  const scored = await Promise.all(
    candidates.map(async (asset) => ({
      asset,
      ...(await scoreTickerAttempt(asset.ticker, deps)),
    })),
  );
  const policy = RISK_PROFILE_POLICIES[preferences.riskProfile];
  const qualified = scored.flatMap(({ asset, result, networkFailed }) => {
    if (networkFailed) {
      diagnostics.networkFailures += 1;
      return [];
    }
    if (result.status !== 'OK') {
      diagnostics.insufficientData += 1;
      return [];
    }
    if (policy.excludeHighVolatility && result.regime === 'HIGH_VOLATILITY') {
      diagnostics.highVolatility += 1;
      return [];
    }
    if (result.signal_score < policy.minimumScore) {
      diagnostics.belowMinimumScore += 1;
      return [];
    }
    if (policy.requirePositiveMomentum && result.components.momentumScore <= 50) {
      diagnostics.nonPositiveMomentum += 1;
      return [];
    }
    diagnostics.eligible += 1;
    return [{ asset, result }];
  });
  const selected = selectPortfolioCandidates(
    qualified.map(({ asset, result }) => ({
      ticker: asset.ticker,
      score: result.signal_score,
      asset,
      result,
    })),
    preferences.riskProfile,
  );

  onDiagnostics?.(diagnostics);

  if (selected.length === 0) return [];

  const allocations = new Map(
    allocateScoreCandidates(
      selected.map(({ ticker, score }) => ({ ticker, score })),
      preferences.riskProfile,
      preferences.totalCapital,
    ).map((allocation) => [allocation.ticker, allocation]),
  );
  return selected.map(({ asset, result }) => {
    const { signal_score: score, components, regime, rationale, atr } = result;
    const allocation = allocations.get(asset.ticker);
    if (!allocation) throw new Error(`Missing allocation for selected asset ${asset.ticker}`);
    const { weight, allocatedAmount } = allocation;
    // Live price when the provider has one, else the last candle close. The
    // suggested size is bounded by this asset's allocation so the risk model
    // can never recommend a notional worth more than the budget (or,
    // indirectly, more than the total capital) — M1-T2, F-1.2a.
    const price = validPrice(asset) ?? result.close;
    const sizing =
      atr > 0
        ? recommendPositionSize({
            capital: preferences.totalCapital,
            price,
            atr,
            allocatedCapital: allocatedAmount,
          })
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
