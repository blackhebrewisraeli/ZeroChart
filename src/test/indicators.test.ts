import { describe, expect, it } from 'vitest';
import { atr, macd, rsi, sma } from '@/lib/indicators';

const toArray = (values: Float64Array) => Array.from(values);

describe('sma', () => {
  it('computes a rolling average after the warm-up period', () => {
    const result = sma([1, 2, 3, 4, 5], 3);
    expect(result).toBeInstanceOf(Float64Array);
    expect(toArray(result)).toEqual([NaN, NaN, 2, 3, 4]);
  });

  it('returns the identity series for period 1', () => {
    expect(toArray(sma([7, 8, 9], 1))).toEqual([7, 8, 9]);
  });

  it('returns all NaN when there is not enough data', () => {
    expect(toArray(sma([1, 2, 3], 5))).toEqual([NaN, NaN, NaN]);
    expect(toArray(sma([], 3))).toEqual([]);
  });
});

describe('rsi', () => {
  it('reports 100 for a strictly rising series and 0 for a falling series', () => {
    const rising = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    expect(rsi(rising, 14)[14]).toBe(100);

    const falling = [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    expect(rsi(falling, 14)[14]).toBe(0);
  });

  it('reports 50 for a flat series', () => {
    const flat = [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5];
    expect(rsi(flat, 14)[14]).toBe(50);
  });

  it('matches a hand-computed Wilder RSI value', () => {
    const result = rsi([1, 3, 2, 4, 5], 3);

    expect(Number.isNaN(result[0])).toBe(true);
    expect(Number.isNaN(result[1])).toBe(true);
    expect(Number.isNaN(result[2])).toBe(true);
    expect(result[3]).toBeCloseTo(80, 5);
    expect(result[4]).toBeCloseTo(84.6154, 3);
  });

  it('returns all NaN when there is not enough data', () => {
    expect(toArray(rsi([1, 2, 3], 14))).toEqual([NaN, NaN, NaN]);
  });
});

describe('macd', () => {
  it('stays flat at zero for a constant series after the warm-up', () => {
    const result = macd(
      Array.from({ length: 50 }, () => 100),
      12,
      26,
      9,
    );

    expect(result.macd).toBeInstanceOf(Float64Array);
    expect(Number.isNaN(result.macd[24])).toBe(true);
    expect(result.macd[25]).toBe(0);
    expect(Number.isNaN(result.signal[32])).toBe(true);
    expect(result.signal[33]).toBe(0);
    expect(result.histogram[33]).toBe(0);
    expect(result.histogram[49]).toBe(0);
  });

  it('cancels equal EMA lags into a constant line for a linear ramp', () => {
    // Both EMAs track a linear series with a constant lag, so the MACD line
    // is flat at the lag difference and the histogram stays at exactly zero.
    const result = macd([1, 2, 3, 4, 5, 6, 7, 8], 2, 3, 2);

    expect(Number.isNaN(result.macd[1])).toBe(true);
    for (let i = 2; i < 8; i += 1) expect(result.macd[i]).toBeCloseTo(0.5, 10);
    expect(Number.isNaN(result.signal[2])).toBe(true);
    expect(result.signal[3]).toBeCloseTo(0.5, 10);
    expect(result.histogram[5]).toBeCloseTo(0, 10);
    expect(result.histogram[7]).toBeCloseTo(0, 10);
  });

  it('matches hand-computed EMA values for small parameters', () => {
    // Exponential series → diverging fast/slow EMAs exercise signal smoothing.
    const result = macd([1, 2, 4, 8, 16, 32, 64, 128], 2, 3, 2);

    expect(Number.isNaN(result.macd[1])).toBe(true);
    expect(result.macd[2]).toBeCloseTo(0.8333333, 6);
    expect(result.macd[7]).toBeCloseTo(17.0769462, 6);

    expect(Number.isNaN(result.signal[2])).toBe(true);
    expect(result.signal[3]).toBeCloseTo(1.0277778, 6);
    expect(result.signal[7]).toBeCloseTo(13.6718393, 6);

    expect(result.histogram[3]).toBeCloseTo(0.1944444, 6);
    expect(result.histogram[5]).toBeCloseTo(0.8297325, 6);
    expect(result.histogram[7]).toBeCloseTo(3.4051069, 6);
  });

  it('reports positive momentum for a strictly rising series', () => {
    const rising = Array.from({ length: 60 }, (_, i) => 100 + i);
    const result = macd(rising, 12, 26, 9);
    const lastIndex = rising.length - 1;

    expect(result.macd[lastIndex]).toBeGreaterThan(0);
    expect(Number.isFinite(result.histogram[lastIndex]!)).toBe(true);
  });

  it('returns all NaN when there is not enough data', () => {
    const result = macd([1, 2, 3], 12, 26, 9);
    expect(toArray(result.macd)).toEqual([NaN, NaN, NaN]);
    expect(toArray(result.signal)).toEqual([NaN, NaN, NaN]);
    expect(toArray(result.histogram)).toEqual([NaN, NaN, NaN]);
  });
});

describe('atr', () => {
  it('matches a hand-computed Wilder ATR value', () => {
    // TR = [2, 3, 2] → ATR(2) seeds at index 1 with 2.5, then Wilder-smooths to 2.25.
    const result = atr([10, 12, 13], [8, 9, 11], [9, 11, 12], 2);

    expect(result).toBeInstanceOf(Float64Array);
    expect(Number.isNaN(result[0])).toBe(true);
    expect(result[1]).toBeCloseTo(2.5, 10);
    expect(result[2]).toBeCloseTo(2.25, 10);
  });

  it('lets a gap dominate the true range', () => {
    // Bar 1 gaps up 10 points from the prior close, dwarfing the 1-point range.
    const result = atr([10, 20], [9, 19], [10, 19.5], 2);
    expect(result[1]).toBeCloseTo(5.5, 10);
  });

  it('reports zero ATR for a flat market', () => {
    const flat = Array.from({ length: 20 }, () => 5);
    const result = atr(flat, flat, flat, 14);
    expect(result[13]).toBe(0);
    expect(result[19]).toBe(0);
  });

  it('returns all NaN for insufficient or mismatched inputs', () => {
    expect(toArray(atr([1, 2], [1, 2], [1, 2], 14))).toEqual([NaN, NaN]);
    expect(toArray(atr([1, 2], [1], [1, 2], 1))).toEqual([NaN, NaN]);
    expect(toArray(atr([], [], [], 14))).toEqual([]);
  });
});
