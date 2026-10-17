import type { Asset } from '@/lib/assets';
import type { Position } from '@/lib/portfolioManager';
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
 * Basic transaction-cost model applied as a one-time entry drag on invested
 * capital (M1-T3, F-2.1c): shares bought at `price × (1 − fee − slippage)`.
 * Defaults match the app's display fee (25 bps, cf. TradeTicket) plus a 10 bps
 * slippage assumption; pass `{ feeRate: 0, slippageRate: 0 }` for gross curves.
 */
export interface BacktestCostModel {
  /** Fraction of notional charged by the venue (0.0025 = 25 bps). */
  feeRate: number;
  /** Fraction lost to slippage on fills (0.001 = 10 bps). */
  slippageRate: number;
}

export const DEFAULT_BACKTEST_COST_MODEL: BacktestCostModel = {
  feeRate: 0.0025,
  slippageRate: 0.001,
};

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

/**
 * Simulates a buy-and-hold portfolio over a shared timeline of historical
 * daily prices. Each covered asset grows by `price(t) / price(first)`, scaled
 * by its weight and the initial investment. Assets with weight but no usable
 * history are EXCLUDED and their weight is held as cash, with per-ticker
 * coverage reported on the result — never silently modeled at flat prices
 * (M1-T3, F-2.1a/b). Optional transaction costs and slippage are applied as a
 * one-time entry drag on the invested sleeve (M1-T3, F-2.1c). The compounding
 * loops run over `Float64Array` for predictable, allocation-light execution.
 */
export function computeBacktest({
  weights,
  series,
  initialValue = DEFAULT_INITIAL_VALUE,
  costModel,
}: {
  weights: AllocationWeight[];
  series: AssetPriceSeries[];
  initialValue?: number;
  costModel?: BacktestCostModel;
}): BacktestResult {
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

  // Entry costs: buying costs shares, so the invested sleeve starts at
  // (1 − fee − slippage) of its notional. Invalid rates are ignored.
  const rate = (value: number | undefined) =>
    value !== undefined && Number.isFinite(value) && value >= 0 ? value : 0;
  const costFactor = Math.max(0, 1 - rate(costModel?.feeRate) - rate(costModel?.slippageRate));

  const timestamps = new Set<number>();
  for (const [ticker, points] of seriesByTicker) {
    if ((weightByTicker.get(ticker) ?? 0) > 0) {
      for (const point of points) timestamps.add(point.timestamp);
    }
  }
  const timeline = [...timestamps].sort((a, b) => a - b);

  // Covered tickers only — missing weight already lives in `cashWeight`.
  const tickers = coverage
    .filter((entry) => entry.status === 'covered')
    .map((entry) => entry.ticker);
  const weightValues = Float64Array.from(tickers.map((ticker) => weightByTicker.get(ticker) ?? 0));

  // Precompute each covered asset's forward-filled growth factors on the timeline.
  const factorSeries = tickers.map((ticker) => {
    const factors = new Float64Array(timeline.length).fill(1);
    const points = seriesByTicker.get(ticker);
    if (!points || points.length === 0) return factors;

    const first = points[0];
    const base = first && first.price > 0 ? first.price : 1;
    let cursor = 0;
    let lastClose = base;
    for (let i = 0; i < timeline.length; i += 1) {
      const time = timeline[i] ?? 0;
      while (
        cursor < points.length &&
        (points[cursor]?.timestamp ?? Number.POSITIVE_INFINITY) <= time
      ) {
        lastClose = points[cursor]?.price ?? lastClose;
        cursor += 1;
      }
      factors[i] = lastClose / base;
    }
    return factors;
  });

  const values = new Float64Array(timeline.length);
  for (let i = 0; i < timeline.length; i += 1) {
    let value = cashWeight * initialValue;
    for (let j = 0; j < tickers.length; j += 1) {
      const factors = factorSeries[j];
      value +=
        (weightValues[j] ?? 0) * initialValue * costFactor * (factors ? (factors[i] ?? 1) : 1);
    }
    values[i] = value;
  }

  const points: BacktestPoint[] = timeline.map((timestamp, index) => ({
    timestamp,
    value: values[index] ?? initialValue,
  }));

  const lastPoint = points[points.length - 1];
  const finalValue = lastPoint ? lastPoint.value : initialValue;
  const totalReturnPercent = initialValue > 0 ? (finalValue / initialValue - 1) * 100 : 0;

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
  };
}
