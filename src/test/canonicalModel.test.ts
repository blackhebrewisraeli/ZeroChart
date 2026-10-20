import { describe, expect, it } from 'vitest';
import {
  CANONICAL_MODEL_VERSION,
  MIN_CANDLES,
  REGIME_WEIGHTS,
  classifyRegime,
  evaluateCandles,
  momentumFactorScore,
  rsiFactorScore,
  scoreFactors,
  scoreOf,
  volatilityFactorScore,
  type EngineCandle,
} from '@/lib/canonicalModel';
import { evaluateCandlesAsync } from '@/lib/financeClient';
import { atr, macd, rsi } from '@/lib/indicators';

/** Deterministic daily candles: a drifting sine wave with a ±1% intraday range. */
function makeCandles(count: number, drift = 0.2): EngineCandle[] {
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + 10 * Math.sin(i / 5) + drift * i;
    return { high: close * 1.01, low: close * 0.99, close };
  });
}

describe('evaluateCandles', () => {
  it('needs 34 candles — MACD(12, 26, 9) is the binding warm-up', () => {
    expect(MIN_CANDLES).toBe(34);
  });

  it('returns INSUFFICIENT_DATA for short series instead of guessing', () => {
    for (const count of [0, 1, 14, 15, 26, MIN_CANDLES - 1]) {
      expect(evaluateCandles(makeCandles(count))).toEqual({
        status: 'INSUFFICIENT_DATA',
        version: CANONICAL_MODEL_VERSION,
        required: MIN_CANDLES,
        received: count,
      });
    }
  });

  it('scores a series from exactly MIN_CANDLES candles', () => {
    const result = evaluateCandles(makeCandles(MIN_CANDLES));
    expect(result.status).toBe('OK');
  });

  it('returns INSUFFICIENT_DATA when the last bar has a non-finite or non-positive reading', () => {
    const corrupt = makeCandles(60);
    corrupt[59] = { high: Number.NaN, low: 1, close: 1 };
    expect(evaluateCandles(corrupt).status).toBe('INSUFFICIENT_DATA');

    const zero = makeCandles(60);
    zero[59] = { high: 0, low: 0, close: 0 };
    expect(evaluateCandles(zero).status).toBe('INSUFFICIENT_DATA');
  });

  it('yields the exact same result for the exact same candles, every time', () => {
    const candles = makeCandles(200);
    const first = evaluateCandles(candles);
    for (let run = 0; run < 25; run += 1) {
      expect(evaluateCandles(candles)).toEqual(first);
      // A structurally identical copy (e.g. a refetch) scores identically too.
      expect(evaluateCandles(candles.map((candle) => ({ ...candle })))).toEqual(first);
    }
  });

  it('pins the score of a fixed series (bump CANONICAL_MODEL_VERSION if this moves)', () => {
    const result = evaluateCandles(makeCandles(200));
    if (result.status !== 'OK') throw new Error('expected a score');
    expect(result.version).toBe('1.0.0');
    expect(result.signal_score).toBe(61);
    expect(result.regime).toBe('TRENDING');
    expect(scoreOf(result)).toBe(result.signal_score);
  });

  it('feeds the last bar of RSI/MACD/ATR, normalized by the last close, into the composite', () => {
    const candles = makeCandles(200);
    const closes = candles.map((candle) => candle.close);
    const highs = candles.map((candle) => candle.high);
    const lows = candles.map((candle) => candle.low);
    const last = candles.length - 1;
    const close = closes[last]!;
    const atrValue = atr(highs, lows, closes, 14)[last]!;
    const expected = scoreFactors({
      rsi: rsi(closes, 14)[last]!,
      momentumPercent: macd(closes, 12, 26, 9).histogram[last]! / close,
      volatilityPercent: atrValue / close,
    });
    expect(evaluateCandles(candles)).toEqual({
      status: 'OK',
      version: CANONICAL_MODEL_VERSION,
      close,
      atr: atrValue,
      ...expected,
    });
  });

  it('gives the same answer through the worker client as in-process', async () => {
    const candles = makeCandles(120);
    expect(await evaluateCandlesAsync(candles)).toEqual(evaluateCandles(candles));
  });

  it('scoreOf is null for a result without enough data', () => {
    expect(scoreOf(evaluateCandles([]))).toBeNull();
    expect(scoreOf(undefined)).toBeNull();
  });
});

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
  });

  it('rewards quiet volatility regimes and penalizes blown-out ones', () => {
    expect(volatilityFactorScore(0.005)).toBe(100);
    expect(volatilityFactorScore(0.03)).toBeCloseTo(50, 6);
    expect(volatilityFactorScore(0.055)).toBe(0);
    expect(volatilityFactorScore(0.2)).toBe(0); // clamped
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
    expect(classifyRegime({ rsi: 50, momentumPercent: -0.008, volatilityPercent: 0.01 })).toBe(
      'TRENDING',
    );
  });

  it('flags extreme RSI with moderate volatility as MEAN_REVERTING', () => {
    expect(classifyRegime({ rsi: 28, momentumPercent: 0.001, volatilityPercent: 0.02 })).toBe(
      'MEAN_REVERTING',
    );
    expect(classifyRegime({ rsi: 72, momentumPercent: 0, volatilityPercent: 0.015 })).toBe(
      'MEAN_REVERTING',
    );
  });

  it('falls back to NEUTRAL when no condition is met', () => {
    expect(classifyRegime({ rsi: 50, momentumPercent: 0.001, volatilityPercent: 0.02 })).toBe(
      'NEUTRAL',
    );
  });
});

