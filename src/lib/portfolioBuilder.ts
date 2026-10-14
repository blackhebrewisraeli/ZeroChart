import { calculateSignalScore, type Asset } from '@/lib/assets';

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

const ASSET_COUNT_BY_RISK: Record<RiskProfile, number> = {
  conservative: 8,
  moderate: 5,
  aggressive: 3,
};

/**
 * Builds an equal-weight portfolio from the strongest available signals.
 * Assets are ranked by Signal Score, filtered to those scoring 70 or higher,
 * and spread across a risk-dependent number of holdings.
 */
export function generatePortfolio(
  preferences: PortfolioPreferences,
  availableAssets: Asset[],
): Allocation[] {
  const targetCount = ASSET_COUNT_BY_RISK[preferences.riskProfile];
  const selected = availableAssets
    .map((asset) => ({ asset, score: calculateSignalScore(asset) }))
    .filter((item) => item.score >= 70)
    .sort((a, b) => b.score - a.score)
    .slice(0, targetCount);

  if (selected.length === 0) return [];

  const weight = 1 / selected.length;
  const allocatedAmount = Number((preferences.totalCapital * weight).toFixed(2));

  return selected.map(({ asset }) => ({
    ticker: asset.ticker,
    weight,
    allocatedAmount,
  }));
}
