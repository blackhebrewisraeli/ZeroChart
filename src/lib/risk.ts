/**
 * Pure, allocation-light risk math used by the backtester and the position
 * sizer. Every function iterates typed arrays only, so it can run either in
 * the finance Web Worker (alongside `computeBacktest`) or on the main thread
 * for the O(1) sizing helpers — never blocking renders with heavy loops.
 */

/** Fraction of capital risked per trade by default (2%). */
export const DEFAULT_RISK_PERCENT = 0.02;

/** Annualization factor for daily equity curves (crypto trades every day). */
export const DAILY_PERIODS_PER_YEAR = 365;

/**
 * Maximum peak-to-trough drawdown of an equity curve as a positive fraction
 * in the 0–1 range (0.25 = a 25% drop from the highest peak). Non-finite
 * samples are skipped; a rising or single-point curve reports 0.
 */
export function maxDrawdown(values: ArrayLike<number>): number {
  let peak = Number.NEGATIVE_INFINITY;
  let worst = 0;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value === undefined || !Number.isFinite(value)) continue;
    if (value > peak) peak = value;
    if (peak <= 0) continue;
    const drop = (peak - value) / peak;
    if (drop > worst) worst = drop;
  }
  return Math.min(1, Math.max(0, worst));
}

/**
 * Simplified, annualized Sharpe ratio from an equity curve: the mean of
 * period-over-period returns divided by their standard deviation, scaled by
 * √periodsPerYear. The risk-free rate is assumed to be 0 and flat curves
 * (zero variance) report 0 so they never produce a divide-by-zero spike.
 */
export function sharpeRatio(
  values: ArrayLike<number>,
  periodsPerYear = DAILY_PERIODS_PER_YEAR,
): number {
  const count = values.length;
  if (count < 3 || !Number.isFinite(periodsPerYear) || periodsPerYear <= 0) return 0;

  const returns: number[] = [];
  let previous = values[0];
  for (let i = 1; i < count; i += 1) {
    const value = values[i];
    if (value === undefined || !Number.isFinite(value)) continue;
    if (previous === undefined || !Number.isFinite(previous) || previous <= 0) {
      previous = value;
      continue;
    }
    returns.push(value / previous - 1);
    previous = value;
  }
  if (returns.length < 2) return 0;

  let mean = 0;
  for (const value of returns) mean += value;
  mean /= returns.length;

  let variance = 0;
  for (const value of returns) variance += (value - mean) * (value - mean);
  variance /= returns.length;

  const stdDev = Math.sqrt(variance);
  if (!Number.isFinite(stdDev) || stdDev === 0) return 0;
  return (mean / stdDev) * Math.sqrt(periodsPerYear);
}

export interface PositionSizeInput {
  /** Total trading capital in USD. */
  capital: number;
  /** Current asset price. */
  price: number;
  /** Current ATR (14) in price units. */
  atr: number;
  /** Fraction of capital to risk on the trade (default 2%). */
  riskPercent?: number;
}

export interface PositionSize {
  /** Share quantity that risks exactly `capital × riskPercent` on a 1×ATR stop. */
  shares: number;
  /** Dollar amount at risk (capital × riskPercent). */
  riskAmount: number;
  /** Stop price one ATR below the entry price. */
  stopPrice: number;
  /** Dollar notional of the position (shares × price). */
  notional: number;
}

/**
 * ATR-based position sizing: a move of one ATR against the trade must lose
 * exactly `riskPercent` of capital, so shares = (capital × riskPercent) / ATR.
 * The result is rounded to 4 decimals (the app's share precision); invalid
 * inputs (non-positive capital, price, or ATR) size to zero instead of
 * oversizing the trade.
 */
export function recommendPositionSize({
  capital,
  price,
  atr,
  riskPercent = DEFAULT_RISK_PERCENT,
}: PositionSizeInput): PositionSize {
  const validCapital =
    Number.isFinite(capital) && capital > 0 && Number.isFinite(riskPercent) && riskPercent > 0;
  const riskAmount = validCapital ? capital * riskPercent : 0;
  const validMarket =
    Number.isFinite(price) && price > 0 && Number.isFinite(atr) && atr > 0 && riskAmount > 0;

  const shares = validMarket ? Number((riskAmount / atr).toFixed(4)) : 0;
  return {
    shares,
    riskAmount,
    stopPrice: validMarket ? Number((price - atr).toFixed(6)) : 0,
    notional: validMarket ? Number((shares * price).toFixed(2)) : 0,
  };
}

/** Formats a share quantity for display, trimming to sensible precision. */
export function formatShares(shares: number): string {
  if (!Number.isFinite(shares) || shares <= 0) return '—';
  const decimals = shares >= 100 ? 1 : shares >= 1 ? 2 : 4;
  return Number(shares.toFixed(decimals)).toLocaleString('en-US', {
    maximumFractionDigits: 4,
  });
}
