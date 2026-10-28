import type { Asset } from '@/lib/assets';
import { CandleProviderDataError, fetchHistoricalCandles, type Candle } from '@/lib/binance';
import {
  CANONICAL_MODEL_VERSION,
  type CanonicalResult,
  type EngineCandle,
} from '@/lib/canonicalModel';
import {
  BINANCE_DAILY_CANDLE_POLICY_VERSION,
  validateBinanceDailyCandles,
} from '@/lib/candleValidation';
import { evaluateCandlesAsync } from '@/lib/financeClient';
import { scanInstrument, UNSUPPORTED_DETAIL } from '@/lib/marketScanner';
import { recommendPositionSize } from '@/lib/risk';
import {
  allocateScoreCandidates,
  RISK_PROFILE_POLICIES,
  selectPortfolioCandidates,
  type Allocation,
  type PortfolioPreferences,
} from '@/lib/portfolioBuilder';
import { classifyTicker } from '@/lib/ticker';
export { qualifiesForRiskProfile, RISK_PROFILE_POLICIES } from '@/lib/portfolioBuilder';

export interface QuantDeps {
  /** Daily OHLC candles, oldest first; null when the ticker has no candle source. */
  fetchCandles: (ticker: string) => Promise<readonly (EngineCandle | Candle)[] | null>;
}

export interface PortfolioBuildDiagnostics {
  totalCandidates: number;
  eligible: number;
  insufficientData: number;
  dataFailures: number;
  staleData: number;
  networkFailures: number;
  /** No validated candle source for the asset class (the Markets scan's "Not scanned"). */
  unsupported: number;
  belowMinimumScore: number;
  highVolatility: number;
  nonPositiveMomentum: number;
}

/**
 * 200 daily candles from Binance: well past MIN_CANDLES. The smoothers come
 * close to TradingView's full-history values but never match them exactly
 * (docs/PINE_PARITY_ASSESSMENT.md).
 * Only what the Markets scan scores has a source (`scanInstrument`): stocks
 * and forex resolve to null and are never fetched.
 */
const defaultDeps: QuantDeps = {
  fetchCandles: async (ticker) =>
    scanInstrument(ticker) === null ? null : fetchHistoricalCandles(ticker, '1d', 200),
};

/**
 * The canonical engine result for one ticker: its candles, scored in the
 * finance Web Worker. Never rejects — an unsupported asset class or a failed
 * fetch is its own status, never a short history.
 */
export async function scoreTicker(
  ticker: string,
  deps: QuantDeps = defaultDeps,
): Promise<CanonicalResult> {
  try {
    const candles = await deps.fetchCandles(ticker);
    if (candles === null) {
      return {
        status: 'UNSUPPORTED',
        version: CANONICAL_MODEL_VERSION,
        detail: UNSUPPORTED_DETAIL[classifyTicker(ticker)],
      };
    }
    const timestamped = candles.every(
      (candle): candle is Candle => 'timestamp' in candle && 'closeTime' in candle,
    );
    if (timestamped) {
      const validation = validateBinanceDailyCandles(candles, {
        evaluationTime: Date.now(),
        maxDataAgeMs: 48 * 60 * 60 * 1000,
        modelWindow: 200,
      });
      if (!validation.structurallyValid) {
        return {
          status: 'DATA_INVALID',
          version: CANONICAL_MODEL_VERSION,
          validationPolicyVersion: BINANCE_DAILY_CANDLE_POLICY_VERSION,
          issues: validation.issues,
        };
      }
      if (validation.fresh === false) {
        return {
          status: 'STALE_DATA',
          version: CANONICAL_MODEL_VERSION,
          validationPolicyVersion: BINANCE_DAILY_CANDLE_POLICY_VERSION,
          latestCloseTime: validation.latestCloseTime,
        };
      }
      return await evaluateCandlesAsync(validation.closed);
    }
    return await evaluateCandlesAsync(candles);
  } catch (error) {
    if (error instanceof CandleProviderDataError) {
      return {
        status: 'DATA_INVALID',
        version: CANONICAL_MODEL_VERSION,
        validationPolicyVersion: BINANCE_DAILY_CANDLE_POLICY_VERSION,
        issues: [
          {
            code: 'MALFORMED_PROVIDER_ROW',
            index: -1,
            timestamp: null,
            detail: error.message,
          },
        ],
      };
    }
    return {
      status: 'FETCH_FAILED',
      version: CANONICAL_MODEL_VERSION,
      detail: error instanceof Error ? error.message : 'Unknown market-data error',
    };
  }
}

/** A valid positive live price for the asset, if the provider gave us one. */
function validPrice(asset: Asset): number | null {
  const price = asset.current_price;
  if (price !== null && Number.isFinite(price) && price > 0) return price;
  return null;
}

/**
 * Builds a portfolio from the canonical engine: every candidate is scored on
 * its own candle history, assets without a score (unsupported asset class,
 * failed fetch, invalid, stale or short history) are skipped and counted in
 * the diagnostics (never scored from proxies), capital is allocated proportionally to
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
    dataFailures: 0,
    staleData: 0,
    networkFailures: 0,
    unsupported: 0,
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
      result: await scoreTicker(asset.ticker, deps),
    })),
  );
  const policy = RISK_PROFILE_POLICIES[preferences.riskProfile];
  const qualified = scored.flatMap(({ asset, result }) => {
    if (result.status !== 'OK') {
      if (result.status === 'FETCH_FAILED') diagnostics.networkFailures += 1;
      else if (result.status === 'UNSUPPORTED') diagnostics.unsupported += 1;
      else if (result.status === 'DATA_INVALID') diagnostics.dataFailures += 1;
      else if (result.status === 'STALE_DATA') diagnostics.staleData += 1;
      else diagnostics.insufficientData += 1;
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
