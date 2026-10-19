/**
 * Institutional-grade Multi-Factor Signal Score (0–100).
 *
 * Three normalized factors are blended with base weights:
 *   • RSI (40%)      — mean reversion: oversold scores high, overbought low.
 *   • MACD (40%)     — trend/momentum: bullish histogram (MACD > signal) scores high.
 *   • ATR regime (20%) — volatility: quiet regimes score high, blown-out vol low.
 *
 * The inputs also classify a market regime (high volatility → trending →
 * mean-reverting → neutral, first match wins) that tilts the weights by 0.1
 * toward the factor that regime rewards. `computeMultiFactorBreakdown` exposes
 * the sub-scores, applied weights, regime, and a one-line rationale so the
 * score is fully explainable; `calculateMultiFactorScore` returns its number.
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

/** ATR/price at or above 4% classifies the HIGH_VOLATILITY regime. */
const REGIME_HIGH_VOLATILITY = 0.04;
/** Volatility below 2% reads as "calm" in the rationale. */
const CALM_VOLATILITY = 0.02;
/** |MACD histogram|/price at or above 0.5% (half saturation) classifies TRENDING. */
const REGIME_TRENDING_MOMENTUM = 0.005;
/** Momentum inside ±0.05% reads as "flat" in the rationale. */
const FLAT_MOMENTUM = 0.0005;
/** RSI at or beyond 30/70 is "extreme" — MEAN_REVERTING when volatility is moderate. */
const RSI_OVERSOLD = 30;
const RSI_OVERBOUGHT = 70;

export type MarketRegime = 'TRENDING' | 'MEAN_REVERTING' | 'HIGH_VOLATILITY' | 'NEUTRAL';

export interface FactorWeights {
  rsi: number;
  momentum: number;
  volatility: number;
}

/** Regime-tilted base weights — each row sums to 1.0. */
export const REGIME_WEIGHTS: Record<MarketRegime, FactorWeights> = {
  NEUTRAL: MULTI_FACTOR_WEIGHTS,
  TRENDING: { rsi: 0.3, momentum: 0.5, volatility: 0.2 },
  MEAN_REVERTING: { rsi: 0.5, momentum: 0.3, volatility: 0.2 },
  HIGH_VOLATILITY: { rsi: 0.35, momentum: 0.35, volatility: 0.3 },
};

export const REGIME_LABELS: Record<MarketRegime, string> = {
  TRENDING: 'Trending',
  MEAN_REVERTING: 'Mean-reverting',
  HIGH_VOLATILITY: 'High-volatility',
  NEUTRAL: 'Neutral',
};

export interface MultiFactorBreakdown {
  /** Composite 0–100 Signal Score. */
  score: number;
  /** Per-factor 0–100 sub-scores (null when the input is missing) and applied weights. */
  components: {
    rsiScore: number | null;
    momentumScore: number | null;
    volatilityScore: number | null;
    /** Regime-tilted weights renormalized over the available factors (sum 1, or all 0). */
    weights: FactorWeights;
  };
  regime: MarketRegime;
  /** Deterministic one-line thesis explaining the signal. */
  rationale: string;
}

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
 * Classifies the market regime from raw inputs, first match wins: blown-out
 * ATR/price → HIGH_VOLATILITY; strong MACD histogram → TRENDING; extreme RSI
 * (volatility already known to be moderate) → MEAN_REVERTING; else NEUTRAL.
 */
export function classifyRegime(inputs: MultiFactorInputs): MarketRegime {
  const { rsi, momentumPercent, volatilityPercent } = inputs;
  if (isUsable(volatilityPercent) && volatilityPercent >= REGIME_HIGH_VOLATILITY) {
    return 'HIGH_VOLATILITY';
  }
  if (isUsable(momentumPercent) && Math.abs(momentumPercent) >= REGIME_TRENDING_MOMENTUM) {
    return 'TRENDING';
  }
  if (isUsable(rsi) && (rsi <= RSI_OVERSOLD || rsi >= RSI_OVERBOUGHT)) return 'MEAN_REVERTING';
  return 'NEUTRAL';
}

