import { describe, expect, it } from 'vitest';
import { rsi, sma } from '@/lib/indicators';

describe('sma', () => {
  it('computes a rolling average after the warm-up period', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it('returns the identity series for period 1', () => {
    expect(sma([7, 8, 9], 1)).toEqual([7, 8, 9]);
  });

  it('returns all nulls when there is not enough data', () => {
    expect(sma([1, 2, 3], 5)).toEqual([null, null, null]);
    expect(sma([], 3)).toEqual([]);
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
    // period = 3 over [1, 3, 2, 4, 5]
    const result = rsi([1, 3, 2, 4, 5], 3);

    expect(result[0]).toBeNull();
    expect(result[1]).toBeNull();
    expect(result[2]).toBeNull();
    expect(result[3]).toBeCloseTo(80, 5);
    expect(result[4]).toBeCloseTo(84.6154, 3);
  });

  it('returns all nulls when there is not enough data', () => {
    expect(rsi([1, 2, 3], 14)).toEqual([null, null, null]);
  });
});
