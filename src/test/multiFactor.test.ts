import { describe, expect, it } from 'vitest';
import {
  calculateMultiFactorScore,
  classifyRegime,
  computeMultiFactorBreakdown,
  momentumFactorScore,
  REGIME_WEIGHTS,
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

describe('classifyRegime', () => {
  it('flags blown-out ATR/price as HIGH_VOLATILITY before anything else', () => {
    // Strong momentum and extreme RSI are both present, but 4%+ ATR wins.
    expect(classifyRegime({ rsi: 20, momentumPercent: 0.02, volatilityPercent: 0.04 })).toBe(
      'HIGH_VOLATILITY',
    );
  });

  it('flags a strong MACD histogram (either sign) as TRENDING', () => {
    expect(classifyRegime({ rsi: 50, momentumPercent: 0.005, volatilityPercent: 0.01 })).toBe(
      'TRENDING',
    );
    expect(classifyRegime({ rsi: 50, momentumPercent: -0.008, volatilityPercent: null })).toBe(
      'TRENDING',
    );
  });

  it('flags extreme RSI with moderate volatility as MEAN_REVERTING', () => {
    expect(classifyRegime({ rsi: 28, momentumPercent: 0.001, volatilityPercent: 0.02 })).toBe(
      'MEAN_REVERTING',
    );
    expect(classifyRegime({ rsi: 72, momentumPercent: null, volatilityPercent: 0.015 })).toBe(
      'MEAN_REVERTING',
    );
  });

  it('falls back to NEUTRAL when no condition is met or data is missing', () => {
    expect(classifyRegime({ rsi: 50, momentumPercent: 0.001, volatilityPercent: 0.02 })).toBe(
      'NEUTRAL',
    );
    expect(classifyRegime({ rsi: null, momentumPercent: null, volatilityPercent: null })).toBe(
      'NEUTRAL',
    );
  });
});

describe('computeMultiFactorBreakdown', () => {
  it('keeps every regime weight row summing to 1.0', () => {
    for (const weights of Object.values(REGIME_WEIGHTS)) {
      expect(weights.rsi + weights.momentum + weights.volatility).toBeCloseTo(1, 10);
    }
  });

  it('uses the base 40/40/20 weights in a NEUTRAL regime', () => {
    const result = computeMultiFactorBreakdown({
      rsi: 50,
      momentumPercent: 0.001,
      volatilityPercent: 0.02,
    });
    expect(result.regime).toBe('NEUTRAL');
    expect(result.components.weights).toEqual({ rsi: 0.4, momentum: 0.4, volatility: 0.2 });
    // 0.4×55 + 0.4×55 + 0.2×70 = 58.
    expect(result.score).toBe(58);
  });

  it('boosts the momentum weight in a TRENDING regime', () => {
    const result = computeMultiFactorBreakdown({
      rsi: 50,
      momentumPercent: 0.01,
      volatilityPercent: 0.02,
    });
    expect(result.regime).toBe('TRENDING');
    expect(result.components.weights.momentum).toBeCloseTo(0.5, 10);
    expect(result.components.weights.rsi).toBeCloseTo(0.3, 10);
    expect(result.components).toMatchObject({
      rsiScore: 55,
      momentumScore: 100,
      volatilityScore: 70,
    });
    // 0.3×55 + 0.5×100 + 0.2×70 = 80.5 → 81 (fixed weights would read 76).
    expect(result.score).toBe(81);
  });

  it('boosts the RSI weight in a MEAN_REVERTING regime', () => {
    const result = computeMultiFactorBreakdown({
      rsi: 25,
      momentumPercent: 0.001,
      volatilityPercent: 0.015,
    });
    expect(result.regime).toBe('MEAN_REVERTING');
    expect(result.components.weights.rsi).toBeCloseTo(0.5, 10);
    expect(result.components.weights.momentum).toBeCloseTo(0.3, 10);
    // 0.5×95.83 + 0.3×55 + 0.2×80 = 80.42 → 80.
    expect(result.score).toBe(80);
  });

  it('renormalizes the tilted weights over the factors that have data', () => {
    const result = computeMultiFactorBreakdown({
      rsi: 25,
      momentumPercent: null,
      volatilityPercent: 0.015,
    });
    expect(result.regime).toBe('MEAN_REVERTING');
    expect(result.components.momentumScore).toBeNull();
    // 0.5 / 0.7 and 0.2 / 0.7 — the missing factor carries no weight.
    expect(result.components.weights.rsi).toBeCloseTo(5 / 7, 10);
    expect(result.components.weights.momentum).toBe(0);
    expect(result.components.weights.volatility).toBeCloseTo(2 / 7, 10);
  });

  it('agrees with calculateMultiFactorScore for existing callers', () => {
    const inputs = { rsi: 62, momentumPercent: -0.003, volatilityPercent: 0.045 };
    expect(calculateMultiFactorScore(inputs)).toBe(computeMultiFactorBreakdown(inputs).score);
  });

  it('writes a deterministic one-line rationale', () => {
    expect(
      computeMultiFactorBreakdown({ rsi: 25, momentumPercent: 0.008, volatilityPercent: 0.012 })
        .rationale,
    ).toBe('Bullish momentum (+0.8%) + calm volatility (1.2%) + oversold RSI 25 · Trending regime');
    expect(
      computeMultiFactorBreakdown({ rsi: 74, momentumPercent: -0.0002, volatilityPercent: 0.03 })
        .rationale,
    ).toBe(
      'Flat momentum (+0.0%) + elevated volatility (3.0%) + overbought RSI 74 · Mean-reverting regime',
    );
    expect(
      computeMultiFactorBreakdown({ rsi: null, momentumPercent: -0.01, volatilityPercent: 0.06 })
        .rationale,
    ).toBe('Bearish momentum (-1.0%) + high volatility (6.0%) · High-volatility regime');
    expect(
      computeMultiFactorBreakdown({ rsi: null, momentumPercent: null, volatilityPercent: null }),
    ).toEqual({
      score: 0,
      components: {
        rsiScore: null,
        momentumScore: null,
        volatilityScore: null,
        weights: { rsi: 0, momentum: 0, volatility: 0 },
      },
      regime: 'NEUTRAL',
      rationale: 'No factor data · Neutral regime',
    });
  });
});
