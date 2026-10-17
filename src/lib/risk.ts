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
  /**
   * Optional per-asset capital budget (e.g. the allocation amount from the
   * portfolio builder). When provided, the suggested notional never exceeds
   * `min(capital, allocatedCapital)` — the risk model can only shrink the
   * position below the budget, never grow it past it (M1-T2, F-1.2a).
   */
  allocatedCapital?: number;
}

export interface PositionSize {
  /** Share quantity that risks exactly `capital × riskPercent` on a 1×ATR stop, budget-capped. */
  shares: number;
  /** Dollar amount at risk (capital × riskPercent). */
  riskAmount: number;
  /** Stop price one ATR below the entry price, floored at 0. */
  stopPrice: number;
  /** Dollar notional of the position (shares × price) — always ≤ the effective budget. */
  notional: number;
  /** True when the capital budget (not the risk model) bounded the size. */
  isCapped: boolean;
}

/**
 * ATR-based position sizing: a move of one ATR against the trade must lose
 * `riskPercent` of capital, so the risk-optimal quantity is
 * `shares = (capital × riskPercent) / ATR`. Two hard constraints (M1-T2,
 * F-1.2a) bound the result:
 *   1. `shares × price` (notional) never exceeds `min(capital, allocatedCapital)`
 *      — low-volatility assets (ATR/price < riskPercent) would otherwise
 *      recommend positions worth multiples of the available budget;
 *   2. the stop price is floored at 0 (ATR ≥ price can no longer produce a
 *      negative stop).
 * Shares round to 4 decimals (fractional-friendly app-wide precision); when
 * rounding would breach the budget invariant the quantity rounds DOWN instead.
 * Invalid inputs (non-positive capital, price, or ATR) size to zero.
 */
export function recommendPositionSize({
  capital,
  price,
  atr,
  riskPercent = DEFAULT_RISK_PERCENT,
  allocatedCapital,
}: PositionSizeInput): PositionSize {
  const validCapital =
    Number.isFinite(capital) && capital > 0 && Number.isFinite(riskPercent) && riskPercent > 0;
  const riskAmount = validCapital ? capital * riskPercent : 0;
  const validMarket =
    Number.isFinite(price) && price > 0 && Number.isFinite(atr) && atr > 0 && riskAmount > 0;

  if (!validMarket) {
    return { shares: 0, riskAmount, stopPrice: 0, notional: 0, isCapped: false };
  }

  const budget =
    allocatedCapital !== undefined && Number.isFinite(allocatedCapital) && allocatedCapital > 0
      ? Math.min(capital, allocatedCapital)
      : capital;

  const riskShares = riskAmount / atr;
  const budgetShares = budget / price;
  const isCapped = riskShares > budgetShares;

  const rawShares = Math.min(riskShares, budgetShares);
  let shares = Number(rawShares.toFixed(4));
  // Rounding to 4dp can push the notional epsilon-levels over the budget;
  // round the raw quantity DOWN in that case so `shares × price ≤ budget` holds.
  if (shares * price > budget) {
    shares = Math.floor(rawShares * 10000) / 10000;
  }

  return {
    shares,
    riskAmount,
    stopPrice: Math.max(0, Number((price - atr).toFixed(6))),
    notional: Number((shares * price).toFixed(2)),
    isCapped,
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