function signedPercent(fraction: number): string {
  // `|| 0` folds a rounded -0 into 0 so near-zero readings never print "-0.0%".
  const pct = Number((fraction * 100).toFixed(1)) || 0;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

function buildRationale(inputs: MultiFactorInputs, regime: MarketRegime): string {
  const { rsi, momentumPercent, volatilityPercent } = inputs;
  const parts: string[] = [];
  if (isUsable(momentumPercent)) {
    const bias =
      momentumPercent >= FLAT_MOMENTUM
        ? 'Bullish'
        : momentumPercent <= -FLAT_MOMENTUM
          ? 'Bearish'
          : 'Flat';
    parts.push(`${bias} momentum (${signedPercent(momentumPercent)})`);
  }
  if (isUsable(volatilityPercent)) {
    const tone =
      volatilityPercent < CALM_VOLATILITY
        ? 'calm'
        : volatilityPercent < REGIME_HIGH_VOLATILITY
          ? 'elevated'
          : 'high';
    parts.push(`${tone} volatility (${(volatilityPercent * 100).toFixed(1)}%)`);
  }
  if (isUsable(rsi)) {
    const zone =
      rsi <= RSI_OVERSOLD ? 'oversold' : rsi >= RSI_OVERBOUGHT ? 'overbought' : 'neutral';
    parts.push(`${zone} RSI ${Math.round(rsi)}`);
  }
  const thesis = parts.length > 0 ? parts.join(' + ') : 'No factor data';
  return `${thesis} · ${REGIME_LABELS[regime]} regime`;
}

/**
 * White-box Multi-Factor model: classifies the regime, tilts the factor
 * weights toward it, renormalizes across the factors that have data, and
 * blends the sub-scores into the 0–100 Signal Score. The example "high
 * momentum + low volatility + oversold RSI" reads 90+, while overbought
 * assets with negative momentum in a blown-out volatility regime bottom out
 * near 0. No usable inputs → score 0 (no signal).
 */
export function computeMultiFactorBreakdown(inputs: MultiFactorInputs): MultiFactorBreakdown {
  const regime = classifyRegime(inputs);
  const base = REGIME_WEIGHTS[regime];
  const rsiScore = isUsable(inputs.rsi) ? rsiFactorScore(inputs.rsi) : null;
  const momentumScore = isUsable(inputs.momentumPercent)
    ? momentumFactorScore(inputs.momentumPercent)
    : null;
  const volatilityScore = isUsable(inputs.volatilityPercent)
    ? volatilityFactorScore(inputs.volatilityPercent)
    : null;

  const activeWeight =
    (rsiScore === null ? 0 : base.rsi) +
    (momentumScore === null ? 0 : base.momentum) +
    (volatilityScore === null ? 0 : base.volatility);
  const applied = (score: number | null, weight: number) =>
    score === null || activeWeight === 0 ? 0 : weight / activeWeight;
  const weights: FactorWeights = {
    rsi: applied(rsiScore, base.rsi),
    momentum: applied(momentumScore, base.momentum),
    volatility: applied(volatilityScore, base.volatility),
  };

  const weighted =
    weights.rsi * (rsiScore ?? 0) +
    weights.momentum * (momentumScore ?? 0) +
    weights.volatility * (volatilityScore ?? 0);

  return {
    score: Math.round(clamp(weighted, 0, 100)),
    components: { rsiScore, momentumScore, volatilityScore, weights },
    regime,
    rationale: buildRationale(inputs, regime),
  };
}

/** The composite 0–100 Signal Score alone (regime-weighted, see the breakdown). */
export function calculateMultiFactorScore(inputs: MultiFactorInputs): number {
  return computeMultiFactorBreakdown(inputs).score;
}
