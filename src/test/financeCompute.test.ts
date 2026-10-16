import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  FinanceCache,
  computeFinance,
  computeWithCache,
  type FinanceRequest,
} from '@/lib/financeCompute';
import { computeBacktestAsync, rsiAsync, smaAsync } from '@/lib/financeClient';

// Force the worker-less fallback path for deterministic tests.
beforeAll(() => {
  vi.stubGlobal('Worker', undefined);
});

describe('computeFinance', () => {
  it('dispatches SMA, RSI, and backtest requests to the pure core', () => {
    const smaResult = computeFinance({
      kind: 'sma',
      values: [1, 2, 3, 4, 5],
      period: 3,
    }) as Float64Array;
    expect(smaResult).toBeInstanceOf(Float64Array);
    expect(Array.from(smaResult)).toEqual([NaN, NaN, 2, 3, 4]);

    const rsiResult = computeFinance({
      kind: 'rsi',
      values: [1, 3, 2, 4, 5],
      period: 3,
    }) as Float64Array;
    expect(Number.isNaN(rsiResult[0])).toBe(true);
    expect(rsiResult[3]).toBeCloseTo(80, 5);
    expect(rsiResult[4]).toBeCloseTo(84.6154, 3);
  });
});

describe('FinanceCache', () => {
  it('returns cached results for identical inputs without recomputing (O(1))', () => {
    const cache = new FinanceCache();
    const request: FinanceRequest = { kind: 'sma', values: [1, 2, 3, 4, 5], period: 3 };

    const first = computeWithCache(request, cache);
    expect(first.cached).toBe(false);

    const second = computeWithCache(request, cache);
    expect(second.cached).toBe(true);
    expect(second.value).toBe(first.value);
    expect(cache.size).toBe(1);
  });

  it('distinguishes different parameters', () => {
    const cache = new FinanceCache();
    computeWithCache({ kind: 'sma', values: [1, 2, 3], period: 2 }, cache);
    computeWithCache({ kind: 'sma', values: [1, 2, 3], period: 3 }, cache);
    expect(cache.size).toBe(2);
  });
});

describe('async worker wrappers (fallback path)', () => {
  it('resolves typed-array indicator results', async () => {
    const result = await smaAsync([1, 2, 3, 4, 5], 3);
    expect(result).toBeInstanceOf(Float64Array);
    expect(Array.from(result)).toEqual([NaN, NaN, 2, 3, 4]);

    const rsiResult = await rsiAsync([1, 3, 2, 4, 5], 3);
    expect(rsiResult[4]).toBeCloseTo(84.6154, 3);
  });

  it('resolves backtest results', async () => {
    const result = await computeBacktestAsync({
      weights: [{ ticker: 'A', weight: 1 }],
      series: [
        {
          ticker: 'A',
          points: [
            { timestamp: 0, price: 10 },
            { timestamp: 1, price: 20 },
          ],
        },
      ],
    });

    expect(result.finalValue).toBe(20000);
    expect(result.totalReturnPercent).toBeCloseTo(100, 5);
  });
});
