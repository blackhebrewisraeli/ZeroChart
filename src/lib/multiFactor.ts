/**
 * Institutional-grade Multi-Factor Signal Score (0–100).
 *
 * Three normalized factors are blended with fixed weights:
 *   • RSI (40%)      — mean reversion: oversold scores high, overbought low.
 *   • MACD (40%)     — trend/momentum: bullish histogram (MACD > signal) scores high.
 *   • ATR regime (20%) — volatility: quiet regimes score high, blown-out vol low.
 *
 * The combined reading is O(1) over already-computed indicator values, so the
 * heavy indicator math stays in the finance Web Worker while this runs wherever
 * a score is needed. Missing inputs redistribute their weight across the
 * remaining factors; an asset with no data at all reports 0 (no signal).
 */

export const MULTI_FACTOR_WEIGHTS = {
  rsi: 0.4,
  momentum: 0.4,
  volatility: 0.2,
} as const;

/** Normalized momentum where 0 means flat and ±1% of price saturates the score. */
const MOMENTUM_SATURATION = 0.01;
/** Daily volatility at or below 0.5% reads as maximally quiet. */
const LOW_VOLATILITY = 0.005;
/** Daily volatility at or above 5.5% reads as maximally blown-out. */
const HIGH_VOLATILITY = 0.055;

export interface MultiFactorInputs {
  /** RSI reading (0–100). */
  rsi: number | null;
  /**
   * Normalized momentum as a fraction of price. The rich path feeds the MACD
   * histogram (histogram / price); the static fallback uses the 24h change.
   */
  momentumPercent: number | null;
  /**
   * Normalized volatility as a fraction of price. The rich path feeds
   * ATR(14) / price; the static fallback uses the provider's daily risk %.
   */
  volatilityPercent: number | null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Piecewise-linear interpolation through ascending `[x, y]` control points. */
function interpolate(x: number, points: ReadonlyArray<readonly [number, number]>): number {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return 0;
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < points.length; i += 1) {
    const upper = points[i];
    if (upper !== undefined && x <= upper[0]) {
      const lower = points[i - 1];
      if (lower === undefined) break;
      const t = (x - lower[0]) / (upper[0] - lower[0]);
      return lower[1] + (upper[1] - lower[1]) * t;
    }
  }
  return last[1];
}

/** Mean-reversion component (0–100): oversold RSI scores highest. */
export function rsiFactorScore(rsi: number): number {
  const points: ReadonlyArray<readonly [number, number]> = [
    [0, 100],
    [30, 95],
    [50, 55],
    [70, 15],
    [100, 0],
  ];
  return interpolate(clamp(rsi, 0, 100), points);
}

/** Momentum component (0–100): saturates at ±1% of price (0 → neutral 50). */
export function momentumFactorScore(momentumPercent: number): number {
  if (!Number.isFinite(momentumPercent)) return 0;
  return clamp(50 + 50 * (momentumPercent / MOMENTUM_SATURATION), 0, 100);
}

/** Volatility-regime component (0–100): quiet regimes score highest. */
export function volatilityFactorScore(volatilityPercent: number): number {
  if (!Number.isFinite(volatilityPercent)) return 0;
  const span = HIGH_VOLATILITY - LOW_VOLATILITY;
  return clamp(100 * (1 - (volatilityPercent - LOW_VOLATILITY) / span), 0, 100);
}

function isUsable(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

/**
 * Blends the three factors into a single 0–100 Signal Score. The example
 * "high momentum + low volatility + oversold RSI" reads 90+, while overbought
 * assets with negative momentum in a blown-out volatility regime bottom out
 * near 0.
 */
export function calculateMultiFactorScore(inputs: MultiFactorInputs): number {
  let weighted = 0;
  let activeWeight = 0;

  if (isUsable(inputs.rsi)) {
    weighted += MULTI_FACTOR_WEIGHTS.rsi * rsiFactorScore(inputs.rsi);
    activeWeight += MULTI_FACTOR_WEIGHTS.rsi;
  }
  if (isUsable(inputs.momentumPercent)) {
    weighted += MULTI_FACTOR_WEIGHTS.momentum * momentumFactorScore(inputs.momentumPercent);
    activeWeight += MULTI_FACTOR_WEIGHTS.momentum;
  }
  if (isUsable(inputs.volatilityPercent)) {
    weighted += MULTI_FACTOR_WEIGHTS.volatility * volatilityFactorScore(inputs.volatilityPercent);
    activeWeight += MULTI_FACTOR_WEIGHTS.volatility;
  }

  if (activeWeight === 0) return 0;
  return Math.round(clamp(weighted / activeWeight, 0, 100));
}
