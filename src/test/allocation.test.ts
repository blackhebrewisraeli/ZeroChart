import { describe, expect, it } from 'vitest';
import { ALLOCATION_PALETTE, computeAllocation } from '@/lib/allocation';
import type { Asset } from '@/lib/assets';
import type { Position } from '@/lib/portfolioManager';

function makeAsset(ticker: string, currentPrice: number | null = null): Asset {
  return {
    ticker,
    name: null,
    current_price: currentPrice,
    sma_50: null,
    sma_200: null,
    stable_signal: null,
    radar_signal: null,
    stable_explanation: null,
    radar_explanation: null,
    risk_pct: null,
    reward_pct: null,
    volume_spike: null,
    rsi_14: null,
    change_24h: null,
    updated_at: null,
  };
}

function makePosition(overrides: Partial<Position> & { id: string; ticker: string }): Position {
  return {
    id: overrides.id,
    ticker: overrides.ticker,
    buyPrice: overrides.buyPrice ?? 100,
    shares: overrides.shares ?? 1,
    isSimulation: overrides.isSimulation ?? true,
    dateAdded: overrides.dateAdded ?? '2026-01-01',
  };
}

describe('computeAllocation', () => {
  it('values each holding by current value, computes percentages, and sorts largest-first', () => {
    const positions = [
      makePosition({ id: 'a', ticker: 'A', buyPrice: 100, shares: 10 }), // 200 * 10 = 2000
      makePosition({ id: 'b', ticker: 'B', buyPrice: 50, shares: 20 }), // no live price -> 1000
    ];
    const assets = [makeAsset('A', 200)];

    const slices = computeAllocation(positions, assets);

    expect(slices.map((slice) => slice.ticker)).toEqual(['A', 'B']);
    expect(slices[0]?.value).toBe(2000);
    expect(slices[0]?.percent).toBeCloseTo((2 / 3) * 100, 5);
    expect(slices[1]?.value).toBe(1000);
    expect(slices[1]?.percent).toBeCloseTo((1 / 3) * 100, 5);
  });

  it('aggregates multiple lots of the same ticker into one slice', () => {
    const positions = [
      makePosition({ id: 'a1', ticker: 'A', buyPrice: 100, shares: 1 }),
      makePosition({ id: 'a2', ticker: 'A', buyPrice: 100, shares: 1 }),
      makePosition({ id: 'b', ticker: 'B', buyPrice: 100, shares: 1 }),
    ];

    const slices = computeAllocation(positions, []);

    expect(slices).toHaveLength(2);
    expect(slices[0]?.ticker).toBe('A');
    expect(slices[0]?.value).toBe(200);
    expect(slices[0]?.percent).toBeCloseTo((2 / 3) * 100, 5);
    expect(slices[1]?.ticker).toBe('B');
    expect(slices[1]?.percent).toBeCloseTo((1 / 3) * 100, 5);
  });

  it('assigns palette colors to the sorted slices in order', () => {
    const positions = [
      makePosition({ id: 'a', ticker: 'A', buyPrice: 100, shares: 3 }),
      makePosition({ id: 'b', ticker: 'B', buyPrice: 100, shares: 1 }),
    ];

    const slices = computeAllocation(positions, []);

    expect(slices[0]?.color).toBe(ALLOCATION_PALETTE[0]);
    expect(slices[1]?.color).toBe(ALLOCATION_PALETTE[1]);
  });

  it('returns an empty allocation when there is nothing of value', () => {
    expect(computeAllocation([], [])).toEqual([]);
  });
});
