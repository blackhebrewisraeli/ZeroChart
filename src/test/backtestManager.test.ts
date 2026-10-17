import { describe, expect, it } from 'vitest';
import { computeBacktest, deriveWeights, type PricePoint } from '@/lib/backtestManager';
import { computeFinance } from '@/lib/financeCompute';
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

  it('treats unallocated weight as cash and reports full coverage of traded tickers', () => {
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
    // Unallocated cash is a user choice, not a data gap — no missing coverage.
    expect(result.coverageWeight).toBeCloseTo(0.5, 10);
    expect(result.coverage).toEqual([{ ticker: 'A', weight: 0.5, status: 'covered' }]);
  });

  it('flags weighted tickers without history as missing and holds their weight as cash (F-2.1a/b)', () => {
    const result = computeBacktest({
      weights: [
        { ticker: 'A', weight: 0.5 },
        { ticker: 'MISSING', weight: 0.5 },
      ],
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

    // The curve is numerically identical to the old silent-flat treatment…
    expect(result.points.map((point) => point.value)).toEqual([10000, 15000]);
    // …but the data gap is explicit, never silent.
    expect(result.coverageWeight).toBeCloseTo(0.5, 10);
    expect(result.coverage).toEqual([
      { ticker: 'A', weight: 0.5, status: 'covered' },
      { ticker: 'MISSING', weight: 0.5, status: 'missing' },
    ]);
  });

  it('returns a flat 0% result when there is no historical data', () => {
    const result = computeBacktest({
      weights: [{ ticker: 'A', weight: 1 }],
      series: [],
    });

    expect(result.points).toEqual([]);
    expect(result.finalValue).toBe(10000);
    expect(result.totalReturnPercent).toBe(0);
    expect(result.maxDrawdownPercent).toBe(0);
    expect(result.sharpeRatio).toBe(0);
    // Full data gap, fully flagged.
    expect(result.coverageWeight).toBe(0);
    expect(result.coverage).toEqual([{ ticker: 'A', weight: 1, status: 'missing' }]);
    // No trades, no benchmark, no alpha.
    expect(result.benchmarkCurve).toEqual([]);
    expect(result.benchmarkReturnPct).toBe(0);
    expect(result.alphaPct).toBe(0);
    expect(result.totalTrades).toBe(0);
    expect(result.winRatePct).toBe(0);
  });

  it('applies the entry-cost model as a one-time drag on invested capital (F-2.1c)', () => {
    const series = [
      {
        ticker: 'A',
        points: [
          { timestamp: 0, price: 100 },
          { timestamp: 1, price: 100 }, // flat market
        ],
      },
    ];
    const weights = [{ ticker: 'A', weight: 1 }];

    const gross = computeBacktest({ weights, series });
    const net = computeBacktest({
      weights,
      series,
      costModel: { feeRate: 0.0025, slippageRate: 0.001 },
    });

    // Flat market: gross ends at 10,000 (0%); net pays 35 bps on entry.
    expect(gross.finalValue).toBe(10000);
    expect(net.points[0]?.value).toBeCloseTo(9965, 6);
    expect(net.finalValue).toBeCloseTo(9965, 6);
    expect(net.totalReturnPercent).toBeCloseTo(-0.35, 6);

    // Invalid rates are ignored (treated as zero).
    const ignored = computeBacktest({
      weights,
      series,
      costModel: { feeRate: -1, slippageRate: Number.NaN },
    });
    expect(ignored.finalValue).toBe(gross.finalValue);
  });

  it('a zero-cost model reproduces the gross curve exactly', () => {
    const weights = [
      { ticker: 'A', weight: 0.6 },
      { ticker: 'B', weight: 0.4 },
    ];
    const series = [
      {
        ticker: 'A',
        points: [
          { timestamp: 0, price: 100 },
          { timestamp: 1, price: 150 },
        ],
      },
      {
        ticker: 'B',
        points: [
          { timestamp: 0, price: 50 },
          { timestamp: 1, price: 50 },
        ],
      },
    ];

    const gross = computeBacktest({ weights, series });
    const zero = computeBacktest({
      weights,
      series,
      costModel: { feeRate: 0, slippageRate: 0 },
    });

    expect(zero.points).toEqual(gross.points);
    expect(zero.finalValue).toBe(gross.finalValue);
    expect(zero.totalReturnPercent).toBe(gross.totalReturnPercent);
  });

  it('reports max drawdown and an annualized Sharpe ratio for the equity curve', () => {
    const result = computeBacktest({
      weights: [{ ticker: 'A', weight: 1 }],
      series: [
        {
          ticker: 'A',
          points: [
            { timestamp: 0, price: 100 },
            { timestamp: 1, price: 120 },
            { timestamp: 2, price: 60 },
            { timestamp: 3, price: 90 },
          ],
        },
      ],
    });

    // Equity 10000 → 12000 → 6000 → 9000: peak 12000, trough 6000 → −50%.
    expect(result.maxDrawdownPercent).toBeCloseTo(50, 5);
    // Returns +20%, −50%, +50% → mean 6.67%, σ 41.9%, annualized ≈ 3.04.
    expect(result.sharpeRatio).toBeCloseTo(3.04, 2);
  });
});

