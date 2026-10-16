import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  FinanceCache,
  computeFinance,
  computeWithCache,
  type FinanceRequest,
} from '@/lib/financeCompute';
import { atrAsync, computeBacktestAsync, macdAsync, rsiAsync, smaAsync } from '@/lib/financeClient';
import type { MacdResult } from '@/lib/indicators';

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

  it('dispatches MACD and ATR requests to the pure core', () => {
    const macdResult = computeFinance({
      kind: 'macd',
      values: [1, 2, 4, 8, 16, 32, 64, 128],
      fast: 2,
      slow: 3,
      signalPeriod: 2,
    }) as MacdResult;
    expect(macdResult.macd).toBeInstanceOf(Float64Array);
    expect(macdResult.signal).toBeInstanceOf(Float64Array);
    expect(macdResult.histogram).toBeInstanceOf(Float64Array);
    expect(macdResult.macd[2]).toBeCloseTo(0.8333333, 6);
    expect(macdResult.signal[3]).toBeCloseTo(1.0277778, 6);
    expect(macdResult.histogram[5]).toBeCloseTo(0.8297325, 6);

    const atrResult = computeFinance({
      kind: 'atr',
      highs: [10, 12, 13],
      lows: [8, 9, 11],
      closes: [9, 11, 12],
      period: 2,
    }) as Float64Array;
    expect(atrResult).toBeInstanceOf(Float64Array);
    expect(atrResult[1]).toBeCloseTo(2.5, 10);
    expect(atrResult[2]).toBeCloseTo(2.25, 10);
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

    const macdResult = await macdAsync([1, 2, 3, 4, 5, 6, 7, 8], 2, 3, 2);
    expect(macdResult.macd[2]).toBeCloseTo(0.5, 10);
    expect(macdResult.signal[3]).toBeCloseTo(0.5, 10);

    const atrResult = await atrAsync([10, 12, 13], [8, 9, 11], [9, 11, 12], 2);
    expect(atrResult[2]).toBeCloseTo(2.25, 10);
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
