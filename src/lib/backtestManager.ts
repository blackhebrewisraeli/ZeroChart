import type { Asset } from '@/lib/assets';
import type { Position } from '@/lib/portfolioManager';
import { atr } from '@/lib/indicators';
import { maxDrawdown, sharpeRatio } from '@/lib/risk';

/**
 * Pure, testable backtesting utilities. This module intentionally avoids any
 * network or storage side effects so the portfolio math can be verified in
 * isolation — it only consumes allocation weights and historical price series.
 */

export interface PricePoint {
  /** Open time in milliseconds since epoch. */
  timestamp: number;
  /** Closing price for the day. */
  price: number;
  /** Bar high/low — when every point has both, trailing stops can use ATR(14). */
  high?: number;
  low?: number;
}

export interface AssetPriceSeries {
  ticker: string;
  points: PricePoint[];
}

export interface AllocationWeight {
  ticker: string;
  /** Fraction of the portfolio (0–1). */
  weight: number;
}

export interface BacktestPoint {
  timestamp: number;
  value: number;
}

/** Per-ticker data coverage of the weighted universe (M1-T3, F-2.1a/b). */
export type TickerCoverageStatus =
  /** Backed by a usable historical series. */
  | 'covered'
  /** Weighted but no usable history — excluded from the curve and held as cash. */
  | 'missing';

export interface TickerCoverage {
  ticker: string;
  /** Portfolio weight (0–1) this ticker carried before coverage filtering. */
  weight: number;
  status: TickerCoverageStatus;
}

/**
 * Legacy transaction-cost model applied as a one-time entry drag on invested
 * capital (M1-T3, F-2.1c): shares bought at `price × (1 − fee − slippage)`.
 * Prefer `feeBps` / `slippageBps`, which charge every fill (entry and exit).
 */
export interface BacktestCostModel {
  /** Fraction of notional charged by the venue (0.0025 = 25 bps). */
  feeRate: number;
  /** Fraction lost to slippage on fills (0.001 = 10 bps). */
  slippageRate: number;
}

/** "Realistic Friction" preset: 10 bps venue fee + 5 bps slippage per fill. */
export const REALISTIC_FRICTION = { feeBps: 10, slippageBps: 5 } as const;

/** Percent trailing stop used when ATR can't be computed (no HLC, or warm-up). */
export const DEFAULT_TRAILING_STOP_PCT = 5;

const ATR_PERIOD = 14;

export interface BacktestOptions {
  weights: AllocationWeight[];
  series: AssetPriceSeries[];
  initialValue?: number;
  /** Legacy entry-only drag; stacks with `feeBps` / `slippageBps` on the first fill. */
  costModel?: BacktestCostModel;
  /** Venue fee on every fill — entry, stop exit, re-entry, final liquidation. Default 0. */
  feeBps?: number;
  /** Slippage on every fill, in bps. Default 0. */
  slippageBps?: number;
  /**
   * Trailing stop `multiplier × ATR(14)` below the peak close since entry.
   * Bars without ATR (series lacking high/low, or warm-up) fall back to
   * `trailingStopPct ?? DEFAULT_TRAILING_STOP_PCT`.
   */
  trailingStopAtrMultiplier?: number;
  /** Trailing stop as a percent of the peak close since entry (5 = 5%). */
  trailingStopPct?: number;
}

