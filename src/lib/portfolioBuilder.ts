import type { CanonicalResult, CanonicalScore } from '@/lib/canonicalModel';

export type RiskProfile = 'conservative' | 'moderate' | 'aggressive';

export interface PortfolioPreferences {
  totalCapital: number;
  riskProfile: RiskProfile;
}

export interface Allocation {
  ticker: string;
  weight: number;
  allocatedAmount: number;
  /** Canonical Signal Score (0–100: RSI · MACD · ATR) used to rank the holding. */
  score?: number;
  /**
   * ATR-based share quantity that risks up to 2% of total capital on a
   * 2×ATR(14) stop, capped so the notional never exceeds this asset's
   * allocated amount; `null` when the asset has no usable price/ATR data.
   */
  suggestedShares?: number | null;
  /** Factor sub-scores (0–100) and the regime-tilted weights applied to them. */
  components?: CanonicalScore['components'];
  /** Market regime detected from the factor inputs. */
  regime?: CanonicalScore['regime'];
  /** One-line quant thesis explaining the score. */
  rationale?: string;
}

/** Number of holdings per risk profile. */
export const ASSET_COUNT_BY_RISK: Record<RiskProfile, number> = {
  conservative: 8,
  moderate: 5,
  aggressive: 3,
};

export const RISK_PROFILE_POLICIES = {
  conservative: {
    maxAllocation: 0.1,
    excludeHighVolatility: true,
    minimumScore: 60,
    requirePositiveMomentum: false,
  },
  moderate: {
    maxAllocation: 0.25,
    excludeHighVolatility: false,
    minimumScore: 60,
    requirePositiveMomentum: false,
  },
  aggressive: {
    maxAllocation: 0.5,
    excludeHighVolatility: false,
    minimumScore: 71,
    requirePositiveMomentum: true,
  },
} as const satisfies Record<
  RiskProfile,
  {
    maxAllocation: number;
    excludeHighVolatility: boolean;
    minimumScore: number;
    requirePositiveMomentum: boolean;
  }
>;

type RiskPolicyCandidate = Pick<CanonicalResult & { status: 'OK' }, 'signal_score' | 'regime'> & {
  components: { momentumScore: number };
};

export function qualifiesForRiskProfile(
  profile: RiskProfile,
  candidate: RiskPolicyCandidate,
): boolean {
  const policy = RISK_PROFILE_POLICIES[profile];
  if (policy.excludeHighVolatility && candidate.regime === 'HIGH_VOLATILITY') return false;
  if (candidate.signal_score < policy.minimumScore) return false;
  if (policy.requirePositiveMomentum && candidate.components.momentumScore <= 50) return false;
  return true;
}

export interface ScoreCandidate {
  ticker: string;
  score: number;
}

export interface ScoreAllocation {
  ticker: string;
  score: number;
  weight: number;
  allocatedAmount: number;
}

export function selectPortfolioCandidates<T extends ScoreCandidate>(
  candidates: readonly T[],
  profile: RiskProfile,
  maxHoldings = ASSET_COUNT_BY_RISK[profile],
): T[] {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort(
      (a, b) =>
        b.candidate.score - a.candidate.score ||
        a.candidate.ticker.localeCompare(b.candidate.ticker) ||
        a.index - b.index,
    )
    .slice(0, maxHoldings)
    .map(({ candidate }) => candidate);
}

export function allocateScoreCandidates(
  candidates: readonly ScoreCandidate[],
  profile: RiskProfile,
  totalCapital: number,
  maxAllocation: number = RISK_PROFILE_POLICIES[profile].maxAllocation,
): ScoreAllocation[] {
  const totalScore = candidates.reduce((sum, candidate) => sum + candidate.score, 0);
  if (totalScore <= 0) return [];
  return candidates.map((candidate) => {
    const weight = Math.min(candidate.score / totalScore, maxAllocation);
    return {
      ...candidate,
      weight,
      allocatedAmount: Number((totalCapital * weight).toFixed(2)),
    };
  });
}