const closes = (prices: number[]): PricePoint[] =>
  prices.map((price, timestamp) => ({ timestamp, price }));

describe('computeBacktest friction, trailing stops and benchmark alpha', () => {
  it('charges fee + slippage bps on entry and on the final liquidation', () => {
    const series = [{ ticker: 'A', points: closes([100, 100]) }];
    const weights = [{ ticker: 'A', weight: 1 }];

    const net = computeBacktest({ weights, series, feeBps: 10, slippageBps: 5 });

    // 15 bps in, 15 bps out on a flat market; the curve is marked at liquidation value.
    const expected = 10000 * 0.9985 * 0.9985;
    expect(net.points.map((point) => point.value)).toEqual([expected, expected]);
    expect(net.finalValue).toBeCloseTo(9970.0225, 6);
    expect(net.totalReturnPercent).toBeCloseTo(-0.299775, 6);
    // Benchmark pays the same friction, so buy-and-hold alpha is zero.
    expect(net.benchmarkReturnPct).toBeCloseTo(net.totalReturnPercent, 10);
    expect(net.alphaPct).toBeCloseTo(0, 10);
    // One round trip that lost money to costs.
    expect(net.totalTrades).toBe(1);
    expect(net.winRatePct).toBe(0);

    // Omitted (legacy) or invalid bps are frictionless.
    const gross = computeBacktest({ weights, series });
    const invalid = computeBacktest({ weights, series, feeBps: -10, slippageBps: Number.NaN });
    expect(gross.finalValue).toBe(10000);
    expect(invalid.finalValue).toBe(10000);
  });

  it('exits on a percent trailing stop, re-enters on recovery, and scores each round trip', () => {
    const result = computeBacktest({
      weights: [{ ticker: 'A', weight: 1 }],
      series: [{ ticker: 'A', points: closes([100, 120, 110, 100, 106, 95]) }],
      trailingStopPct: 5,
    });

    // 120 peak → stop 114 → out at 110 (win). Trough 100 → back in above 105 at
    // 106. Peak 106 → stop 100.7 → out at 95 (loss). Flat into the close.
    const values = result.points.map((point) => point.value);
    const expected = [10000, 12000, 11000, 11000, 11000, (11000 / 106) * 95];
    expected.forEach((value, index) => expect(values[index]).toBeCloseTo(value, 6));

    expect(result.totalTrades).toBe(2);
    expect(result.winRatePct).toBe(50);
    // Buy-and-hold rides the same closes: 100 → 95.
    expect(result.benchmarkCurve.map((point) => point.value)).toEqual([
      10000, 12000, 11000, 10000, 10600, 9500,
    ]);
    expect(result.benchmarkReturnPct).toBeCloseTo(-5, 10);
    expect(result.totalReturnPercent).toBeCloseTo(((11000 / 106) * 95) / 100 - 100, 6);
    expect(result.alphaPct).toBeCloseTo(result.totalReturnPercent + 5, 10);
  });

  it('charges friction on stop exits as well as entries', () => {
    const result = computeBacktest({
      weights: [{ ticker: 'A', weight: 1 }],
      series: [{ ticker: 'A', points: closes([100, 120, 110, 100]) }],
      trailingStopPct: 5,
      feeBps: 10,
      slippageBps: 5,
    });

    // Bought at 100 net of 15 bps, sold at 110 net of 15 bps, then held as cash.
    expect(result.finalValue).toBeCloseTo(10000 * 0.9985 * 1.1 * 0.9985, 6);
    expect(result.totalTrades).toBe(1);
    expect(result.winRatePct).toBe(100);
    // Hold pays the same entry/exit friction on 100 → 100.
    expect(result.benchmarkReturnPct).toBeCloseTo((0.9985 * 0.9985 - 1) * 100, 6);
  });

  it('sizes the stop off ATR(14) when HLC is provided, else falls back to the percent stop', () => {
    const prices = [...Array<number>(14).fill(100), 97, 95.5, 90];
    const withHlc = prices.map((price, timestamp) => ({
      timestamp,
      price,
      high: price + 1,
      low: price - 1,
    }));
    const weights = [{ ticker: 'A', weight: 1 }];

    // ATR seeds at 2, then widens: by the 95.5 close the 2×ATR stop sits at
    // ≈ 95.66 and fires — a 5% stop (95) would not.
    const atrRun = computeBacktest({
      weights,
      series: [{ ticker: 'A', points: withHlc }],
      trailingStopAtrMultiplier: 2,
    });
    expect(atrRun.finalValue).toBeCloseTo(9550, 6);
    expect(atrRun.totalTrades).toBe(1);
    expect(atrRun.benchmarkReturnPct).toBeCloseTo(-10, 10);
    expect(atrRun.alphaPct).toBeCloseTo(5.5, 6);

    // Same closes without high/low: the 5% fallback only trips at 90.
    const fallback = computeBacktest({
      weights,
      series: [{ ticker: 'A', points: closes(prices) }],
      trailingStopAtrMultiplier: 2,
    });
    expect(fallback.finalValue).toBeCloseTo(9000, 6);
    expect(fallback.alphaPct).toBeCloseTo(0, 10);
  });

  it('without a stop the strategy is buy-and-hold: zero alpha and per-sleeve win rate', () => {
    const result = computeBacktest({
      weights: [
        { ticker: 'A', weight: 0.5 },
        { ticker: 'B', weight: 0.5 },
      ],
      series: [
        { ticker: 'A', points: closes([100, 120]) },
        { ticker: 'B', points: closes([100, 90]) },
      ],
      trailingStopPct: 0, // non-positive = disabled
    });

    expect(result.benchmarkCurve).toEqual(result.points);
    expect(result.benchmarkCurve.map((point) => point.timestamp)).toEqual([0, 1]);
    expect(result.benchmarkReturnPct).toBeCloseTo(5, 10);
    expect(result.alphaPct).toBe(0);
    // A won, B lost: each sleeve is one round trip closed at the end.
    expect(result.totalTrades).toBe(2);
    expect(result.winRatePct).toBe(50);
  });

  it('passes friction and stop options through the worker dispatcher unchanged', () => {
    const options = {
      weights: [{ ticker: 'A', weight: 1 }],
      series: [{ ticker: 'A', points: closes([100, 120, 110, 100]) }],
      feeBps: 10,
      slippageBps: 5,
      trailingStopPct: 5,
    };

    expect(computeFinance({ kind: 'backtest', ...options })).toEqual(computeBacktest(options));
  });
});