export interface BacktestResult {
  points: BacktestPoint[];
  initialValue: number;
  finalValue: number;
  totalReturnPercent: number;
  /** Largest peak-to-trough decline of the equity curve (0–100, positive). */
  maxDrawdownPercent: number;
  /**
   * Simplified annualized Sharpe ratio of the equity curve (risk-free = 0).
   * When `coverageWeight < 1`, the curve includes a cash sleeve for missing
   * history, so volatility/drawdown are diluted — read alongside coverage.
   */
  sharpeRatio: number;
  /**
   * Fraction (0–1) of the total weight backed by real price history. Missing
   * weight is excluded from the equity curve and held as cash (identical
   * arithmetic to a flat line, but explicitly flagged instead of silent).
   */
  coverageWeight: number;
  /** Per-ticker coverage of every positive-weight ticker in the run. */
  coverage: TickerCoverage[];
  /** Buy-and-hold return of the same weights and timeline, same friction, no stop. */
  benchmarkReturnPct: number;
  /** Excess return over buy-and-hold: `totalReturnPercent − benchmarkReturnPct`. */
  alphaPct: number;
  /** Share (0–100) of closed round trips that were profitable net of friction. */
  winRatePct: number;
  /** Round trips closed by a stop exit or by the end-of-period liquidation. */
  totalTrades: number;
  /** Buy-and-hold equity on the same timestamps and principal as `points`. */
  benchmarkCurve: BacktestPoint[];
}

const DEFAULT_INITIAL_VALUE = 10000;

/**
 * Derives allocation weights from the current portfolio by valuing each held
 * ticker at its live price (falling back to buy price), then dividing by the
 * total market value. Multiple lots of the same ticker are aggregated.
 */
export function deriveWeights(positions: Position[], assets: Asset[]): AllocationWeight[] {
  const priceByTicker = new Map<string, number>();
  for (const asset of assets) {
    if (
      asset.current_price !== null &&
      Number.isFinite(asset.current_price) &&
      asset.current_price > 0
    ) {
      priceByTicker.set(asset.ticker, asset.current_price);
    }
  }

  const valueByTicker = new Map<string, number>();
  for (const position of positions) {
    const price = priceByTicker.get(position.ticker) ?? position.buyPrice;
    const value = price * position.shares;
    valueByTicker.set(position.ticker, (valueByTicker.get(position.ticker) ?? 0) + value);
  }

  const total = [...valueByTicker.values()].reduce((sum, value) => sum + value, 0);
  if (total <= 0) return [];

  return [...valueByTicker.entries()].map(([ticker, value]) => ({
    ticker,
    weight: value / total,
  }));
}

interface TrailingStop {
  /** Per-bar `multiplier × ATR` on the timeline; NaN where ATR is unavailable. */
  atrDistance: Float64Array | null;
  /** Fallback stop distance as a fraction of the reference close. */
  fraction: number;
}

/**
 * Runs one asset sleeve over its forward-filled timeline closes. Without a
 * stop it is plain buy-and-hold. With one, the sleeve goes to cash when the
 * close breaks `peak − distance` and re-enters when it recovers to
 * `trough + distance` (symmetric trailing re-entry), so a single dip doesn't
 * park the sleeve in cash for the rest of the period. Holdings are marked at
 * liquidation value (net of exit friction), so the last point is the
 * realized final value and an open trade is closed there.
 */
function simulateSleeve(
  closes: Float64Array,
  capital: number,
  entryFactor: number,
  fillFactor: number,
  stop: TrailingStop | null,
): { values: Float64Array; trades: number; wins: number } {
  const values = new Float64Array(closes.length);
  let long = true;
  let shares = (capital * entryFactor) / (closes[0] ?? 1);
  let cash = 0;
  let committed = capital; // cash put into the open trade, before costs
  let ref = closes[0] ?? 0; // peak close while long, trough close while flat
  let trades = 0;
  let wins = 0;

  for (let i = 0; i < closes.length; i += 1) {
    const price = closes[i] ?? 0;
    if (stop) {
      ref = long ? Math.max(ref, price) : Math.min(ref, price);
      const atrDistance = stop.atrDistance?.[i] ?? Number.NaN;
      const distance = Number.isFinite(atrDistance) ? atrDistance : ref * stop.fraction;
      if (long && price < ref - distance) {
        cash = shares * price * fillFactor;
        trades += 1;
        if (cash > committed) wins += 1;
        long = false;
        shares = 0;
        ref = price;
      } else if (!long && price > ref + distance) {
        committed = cash;
        shares = (cash * fillFactor) / price;
        cash = 0;
        long = true;
        ref = price;
      }
    }
    values[i] = long ? shares * price * fillFactor : cash;
  }

  if (long && closes.length > 0) {
    trades += 1;
    if ((values[closes.length - 1] ?? 0) > committed) wins += 1;
  }
  return { values, trades, wins };
}

