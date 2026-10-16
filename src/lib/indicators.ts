/**
 * Pure technical-indicator math over a close-price series. Every function
 * returns a `Float64Array` aligned to the input length, using `NaN` for the
 * warm-up period where the indicator is not yet defined. The hot loops run over
 * typed arrays for predictable, allocation-light execution.
 */

/** Simple Moving Average over `period` bars. */
export function sma(values: number[], period: number): Float64Array {
  const out = new Float64Array(values.length).fill(NaN);
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
  const out = new Float64Array(values.length).fill(NaN);
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
