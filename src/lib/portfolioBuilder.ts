export type RiskProfile = 'conservative' | 'moderate' | 'aggressive';

export interface PortfolioPreferences {
  totalCapital: number;
  riskProfile: RiskProfile;
}

export interface Allocation {
  ticker: string;
  weight: number;
  allocatedAmount: number;
  /** Multi-Factor Signal Score (0–100: RSI · MACD · ATR) used to rank the holding. */
  score?: number;
  /**
   * ATR-based share quantity that risks exactly 2% of total capital on a
   * 1×ATR(14) stop; `null` when the asset has no usable price/ATR data.
   */
  suggestedShares?: number | null;
}

/** Number of holdings per risk profile. */
export const ASSET_COUNT_BY_RISK: Record<RiskProfile, number> = {
  conservative: 8,
  moderate: 5,
  aggressive: 3,
};
