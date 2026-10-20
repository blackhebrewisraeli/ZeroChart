import type { CanonicalScore } from '@/lib/canonicalModel';

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
   * 1×ATR(14) stop, capped so the notional never exceeds this asset's
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
