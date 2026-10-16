export type RiskProfile = 'conservative' | 'moderate' | 'aggressive';

export interface PortfolioPreferences {
  totalCapital: number;
  riskProfile: RiskProfile;
}

export interface Allocation {
  ticker: string;
  weight: number;
  allocatedAmount: number;
}

/** Number of holdings per risk profile. */
export const ASSET_COUNT_BY_RISK: Record<RiskProfile, number> = {
  conservative: 8,
  moderate: 5,
  aggressive: 3,
};
