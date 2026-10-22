/**
 * Pure, allocation-light risk math used by the backtester and the position
 * sizer. Every function iterates typed arrays only, so it can run either in
 * the finance Web Worker (alongside `computeBacktest`) or on the main thread
 * for the O(1) sizing helpers — never blocking renders with heavy loops.
 */

/** Fraction of capital risked per trade by default (2%). */
export const DEFAULT_RISK_PERCENT = 0.02;

/** Stop distance in ATRs; the Pine HUD's "ATR Trailing Stop Multiplier" defaults to it. */
export const DEFAULT_ATR_STOP_MULTIPLIER = 2;

/** Portfolio heat cap: Aggregate Open Risk may not exceed 6% of equity. */
export const MAX_PORTFOLIO_RISK_PERCENT = 0.06;

/** Annualization factor for daily equity curves (crypto trades every day). */
export const DAILY_PERIODS_PER_YEAR = 365;

/**
 * Maximum peak-to-trough drawdown of an equity curve as a positive fraction
 * in the 0–1 range (0.25 = a 25% drop from the highest peak). Non-finite
 * samples are skipped; a rising or single-point curve reports 0.
 */
export function maxDrawdown(values: Iterable<number>): number {
  let peak = Number.NEGATIVE_INFINITY;
  let worst = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
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
  /** Stop distance in ATRs (default 2, the Pine HUD's `atrStopMult`). */
  atrStopMult?: number;
  /**
   * Optional per-asset capital budget (e.g. the allocation amount from the
   * portfolio builder). When provided, the suggested notional never exceeds
   * `min(capital, allocatedCapital)` — the risk model can only shrink the
   * position below the budget, never grow it past it (M1-T2, F-1.2a).
   */
  allocatedCapital?: number;
}

export interface PositionSize {
  /** Share quantity `min(risk budget / stop distance, budget / price)`, 4dp. */
  shares: number;
  /** Requested Risk Budget: capital × riskPercent, before any cap. */
  requestedRisk: number;
  /**
   * Actual Planned Risk: what `shares` lose at the stop (post-cap, post-floor).
   * Below `requestedRisk` when the budget capped the size or the stop hit 0.
   */
  plannedRisk: number;
  /** Stop price `atrStopMult` ATRs below the entry price, floored at 0. */
  stopPrice: number;
  /** Dollar notional of the position (shares × price) — always ≤ the effective budget. */
  notional: number;
  /** True when the capital budget (not the risk model) bounded the size. */
  isCapped: boolean;
}

/**
 * ATR-based position sizing, the same contract as the Pine HUD:
 *
 *   q = min(Risk Budget / Stop Distance, Total Capital / Entry Price)
 *
 * with Risk Budget = capital × riskPercent and Stop Distance = atrStopMult × ATR,
 * so a stop-out loses at most the risk budget. Two hard constraints (M1-T2,
 * F-1.2a) bound the result:
 *   1. `shares × price` (notional) never exceeds `min(capital, allocatedCapital)`
 *      — low-volatility assets would otherwise recommend positions worth
 *      multiples of the available budget;
 *   2. the stop price is floored at 0 (a stop distance ≥ price can no longer
 *      produce a negative stop).
 * Shares round to 4 decimals (fractional-friendly app-wide precision); when
 * rounding would breach the budget invariant the quantity rounds DOWN instead.
 * Invalid inputs (non-positive capital, price, ATR or multiplier) size to zero.
 */
