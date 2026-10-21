import type { Asset } from '@/lib/assets';
import { fetchHistoricalCandles } from '@/lib/binance';
import type { CanonicalResult, EngineCandle } from '@/lib/canonicalModel';
import { evaluateCandlesAsync } from '@/lib/financeClient';
import { recommendPositionSize } from '@/lib/risk';
import {
  ASSET_COUNT_BY_RISK,
  type Allocation,
  type PortfolioPreferences,
  type RiskProfile,
} from '@/lib/portfolioBuilder';

export const RISK_PROFILE_POLICIES = {
  conservative: {
    maxAllocation: 0.1,
    excludeHighVolatility: true,
    minimumScoreExclusive: null,
    requirePositiveMomentum: false,
  },
  moderate: {
    maxAllocation: 0.25,
    excludeHighVolatility: false,
    minimumScoreExclusive: null,
    requirePositiveMomentum: false,
  },
  aggressive: {
    maxAllocation: 0.5,
    excludeHighVolatility: false,
    minimumScoreExclusive: 70,
    requirePositiveMomentum: true,
  },
} as const satisfies Record<
  RiskProfile,
  {
    maxAllocation: number;
    excludeHighVolatility: boolean;
    minimumScoreExclusive: number | null;
    requirePositiveMomentum: boolean;
  }
>;

type RiskPolicyCandidate = Pick<CanonicalResult & { status: 'OK' }, 'signal_score' | 'regime'> & {
  components: { momentumScore: number };
};

/** Hard eligibility gate for each portfolio risk profile. */
export function qualifiesForRiskProfile(
  profile: RiskProfile,
  candidate: RiskPolicyCandidate,
): boolean {
  const policy = RISK_PROFILE_POLICIES[profile];
  if (policy.excludeHighVolatility && candidate.regime === 'HIGH_VOLATILITY') return false;
  if (
    policy.minimumScoreExclusive !== null &&
    candidate.signal_score <= policy.minimumScoreExclusive
  ) {
    return false;
  }
  // The canonical momentum score is 50 at zero momentum and monotonic around it.
  if (policy.requirePositiveMomentum && candidate.components.momentumScore <= 50) return false;
  return true;
}

export interface QuantDeps {
  /** Daily OHLC candles, oldest first; `[]` when the ticker has no candle source. */
  fetchCandles: (ticker: string) => Promise<readonly EngineCandle[]>;
}

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
export async function scoreTicker(
  ticker: string,
  deps: QuantDeps = defaultDeps,
): Promise<CanonicalResult> {
  let candles: readonly EngineCandle[] = [];
  try {
    candles = await deps.fetchCandles(ticker);
  } catch {
    // Fall through: zero candles is INSUFFICIENT_DATA, never a guessed score.
  }
  return evaluateCandlesAsync(candles);
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
  },
  deps: QuantDeps = defaultDeps,
): Promise<Allocation[]> {
  const { preferences, availableAssets, excludeTickers = new Set<string>() } = options;

  const candidates = availableAssets.filter((asset) => !excludeTickers.has(asset.ticker));
  if (candidates.length === 0) return [];

  const scored = await Promise.all(
    candidates.map(async (asset) => ({
      asset,
      result: await scoreTicker(asset.ticker, deps),
    })),
  );
  const qualified = scored
    .flatMap(({ asset, result }) =>
      result.status === 'OK' &&
      result.signal_score > 0 &&
      qualifiesForRiskProfile(preferences.riskProfile, result)
        ? [{ asset, result }]
        : [],
    )
    .sort((a, b) => b.result.signal_score - a.result.signal_score)
    .slice(0, ASSET_COUNT_BY_RISK[preferences.riskProfile]);

  if (qualified.length === 0) return [];

  const totalScore = qualified.reduce((sum, item) => sum + item.result.signal_score, 0);
  const capital = preferences.totalCapital;
  const policy = RISK_PROFILE_POLICIES[preferences.riskProfile];

  return qualified.map(({ asset, result }) => {
    const { signal_score: score, components, regime, rationale, atr } = result;
    const weight = Math.min(score / totalScore, policy.maxAllocation);
    const allocatedAmount = Number((capital * weight).toFixed(2));
    // Live price when the provider has one, else the last candle close. The
    // suggested size is bounded by this asset's allocation so the risk model
    // can never recommend a notional worth more than the budget (or,
    // indirectly, more than the total capital) — M1-T2, F-1.2a.
    const price = validPrice(asset) ?? result.close;
    const sizing =
      atr > 0
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
