import { describe, expect, it } from 'vitest';
import { computeBacktest, deriveWeights } from '@/lib/backtestManager';
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

describe('deriveWeights', () => {
  it('computes market-value weights using live prices with buy-price fallback', () => {
    const positions = [
      makePosition({ id: 'a', ticker: 'A', buyPrice: 100, shares: 1 }),
      makePosition({ id: 'b', ticker: 'B', buyPrice: 100, shares: 1 }),
    ];
    const assets = [makeAsset('A', 200)];

    expect(deriveWeights(positions, assets)).toEqual([
      { ticker: 'A', weight: 2 / 3 },
      { ticker: 'B', weight: 1 / 3 },
    ]);
  });

  it('aggregates multiple lots of the same ticker', () => {
    const positions = [
      makePosition({ id: 'a1', ticker: 'A', buyPrice: 100, shares: 1 }),
      makePosition({ id: 'a2', ticker: 'A', buyPrice: 100, shares: 1 }),
      makePosition({ id: 'b', ticker: 'B', buyPrice: 100, shares: 1 }),
    ];
    const assets = [makeAsset('A', 200), makeAsset('B', 100)];

    expect(deriveWeights(positions, assets)).toEqual([
      { ticker: 'A', weight: 0.8 },
      { ticker: 'B', weight: 0.2 },
    ]);
  });

  it('returns an empty allocation when nothing has value', () => {
    expect(deriveWeights([], [])).toEqual([]);
  });
});

describe('computeBacktest', () => {
  it('compounds a two-asset portfolio day-by-day and reports the return', () => {
    const result = computeBacktest({
      weights: [
        { ticker: 'A', weight: 0.5 },
        { ticker: 'B', weight: 0.5 },
      ],
      series: [
        {
          ticker: 'A',
          points: [
            { timestamp: 0, price: 10 },
            { timestamp: 1, price: 20 },
          ],
        },
        {
          ticker: 'B',
          points: [
            { timestamp: 0, price: 10 },
            { timestamp: 1, price: 10 },
          ],
        },
      ],
    });

    expect(result.initialValue).toBe(10000);
    expect(result.points.map((point) => point.value)).toEqual([10000, 15000]);
    expect(result.finalValue).toBeCloseTo(15000, 5);
    expect(result.totalReturnPercent).toBeCloseTo(50, 5);
  });

  it('forward-fills missing days and aligns a shared timeline', () => {
    const result = computeBacktest({
      weights: [
        { ticker: 'A', weight: 0.5 },
        { ticker: 'B', weight: 0.5 },
      ],
      series: [
        {
          ticker: 'A',
          points: [
            { timestamp: 0, price: 10 },
            { timestamp: 2, price: 20 },
          ],
        },
        {
          ticker: 'B',
          points: [
            { timestamp: 1, price: 5 },
            { timestamp: 2, price: 10 },
          ],
        },
      ],
    });

    expect(result.points.map((point) => point.timestamp)).toEqual([0, 1, 2]);
    expect(result.points.map((point) => point.value)).toEqual([10000, 10000, 20000]);
    expect(result.totalReturnPercent).toBeCloseTo(100, 5);
  });

  it('holds assets without historical data flat and treats leftover weight as cash', () => {
    const result = computeBacktest({
      weights: [{ ticker: 'A', weight: 0.5 }],
      series: [
        {
          ticker: 'A',
          points: [
            { timestamp: 0, price: 100 },
            { timestamp: 1, price: 200 },
          ],
        },
      ],
    });

    // 50% of the portfolio doubles; the remaining 50% is unallocated cash.
    expect(result.points.map((point) => point.value)).toEqual([10000, 15000]);
    expect(result.totalReturnPercent).toBeCloseTo(50, 5);
  });

  it('returns a flat 0% result when there is no historical data', () => {
    const result = computeBacktest({
      weights: [{ ticker: 'A', weight: 1 }],
      series: [],
    });

    expect(result.points).toEqual([]);
    expect(result.finalValue).toBe(10000);
    expect(result.totalReturnPercent).toBe(0);
  });
});