describe('scoreFactors', () => {
  it('keeps every regime weight row summing to 1.0', () => {
    for (const weights of Object.values(REGIME_WEIGHTS)) {
      expect(weights.rsi + weights.momentum + weights.volatility).toBeCloseTo(1, 10);
    }
  });

  it('reads 90+ for high momentum, low volatility, and oversold RSI', () => {
    const { signal_score } = scoreFactors({
      rsi: 25,
      momentumPercent: 0.012,
      volatilityPercent: 0.006,
    });
    expect(signal_score).toBeGreaterThanOrEqual(90);
  });

  it('reads near 0 for overbought, negative-momentum, high-volatility assets', () => {
    const { signal_score } = scoreFactors({
      rsi: 80,
      momentumPercent: -0.02,
      volatilityPercent: 0.06,
    });
    expect(signal_score).toBeLessThanOrEqual(10);
  });

  it('uses the base 40/40/20 weights in a NEUTRAL regime', () => {
    const result = scoreFactors({ rsi: 50, momentumPercent: 0.001, volatilityPercent: 0.02 });
    expect(result.regime).toBe('NEUTRAL');
    expect(result.components.weights).toEqual({ rsi: 0.4, momentum: 0.4, volatility: 0.2 });
    // 0.4×55 + 0.4×55 + 0.2×70 = 58.
    expect(result.signal_score).toBe(58);
  });

  it('boosts the momentum weight in a TRENDING regime', () => {
    const result = scoreFactors({ rsi: 50, momentumPercent: 0.01, volatilityPercent: 0.02 });
    expect(result.regime).toBe('TRENDING');
    expect(result.components.weights.momentum).toBeCloseTo(0.5, 10);
    expect(result.components.weights.rsi).toBeCloseTo(0.3, 10);
    expect(result.components).toMatchObject({
      rsiScore: 55,
      momentumScore: 100,
      volatilityScore: 70,
    });
    // 0.3×55 + 0.5×100 + 0.2×70 = 80.5 → 81 (fixed weights would read 76).
    expect(result.signal_score).toBe(81);
  });

  it('boosts the RSI weight in a MEAN_REVERTING regime', () => {
    const result = scoreFactors({ rsi: 25, momentumPercent: 0.001, volatilityPercent: 0.015 });
    expect(result.regime).toBe('MEAN_REVERTING');
    expect(result.components.weights.rsi).toBeCloseTo(0.5, 10);
    expect(result.components.weights.momentum).toBeCloseTo(0.3, 10);
    // 0.5×95.83 + 0.3×55 + 0.2×80 = 80.42 → 80.
    expect(result.signal_score).toBe(80);
  });

  it('writes a deterministic one-line rationale', () => {
    expect(
      scoreFactors({ rsi: 25, momentumPercent: 0.008, volatilityPercent: 0.012 }).rationale,
    ).toBe('Bullish momentum (+0.8%) + calm volatility (1.2%) + oversold RSI 25 · Trending regime');
    expect(
      scoreFactors({ rsi: 74, momentumPercent: -0.0002, volatilityPercent: 0.03 }).rationale,
    ).toBe(
      'Flat momentum (+0.0%) + elevated volatility (3.0%) + overbought RSI 74 · Mean-reverting regime',
    );
    expect(
      scoreFactors({ rsi: 50, momentumPercent: -0.01, volatilityPercent: 0.06 }).rationale,
    ).toBe(
      'Bearish momentum (-1.0%) + high volatility (6.0%) + neutral RSI 50 · High-volatility regime',
    );
  });
});
