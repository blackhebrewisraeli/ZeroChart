/**
 * Pure technical-indicator math over a close-price series. Every function
 * returns a `Float64Array` aligned to the input length, using `NaN` for the
 * warm-up period where the indicator is not yet defined. The hot loops run over
 * typed arrays for predictable, allocation-light execution.
 */

/** Simple Moving Average over `period` bars. */
export function sma(values: number[], period: number): Float64Array {
  const out = new Float64Array(values.length).fill(Number.NaN);
  if (!Number.isInteger(period) || period <= 0 || values.length < period) return out;

  const prices = Float64Array.from(values);
  let sum = 0;
  for (let i = 0; i < prices.length; i += 1) {
    sum += prices[i]!;
    if (i >= period) sum -= prices[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Wilder's Relative Strength Index over `period` bars (default 14).
 * The first value is available at index `period` (one change earlier than SMA).
 */
export function rsi(values: number[], period = 14): Float64Array {
  const out = new Float64Array(values.length).fill(Number.NaN);
  if (!Number.isInteger(period) || period <= 0 || values.length <= period) return out;

  const prices = Float64Array.from(values);
  let avgGain = 0;
  let avgLoss = 0;

  // Seed with the simple average of the first `period` price changes.
  for (let i = 1; i <= period; i += 1) {
    const change = prices[i]! - prices[i - 1]!;
    if (change >= 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = rsiValue(avgGain, avgLoss);

  // Wilder smoothing for the remaining bars.
  for (let i = period + 1; i < prices.length; i += 1) {
    const change = prices[i]! - prices[i - 1]!;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiValue(avgGain, avgLoss);
  }

  return out;
}

function rsiValue(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** MACD (Moving Average Convergence Divergence) triple, aligned to input length. */
export interface MacdResult {
  /** MACD line: EMA(fast) − EMA(slow). */
  macd: Float64Array;
  /** Signal line: EMA of the MACD line. */
  signal: Float64Array;
  /** Histogram: MACD − signal (bullish when positive). */
  histogram: Float64Array;
}

/**
 * EMA seeded with the simple average of the first `period` values at index
 * `period - 1`, then smoothed with the standard k = 2 / (period + 1) factor.
 * Values before the seed stay `NaN`.
 */
function emaSeries(values: Float64Array, period: number): Float64Array {
  const out = new Float64Array(values.length).fill(Number.NaN);
  if (!Number.isInteger(period) || period <= 0 || values.length < period) return out;

  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i] ?? 0;
  let previous = seed / period;
  out[period - 1] = previous;

  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) {
    previous += k * ((values[i] ?? previous) - previous);
    out[i] = previous;
  }
  return out;
}

/**
 * MACD (12, 26, 9) by default: the MACD line is EMA(12) − EMA(26), the signal
 * line is an EMA(9) of the valid MACD tail, and the histogram is the difference.
 * Warm-up values are `NaN`, so the first defined histogram sits at index
 * slow + signal − 2 (33 for the defaults), matching TA-Lib conventions.
 */
export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const length = values.length;
  const result: MacdResult = {
    macd: new Float64Array(length).fill(Number.NaN),
    signal: new Float64Array(length).fill(Number.NaN),
    histogram: new Float64Array(length).fill(Number.NaN),
  };
  if (
    !Number.isInteger(fast) ||
    !Number.isInteger(slow) ||
    !Number.isInteger(signalPeriod) ||
    fast <= 0 ||
    slow <= 0 ||
    signalPeriod <= 0 ||
    length === 0
  ) {
    return result;
  }

  const prices = Float64Array.from(values);
  const fastEma = emaSeries(prices, fast);
  const slowEma = emaSeries(prices, slow);

  // The MACD line is defined where both EMAs are defined.
  const start = Math.max(fast, slow) - 1;
  if (start >= length) return result;
  for (let i = start; i < length; i += 1) {
    const fastValue = fastEma[i];
    const slowValue = slowEma[i];
    if (fastValue !== undefined && slowValue !== undefined) {
      result.macd[i] = fastValue - slowValue;
    }
  }

  // Signal line: EMA over the valid MACD tail, seeded with its simple average.
  const signalStart = start + signalPeriod - 1;
  if (signalStart >= length) return result;
  let seed = 0;
  for (let i = start; i <= signalStart; i += 1) seed += result.macd[i] ?? 0;
  let previous = seed / signalPeriod;
  result.signal[signalStart] = previous;

  const k = 2 / (signalPeriod + 1);
  for (let i = signalStart + 1; i < length; i += 1) {
    const value = result.macd[i];
    if (value === undefined || Number.isNaN(value)) break;
    previous += k * (value - previous);
    result.signal[i] = previous;
  }

  for (let i = signalStart; i < length; i += 1) {
    const line = result.macd[i];
    const signalLine = result.signal[i];
    if (line !== undefined && signalLine !== undefined) {
      result.histogram[i] = line - signalLine;
    }
  }
  return result;
}

/**
 * Wilder's Average True Range over `period` bars (default 14), computed from
 * high/low/close candles. True range is `high − low` for the first bar and
 * `max(high − low, |high − prevClose|, |low − prevClose|)` afterwards; the
 * first ATR is the simple average of the first `period` true ranges at index
 * `period − 1`, followed by Wilder smoothing. Inputs must be aligned and of
 * equal length — mismatched series yield an all-`NaN` result.
 */
export function atr(highs: number[], lows: number[], closes: number[], period = 14): Float64Array {
  const length = closes.length;
  const out = new Float64Array(length).fill(Number.NaN);
  if (
    !Number.isInteger(period) ||
    period <= 0 ||
    length < period ||
    highs.length !== length ||
    lows.length !== length ||
    length === 0
  ) {
    return out;
  }

  const high = Float64Array.from(highs);
  const low = Float64Array.from(lows);
  const close = Float64Array.from(closes);

  const trueRange = new Float64Array(length);
  trueRange[0] = (high[0] ?? 0) - (low[0] ?? 0);
  for (let i = 1; i < length; i += 1) {
    const prevClose = close[i - 1] ?? 0;
    const upMove = (high[i] ?? 0) - (low[i] ?? 0);
    const gapUp = Math.abs((high[i] ?? 0) - prevClose);
    const gapDown = Math.abs((low[i] ?? 0) - prevClose);
    trueRange[i] = Math.max(upMove, gapUp, gapDown);
  }

  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += trueRange[i] ?? 0;
  let previous = seed / period;
  out[period - 1] = previous;

  for (let i = period; i < length; i += 1) {
    previous = (previous * (period - 1) + (trueRange[i] ?? 0)) / period;
    out[i] = previous;
  }
  return out;
}
