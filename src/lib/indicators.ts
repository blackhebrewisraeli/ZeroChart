/**
 * Pure technical-indicator math over a close-price series. Every function
 * returns an array aligned to the input length, using `null` for the warm-up
 * period where the indicator is not yet defined. Keeping this free of chart and
 * React dependencies makes it trivially unit-testable.
 */

/** Simple Moving Average over `period` bars. */
export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(values.length).fill(null);
  if (!Number.isInteger(period) || period <= 0 || values.length < period) return out;

  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (typeof value !== 'number') continue;
    sum += value;
    if (i >= period) {
      const drop = values[i - period];
      if (typeof drop === 'number') sum -= drop;
    }
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Wilder's Relative Strength Index over `period` bars (default 14).
 * The first value is available at index `period` (one change earlier than SMA).
 */
export function rsi(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(values.length).fill(null);
  if (!Number.isInteger(period) || period <= 0 || values.length <= period) return out;

  let avgGain = 0;
  let avgLoss = 0;

  // Seed with the simple average of the first `period` price changes.
  for (let i = 1; i <= period; i += 1) {
    const current = values[i];
    const previous = values[i - 1];
    if (typeof current !== 'number' || typeof previous !== 'number') continue;
    const change = current - previous;
    if (change >= 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = rsiValue(avgGain, avgLoss);

  // Wilder smoothing for the remaining bars.
  for (let i = period + 1; i < values.length; i += 1) {
    const current = values[i];
    const previous = values[i - 1];
    if (typeof current !== 'number' || typeof previous !== 'number') continue;
    const change = current - previous;
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
