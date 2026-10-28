/**
 * Canonical Math Engine — the single source of truth for every Signal Score
 * in the app. The Pine HUD mirrors the factor and decision math, while its
 * built-in MACD uses TradingView's EMA initialization rather than the explicit
 * SMA-seeded convention in `src/lib/indicators.ts`; see the numerical audit in
 * `docs/QUANT_MODEL_VERIFICATION.md`.
 *
 * Input is a daily OHLC candle series. The engine computes Wilder RSI(14),
 * MACD(12, 26, 9) and Wilder ATR(14) on it (src/lib/indicators.ts), normalizes
 * the MACD histogram and ATR by the last close exactly like the Pine script,
 * and blends three 0–100 factor scores with base weights:
 *   • RSI (40%)        — mean reversion: oversold scores high, overbought low.
 *   • MACD (40%)       — trend/momentum: bullish histogram scores high.
 *   • ATR regime (20%) — volatility: quiet regimes score high, blown-out vol low.
 *
 * The inputs also classify a market regime (high volatility → trending →
 * mean-reverting → neutral, first match wins) that tilts the weights by 0.1
 * toward the factor that regime rewards.
 *
 * No guessing: a series too short for every indicator to be defined on its
 * last bar (Pine's `ready`), or with a non-finite reading, returns
 * `INSUFFICIENT_DATA` — never a proxy factor and never a default 0.
 *
 * Pure and synchronous: callers reach it through the finance Web Worker
 * (`evaluateCandlesAsync`), and `scoreTicker` in roboAdvisor.ts pairs it with
 * the candle fetch. Bump `CANONICAL_MODEL_VERSION` whenever a change can move
 * a score; it is stamped on every result and keys the client-side score cache.
 */
import { atr, macd, rsi } from '@/lib/indicators';
import type { CandleIssue } from '@/lib/candleValidation';

export const CANONICAL_MODEL_VERSION = '1.0.0';

export const RSI_PERIOD = 14;
export const MACD_FAST = 12;
export const MACD_SLOW = 26;
export const MACD_SIGNAL = 9;
export const ATR_PERIOD = 14;

/**
 * Candles needed before all three indicators are defined on the last bar:
 * RSI needs period + 1 closes (15), ATR needs period candles (14), and the
 * MACD histogram needs slow + signal − 1 (34) — the binding constraint.
 */
export const MIN_CANDLES = Math.max(RSI_PERIOD + 1, MACD_SLOW + MACD_SIGNAL - 1, ATR_PERIOD);

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
export const REGIME_HIGH_VOLATILITY = 0.04;
/** Volatility below 2% reads as "calm" in the rationale. */
const CALM_VOLATILITY = 0.02;
/** |MACD histogram|/price at or above 0.5% (half saturation) classifies TRENDING. */
const REGIME_TRENDING_MOMENTUM = 0.005;
/** Momentum inside ±0.05% reads as "flat" in the rationale (and in Pine's setups). */
export const FLAT_MOMENTUM = 0.0005;
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

/** The three price-normalized readings the factor scores are built from. */
export interface FactorInputs {
  /** RSI(14) reading (0–100). */
  rsi: number;
  /** MACD(12, 26, 9) histogram / close. */
  momentumPercent: number;
  /** ATR(14) / close. */
  volatilityPercent: number;
}

export interface FactorScore {
  /** Composite 0–100 Signal Score. Pine plots its own as "ZC Score" (docs/PINE_PARITY_ASSESSMENT.md). */
  signal_score: number;
  /** Per-factor 0–100 sub-scores and the regime weights applied to them. */
  components: {
    rsiScore: number;
    momentumScore: number;
    volatilityScore: number;
    weights: FactorWeights;
  };
  regime: MarketRegime;
  /** Deterministic one-line thesis explaining the signal. */
  rationale: string;
}

/** The structural slice of an OHLC candle the engine reads. */
export interface EngineCandle {
  high: number;
  low: number;
  close: number;
}

export interface CanonicalScore extends FactorScore {
  status: 'OK';
  version: typeof CANONICAL_MODEL_VERSION;
  /** The last bar's raw readings the factor scores were built from. */
  inputs: FactorInputs;
  /** Last candle close — the price Pine normalizes MACD and ATR by. */
  close: number;
  /** ATR(14) in price units, for position sizing. */
  atr: number;
}

export interface InsufficientData {
  status: 'INSUFFICIENT_DATA';
  version: typeof CANONICAL_MODEL_VERSION;
  /** Candles the engine needs (MIN_CANDLES). */
  required: number;
  /** Candles it was given. */
  received: number;
}

