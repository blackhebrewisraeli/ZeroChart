import { describe, expect, it } from 'vitest';
import {
  calculateMultiFactorScore,
  momentumFactorScore,
  rsiFactorScore,
  volatilityFactorScore,
} from '@/lib/multiFactor';

describe('factor scores', () => {
  it('scores oversold RSI highest and overbought lowest (mean reversion)', () => {
    expect(rsiFactorScore(0)).toBe(100);
    expect(rsiFactorScore(30)).toBeCloseTo(95, 6);
    expect(rsiFactorScore(50)).toBeCloseTo(55, 6);
    expect(rsiFactorScore(70)).toBeCloseTo(15, 6);
    expect(rsiFactorScore(100)).toBe(0);
    // Out-of-range readings clamp instead of escaping the 0–100 band.
    expect(rsiFactorScore(150)).toBe(0);
    expect(rsiFactorScore(-10)).toBe(100);
  });

  it('saturates momentum at ±1% of price around a neutral 50', () => {
    expect(momentumFactorScore(0)).toBe(50);
    expect(momentumFactorScore(0.01)).toBe(100);
    expect(momentumFactorScore(-0.01)).toBe(0);
    expect(momentumFactorScore(0.05)).toBe(100); // clamped
    expect(momentumFactorScore(Number.NaN)).toBe(0);
  });

  it('rewards quiet volatility regimes and penalizes blown-out ones', () => {
    expect(volatilityFactorScore(0.005)).toBe(100);
    expect(volatilityFactorScore(0.03)).toBeCloseTo(50, 6);
    expect(volatilityFactorScore(0.055)).toBe(0);
    expect(volatilityFactorScore(0.2)).toBe(0); // clamped
  });
});

describe('calculateMultiFactorScore', () => {
  it('reads 90+ for high momentum, low volatility, and oversold RSI', () => {
    const score = calculateMultiFactorScore({
      rsi: 25,
      momentumPercent: 0.012,
      volatilityPercent: 0.006,
    });
    // 0.4×95.83 + 0.4×100 + 0.2×98 = 97.93 → 98
    expect(score).toBe(98);
    expect(score).toBeGreaterThanOrEqual(90);
  });

  it('reads near 0 for overbought, negative-momentum, high-volatility assets', () => {
    const score = calculateMultiFactorScore({
      rsi: 80,
      momentumPercent: -0.02,
      volatilityPercent: 0.06,
    });
    expect(score).toBeLessThanOrEqual(10);
  });

  it('redistributes weight across the factors that are available', () => {
    // Only RSI present → the RSI factor carries the full score on its own.
    expect(
      calculateMultiFactorScore({ rsi: 30, momentumPercent: null, volatilityPercent: null }),
    ).toBe(95);
    expect(
      calculateMultiFactorScore({ rsi: null, momentumPercent: 0.01, volatilityPercent: null }),
    ).toBe(100);
  });

  it('reports 0 (no signal) when no factor data exists', () => {
    expect(
      calculateMultiFactorScore({ rsi: null, momentumPercent: null, volatilityPercent: null }),
    ).toBe(0);
  });

  it('always clamps into the 0–100 range', () => {
    const high = calculateMultiFactorScore({
      rsi: 150,
      momentumPercent: 0.01,
      volatilityPercent: 0.001,
    });
    expect(high).toBeGreaterThanOrEqual(0);
    expect(high).toBeLessThanOrEqual(100);

    const low = calculateMultiFactorScore({
      rsi: Number.NaN,
      momentumPercent: -9,
      volatilityPercent: Number.POSITIVE_INFINITY,
    });
    expect(low).toBe(0);
  });
});
