import { describe, expect, it } from 'vitest';
import { generatePortfolio, type PortfolioPreferences } from '@/lib/portfolioBuilder';
import type { Asset } from '@/lib/assets';

function makeAsset(ticker: string, rewardPct: number, riskPct: number): Asset {
  return {
    ticker,
    name: null,
    current_price: 100,
    sma_50: 90,
    sma_200: null,
    stable_signal: null,
    radar_signal: null,
    stable_explanation: null,
    radar_explanation: null,
    risk_pct: riskPct,
    reward_pct: rewardPct,
    volume_spike: null,
    rsi_14: null,
    updated_at: null,
  };
}

describe('portfolio builder', () => {
  it('ranks by signal score and equal-weights the selected assets', () => {
    const assets = [
      makeAsset('LOW', 0.05, 0.05), // ratio 1 -> score 50
      makeAsset('MID', 0.1, 0.05), // ratio 2 -> score 70
      makeAsset('HIGH', 0.15, 0.05), // ratio 3 -> score 90
      makeAsset('TOP', 0.2, 0.05), // ratio 4 -> score 100 (capped)
    ];
    const prefs: PortfolioPreferences = { totalCapital: 30000, riskProfile: 'aggressive' };
    const result = generatePortfolio(prefs, assets);

    expect(result).toHaveLength(3);
    expect(result.map((a) => a.ticker)).toEqual(['TOP', 'HIGH', 'MID']);
    for (const allocation of result) {
      expect(allocation.weight).toBeCloseTo(1 / 3, 5);
      expect(allocation.allocatedAmount).toBeCloseTo(10000, 2);
    }
  });

  it('filters out assets below the 70-point threshold', () => {
    const assets = [
      makeAsset('A', 0.15, 0.05), // 90
      makeAsset('B', 0.1, 0.05), // 70
      makeAsset('C', 0.05, 0.05), // 50 (filtered)
      makeAsset('D', 0.05, 0.05), // 50 (filtered)
    ];
    const result = generatePortfolio({ totalCapital: 20000, riskProfile: 'aggressive' }, assets);
    expect(result.map((a) => a.ticker)).toEqual(['A', 'B']);
  });

  it('spreads across more assets for conservative profiles', () => {
    const assets = Array.from({ length: 10 }, (_, i) => makeAsset(`T${i}`, 0.2, 0.05)); // all score 100
    const conservative = generatePortfolio({ totalCapital: 80000, riskProfile: 'conservative' }, assets);
    expect(conservative).toHaveLength(8);

    const moderate = generatePortfolio({ totalCapital: 80000, riskProfile: 'moderate' }, assets);
    expect(moderate).toHaveLength(5);
  });

  it('returns an empty allocation when no asset clears the threshold', () => {
    const assets = [makeAsset('WEAK', 0.05, 0.05)]; // 50
    expect(generatePortfolio({ totalCapital: 1000, riskProfile: 'aggressive' }, assets)).toEqual([]);
  });
});