export interface InvalidCandleData {
  status: 'DATA_INVALID';
  version: typeof CANONICAL_MODEL_VERSION;
  validationPolicyVersion: string;
  issues: readonly CandleIssue[];
}

export interface StaleCandleData {
  status: 'STALE_DATA';
  version: typeof CANONICAL_MODEL_VERSION;
  validationPolicyVersion: string;
  latestCloseTime: number | null;
}

/** No validated candle source for the ticker's asset class: never fetched, never scored. */
export interface UnsupportedCandleSource {
  status: 'UNSUPPORTED';
  version: typeof CANONICAL_MODEL_VERSION;
  /** Why, in the Markets scan's words. */
  detail: string;
}

/** The candle request failed (network, HTTP status, rate limit): nothing was scored. */
export interface CandleFetchFailed {
  status: 'FETCH_FAILED';
  version: typeof CANONICAL_MODEL_VERSION;
  detail: string;
}

/** What the engine and the candle validators can say about a candle series. */
export type EngineResult = CanonicalScore | InsufficientData | InvalidCandleData | StaleCandleData;

/** A ticker's result: the engine's, or why no candles ever reached it (scoreTicker). */
export type CanonicalResult = EngineResult | UnsupportedCandleSource | CandleFetchFailed;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Piecewise-linear interpolation through ascending `[x, y]` control points. */
function interpolate(x: number, points: ReadonlyArray<readonly [number, number]>): number {
  const first = points[0];
  const last = points.at(-1);
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
export function rsiFactorScore(rsiValue: number): number {
  const points: ReadonlyArray<readonly [number, number]> = [
    [0, 100],
    [30, 95],
    [50, 55],
    [70, 15],
    [100, 0],
  ];
  return interpolate(clamp(rsiValue, 0, 100), points);
}

/** Momentum component (0–100): saturates at ±1% of price (0 → neutral 50). */
export function momentumFactorScore(momentumPercent: number): number {
  return clamp(50 + 50 * (momentumPercent / MOMENTUM_SATURATION), 0, 100);
}

/** Volatility-regime component (0–100): quiet regimes score highest. */
export function volatilityFactorScore(volatilityPercent: number): number {
  const span = HIGH_VOLATILITY - LOW_VOLATILITY;
  return clamp(100 * (1 - (volatilityPercent - LOW_VOLATILITY) / span), 0, 100);
}

/**
 * Classifies the market regime, first match wins: blown-out ATR/price →
 * HIGH_VOLATILITY; strong MACD histogram → TRENDING; extreme RSI (volatility
 * already known to be moderate) → MEAN_REVERTING; else NEUTRAL.
 */
export function classifyRegime(inputs: FactorInputs): MarketRegime {
  const { rsi: rsiValue, momentumPercent, volatilityPercent } = inputs;
  if (volatilityPercent >= REGIME_HIGH_VOLATILITY) return 'HIGH_VOLATILITY';
  if (Math.abs(momentumPercent) >= REGIME_TRENDING_MOMENTUM) return 'TRENDING';
  if (rsiValue <= RSI_OVERSOLD || rsiValue >= RSI_OVERBOUGHT) return 'MEAN_REVERTING';
  return 'NEUTRAL';
}

function signedPercent(fraction: number): string {
  // `|| 0` folds a rounded -0 into 0 so near-zero readings never print "-0.0%".
  const pct = Number((fraction * 100).toFixed(1)) || 0;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

function momentumBias(momentumPercent: number): string {
  if (momentumPercent >= FLAT_MOMENTUM) return 'Bullish';
  if (momentumPercent <= -FLAT_MOMENTUM) return 'Bearish';
  return 'Flat';
}

function volatilityTone(volatilityPercent: number): string {
  if (volatilityPercent < CALM_VOLATILITY) return 'calm';
  if (volatilityPercent < REGIME_HIGH_VOLATILITY) return 'elevated';
  return 'high';
}

function rsiZone(rsiValue: number): string {
  if (rsiValue <= RSI_OVERSOLD) return 'oversold';
  if (rsiValue >= RSI_OVERBOUGHT) return 'overbought';
  return 'neutral';
}

function buildRationale(inputs: FactorInputs, regime: MarketRegime): string {
  const { rsi: rsiValue, momentumPercent, volatilityPercent } = inputs;
  const bias = momentumBias(momentumPercent);
  const tone = volatilityTone(volatilityPercent);
  const zone = rsiZone(rsiValue);
  return (
    `${bias} momentum (${signedPercent(momentumPercent)}) + ` +
    `${tone} volatility (${(volatilityPercent * 100).toFixed(1)}%) + ` +
    `${zone} RSI ${Math.round(rsiValue)} · ${REGIME_LABELS[regime]} regime`
  );
}

/**
 * Blends the three factor scores with the regime-tilted weights. Mirrors the
 * Pine composite operation for operation — including the division by the
 * weight sum — so equal indicator readings round the same way. Pine's readings
 * themselves can differ (docs/PINE_PARITY_ASSESSMENT.md).
 */
export function scoreFactors(inputs: FactorInputs): FactorScore {
  const regime = classifyRegime(inputs);
  const base = REGIME_WEIGHTS[regime];
  const rsiScore = rsiFactorScore(inputs.rsi);
  const momentumScore = momentumFactorScore(inputs.momentumPercent);
  const volatilityScore = volatilityFactorScore(inputs.volatilityPercent);

  const activeWeight = base.rsi + base.momentum + base.volatility;
  const weightedSum =
    base.rsi * rsiScore + base.momentum * momentumScore + base.volatility * volatilityScore;

  return {
    signal_score: Math.round(clamp(weightedSum / activeWeight, 0, 100)),
    components: {
      rsiScore,
      momentumScore,
      volatilityScore,
      weights: {
        rsi: base.rsi / activeWeight,
        momentum: base.momentum / activeWeight,
        volatility: base.volatility / activeWeight,
      },
    },
    regime,
    rationale: buildRationale(inputs, regime),
  };
}

/**
 * Scores a candle series (oldest first). The reading is the last bar's, like
 * Pine's — never the last *defined* value of a series that went stale.
 */
export function evaluateCandles(candles: readonly EngineCandle[]): EngineResult {
  const insufficient: InsufficientData = {
    status: 'INSUFFICIENT_DATA',
    version: CANONICAL_MODEL_VERSION,
    required: MIN_CANDLES,
    received: candles.length,
  };
  if (candles.length < MIN_CANDLES) return insufficient;

  const closes = candles.map((candle) => candle.close);
  const highs = candles.map((candle) => candle.high);
  const lows = candles.map((candle) => candle.low);
  const last = candles.length - 1;
  const close = closes[last] ?? Number.NaN;
  const rsiValue = rsi(closes, RSI_PERIOD)[last] ?? Number.NaN;
  const histogram = macd(closes, MACD_FAST, MACD_SLOW, MACD_SIGNAL).histogram[last] ?? Number.NaN;
  const atrValue = atr(highs, lows, closes, ATR_PERIOD)[last] ?? Number.NaN;

  if (![close, rsiValue, histogram, atrValue].every(Number.isFinite) || close <= 0) {
    return insufficient;
  }

  const inputs: FactorInputs = {
    rsi: rsiValue,
    momentumPercent: histogram / close,
    volatilityPercent: atrValue / close,
  };
  return {
    status: 'OK',
    version: CANONICAL_MODEL_VERSION,
    close,
    atr: atrValue,
    inputs,
    ...scoreFactors(inputs),
  };
}

/** Pine's `longSetup` ("ZC LONG"): score at or above this with bullish momentum. */
export const LONG_SETUP_MIN_SCORE = 78;
/** Pine's `riskSetup` ("ZC RISK"): score at or below this, or a HIGH_VOLATILITY regime. */
export const RISK_SETUP_MAX_SCORE = 28;

export interface ModelSetups {
  long: boolean;
  risk: boolean;
}

/**
 * The setup conditions Pine evaluates on a closed bar (`longSetup` and
 * `riskSetup` in pine/zerochart_quant_hud.pine); both can hold at once. Pine
 * alerts only on the bar a condition turns true, so a condition that holds
 * here is a standing setup, not a fresh signal.
 */
export function modelSetups(
  result: Pick<CanonicalScore, 'signal_score' | 'regime' | 'inputs'>,
): ModelSetups {
  const { signal_score: score, regime, inputs } = result;
  return {
    long: score >= LONG_SETUP_MIN_SCORE && inputs.momentumPercent >= FLAT_MOMENTUM,
    risk: score <= RISK_SETUP_MAX_SCORE || regime === 'HIGH_VOLATILITY',
  };
}

/** The Signal Score of a result, or null while loading / without enough data. */
export function scoreOf(result: CanonicalResult | undefined): number | null {
  return result?.status === 'OK' ? result.signal_score : null;
}