export function recommendPositionSize({
  capital,
  price,
  atr,
  riskPercent = DEFAULT_RISK_PERCENT,
  atrStopMult = DEFAULT_ATR_STOP_MULTIPLIER,
  allocatedCapital,
}: PositionSizeInput): PositionSize {
  const validCapital =
    Number.isFinite(capital) && capital > 0 && Number.isFinite(riskPercent) && riskPercent > 0;
  const requestedRisk = validCapital ? capital * riskPercent : 0;
  const stopDistance = atr * atrStopMult;
  const validMarket =
    Number.isFinite(price) &&
    price > 0 &&
    Number.isFinite(stopDistance) &&
    stopDistance > 0 &&
    requestedRisk > 0;

  if (!validMarket) {
    return {
      shares: 0,
      requestedRisk,
      plannedRisk: 0,
      stopPrice: 0,
      notional: 0,
      isCapped: false,
    };
  }

  const budget =
    allocatedCapital !== undefined && Number.isFinite(allocatedCapital) && allocatedCapital > 0
      ? Math.min(capital, allocatedCapital)
      : capital;

  const riskShares = requestedRisk / stopDistance;
  const budgetShares = budget / price;
  const isCapped = riskShares > budgetShares;

  const rawShares = Math.min(riskShares, budgetShares);
  let shares = Number(rawShares.toFixed(4));
  // Rounding to 4dp can push the notional epsilon-levels over the budget;
  // round the raw quantity DOWN in that case so `shares × price ≤ budget` holds.
  if (shares * price > budget) {
    shares = Math.floor(rawShares * 10000) / 10000;
  }
  const stopPrice = Math.max(0, Number((price - stopDistance).toFixed(6)));

  return {
    shares,
    requestedRisk,
    plannedRisk: aggregateOpenRisk([{ shares, buyPrice: price, stopPrice }]),
    stopPrice,
    notional: Number((shares * price).toFixed(2)),
    isCapped,
  };
}

export interface OpenPositionRisk {
  shares: number;
  /** Entry (average buy) price. */
  buyPrice: number;
  /** Protective stop. Missing or 0 means the whole entry is at risk. */
  stopPrice?: number | null | undefined;
}

/**
 * Aggregate Open Risk: Σ (entry − stop) × quantity, what the positions lose
 * if every one of them hits its stop at once. Stops floor at 0, so a position
 * with no known stop risks its whole entry; a stop at or above entry risks 0.
 */
export function aggregateOpenRisk(positions: Iterable<OpenPositionRisk>): number {
  let total = 0;
  for (const { shares, buyPrice, stopPrice } of positions) {
    const stop = typeof stopPrice === 'number' && stopPrice > 0 ? stopPrice : 0;
    total += Math.max(0, buyPrice - stop) * shares;
  }
  return total;
}

/** What a portfolio can still take on. */
export interface RiskBook {
  /** Total portfolio equity: cash plus marked positions. */
  equity: number;
  /** Free cash a new entry can spend. */
  cash: number;
  /** Aggregate Open Risk of the positions already held. */
  openRisk: number;
}

export interface EntryOrder {
  shares: number;
  price: number;
  fee: number;
  stopPrice?: number | null | undefined;
}

export type EntryCheck = { ok: true } | { ok: false; reason: string };

const usd = (value: number) =>
  value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const percent = (fraction: number) =>
  fraction.toLocaleString('en-US', { style: 'percent', maximumFractionDigits: 1 });

/**
 * The portfolio risk manager's pre-trade gate for a new entry (a BUY). Denies it when
 *   1. its cost (notional + fee) is more than the free cash, or
 *   2. Aggregate Open Risk plus the order's own (entry − stop) × quantity would
 *      exceed `maxRiskPercent` of equity.
 * Sells only shrink exposure and never need it.
 */
export function checkNewEntry(
  book: RiskBook,
  order: EntryOrder,
  maxRiskPercent = MAX_PORTFOLIO_RISK_PERCENT,
): EntryCheck {
  const cost = order.shares * order.price + order.fee;
  if (cost > book.cash) {
    return {
      ok: false,
      reason: `Not enough cash: this order needs ${usd(cost)}, ${usd(book.cash)} available.`,
    };
  }
  const planned = aggregateOpenRisk([{ ...order, buyPrice: order.price }]);
  if (book.openRisk + planned > book.equity * maxRiskPercent) {
    return {
      ok: false,
      reason: `Portfolio max risk reached: ${percent(book.openRisk / book.equity)} open + ${percent(
        planned / book.equity,
      )} new would pass the ${percent(maxRiskPercent)} limit.`,
    };
  }
  return { ok: true };
}

/** Formats a share quantity for display, trimming to sensible precision. */
export function formatShares(shares: number): string {
  if (!Number.isFinite(shares) || shares <= 0) return '—';
  let decimals = 4;
  if (shares >= 100) decimals = 1;
  else if (shares >= 1) decimals = 2;
  return Number(shares.toFixed(decimals)).toLocaleString('en-US', {
    maximumFractionDigits: 4,
  });
}