/**
 * Simulates the current allocation over a shared timeline of historical daily
 * prices. Each covered asset is bought at its first close with its weight of
 * the initial investment. Assets with weight but no usable history are
 * EXCLUDED and their weight is held as cash, with per-ticker coverage
 * reported on the result — never silently modeled at flat prices (M1-T3,
 * F-2.1a/b). Friction (`feeBps` + `slippageBps`) is charged on every fill;
 * the legacy `costModel` adds a one-time entry drag (F-2.1c). An optional
 * trailing stop (ATR or percent) turns the run into an active strategy that
 * is compared against plain buy-and-hold of the same weights with the same
 * friction (`benchmarkCurve`, `alphaPct`). The loops run over `Float64Array`
 * for predictable, allocation-light execution inside the finance worker.
 */
export function computeBacktest({
  weights,
  series,
  initialValue = DEFAULT_INITIAL_VALUE,
  costModel,
  feeBps,
  slippageBps,
  trailingStopAtrMultiplier,
  trailingStopPct,
}: BacktestOptions): BacktestResult {
  const weightByTicker = new Map<string, number>();
  for (const item of weights) {
    if (!Number.isFinite(item.weight) || item.weight <= 0) continue;
    weightByTicker.set(item.ticker, (weightByTicker.get(item.ticker) ?? 0) + item.weight);
  }

  const seriesByTicker = new Map<string, PricePoint[]>();
  for (const item of series) {
    const points = item.points
      .filter((point) => Number.isFinite(point.price) && point.price > 0)
      .sort((a, b) => a.timestamp - b.timestamp);
    if (points.length > 0) seriesByTicker.set(item.ticker, points);
  }

  // Coverage audit: every weighted ticker is covered (usable series) or
  // missing (excluded, held as cash) — surfaced on the result, never silent.
  const coverage: TickerCoverage[] = [];
  let coveredWeight = 0;
  for (const [ticker, weight] of weightByTicker) {
    const covered = (seriesByTicker.get(ticker)?.length ?? 0) > 0;
    if (covered) coveredWeight += weight;
    coverage.push({ ticker, weight, status: covered ? 'covered' : 'missing' });
  }
  const cashWeight = Math.max(0, 1 - coveredWeight);

  // Friction: every fill pays (fee + slippage) bps; the legacy cost model adds
  // a one-time drag on the first entry. Invalid inputs are ignored.
  const rate = (value: number | undefined) =>
    value !== undefined && Number.isFinite(value) && value >= 0 ? value : 0;
  const perFill = (rate(feeBps) + rate(slippageBps)) / 10000;
  const fillFactor = Math.max(0, 1 - perFill);
  const entryFactor = Math.max(
    0,
    1 - rate(costModel?.feeRate) - rate(costModel?.slippageRate) - perFill,
  );

  const positive = (value: number | undefined) =>
    value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
  const atrMultiplier = positive(trailingStopAtrMultiplier);
  const stopPct = positive(trailingStopPct);
  const stopEnabled = atrMultiplier > 0 || stopPct > 0;
  const stopFraction = (stopPct || DEFAULT_TRAILING_STOP_PCT) / 100;

  const timestamps = new Set<number>();
  for (const [ticker, points] of seriesByTicker) {
    if ((weightByTicker.get(ticker) ?? 0) > 0) {
      for (const point of points) timestamps.add(point.timestamp);
    }
  }
  const timeline = [...timestamps].sort((a, b) => a - b);

  // Strategy and buy-and-hold benchmark share the cash sleeve for missing weight.
  const cash = cashWeight * initialValue;
  const values = new Float64Array(timeline.length).fill(cash);
  const benchmark = new Float64Array(timeline.length).fill(cash);
  let totalTrades = 0;
  let wins = 0;

  // Covered tickers only — missing weight already lives in `cashWeight`.
  for (const entry of coverage) {
    if (entry.status !== 'covered') continue;
    const points = seriesByTicker.get(entry.ticker) ?? [];

    // ATR needs a full HLC series; otherwise the stop uses the percent fallback.
    const hasHlc =
      atrMultiplier > 0 &&
      points.every((point) => Number.isFinite(point.high) && Number.isFinite(point.low));
    const atrValues = hasHlc
      ? atr(
          points.map((point) => point.high ?? point.price),
          points.map((point) => point.low ?? point.price),
          points.map((point) => point.price),
          ATR_PERIOD,
        )
      : null;

    // Forward-fill closes (and ATR) onto the shared timeline; before its first
    // print the sleeve sits at its entry close, i.e. flat at notional.
    const closes = new Float64Array(timeline.length);
    const atrDistance = atrValues ? new Float64Array(timeline.length) : null;
    let cursor = 0;
    let lastClose = points[0]?.price ?? 1;
    let lastAtr = Number.NaN;
    for (let i = 0; i < timeline.length; i += 1) {
      const time = timeline[i] ?? 0;
      while (
        cursor < points.length &&
        (points[cursor]?.timestamp ?? Number.POSITIVE_INFINITY) <= time
      ) {
        lastClose = points[cursor]?.price ?? lastClose;
        lastAtr = atrValues?.[cursor] ?? Number.NaN;
        cursor += 1;
      }
      closes[i] = lastClose;
      if (atrDistance) atrDistance[i] = lastAtr * atrMultiplier;
    }

    const capital = entry.weight * initialValue;
    const held = simulateSleeve(closes, capital, entryFactor, fillFactor, null);
    const run = stopEnabled
      ? simulateSleeve(closes, capital, entryFactor, fillFactor, {
          atrDistance,
          fraction: stopFraction,
        })
      : held;
    for (let i = 0; i < timeline.length; i += 1) {
      values[i] = (values[i] ?? 0) + (run.values[i] ?? 0);
      benchmark[i] = (benchmark[i] ?? 0) + (held.values[i] ?? 0);
    }
    totalTrades += run.trades;
    wins += run.wins;
  }

  const toPoints = (curve: Float64Array): BacktestPoint[] =>
    timeline.map((timestamp, index) => ({ timestamp, value: curve[index] ?? initialValue }));
  const finalOf = (curve: Float64Array) =>
    curve.length > 0 ? (curve[curve.length - 1] ?? initialValue) : initialValue;
  const returnOf = (final: number) => (initialValue > 0 ? (final / initialValue - 1) * 100 : 0);

  const points = toPoints(values);
  const finalValue = finalOf(values);
  const totalReturnPercent = returnOf(finalValue);
  const benchmarkReturnPct = returnOf(finalOf(benchmark));

  // Risk metrics over the equity curve — computed here so they ride the same
  // worker-backed `computeBacktest` request instead of a main-thread pass.
  const maxDrawdownPercent = maxDrawdown(values) * 100;
  const sharpe = sharpeRatio(values);

  return {
    points,
    initialValue,
    finalValue,
    totalReturnPercent,
    maxDrawdownPercent,
    sharpeRatio: sharpe,
    coverageWeight: coveredWeight,
    coverage,
    benchmarkReturnPct,
    alphaPct: totalReturnPercent - benchmarkReturnPct,
    winRatePct: totalTrades > 0 ? (wins / totalTrades) * 100 : 0,
    totalTrades,
    benchmarkCurve: toPoints(benchmark),
  };
}
