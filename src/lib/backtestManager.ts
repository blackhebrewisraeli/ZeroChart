import type { Asset } from '@/lib/assets';
import type { Position } from '@/lib/portfolioManager';

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

export interface BacktestResult {
  points: BacktestPoint[];
  initialValue: number;
  finalValue: number;
  totalReturnPercent: number;
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
 * daily prices. Each asset grows by `price(t) / price(first)`, scaled by its
 * weight and the initial investment. The compounding loops run over
 * `Float64Array` for predictable, allocation-light execution.
 */
export function computeBacktest({
  weights,
  series,
  initialValue = DEFAULT_INITIAL_VALUE,
}: {
  weights: AllocationWeight[];
  series: AssetPriceSeries[];
  initialValue?: number;
}): BacktestResult {
  const weightByTicker = new Map<string, number>();
  let totalWeight = 0;
  for (const item of weights) {
    if (!Number.isFinite(item.weight) || item.weight <= 0) continue;
    weightByTicker.set(item.ticker, (weightByTicker.get(item.ticker) ?? 0) + item.weight);
    totalWeight += item.weight;
  }

  const seriesByTicker = new Map<string, PricePoint[]>();
  for (const item of series) {
    const points = item.points
      .filter((point) => Number.isFinite(point.price) && point.price > 0)
      .sort((a, b) => a.timestamp - b.timestamp);
    if (points.length > 0) seriesByTicker.set(item.ticker, points);
  }

  const timestamps = new Set<number>();
  for (const points of seriesByTicker.values()) {
    for (const point of points) timestamps.add(point.timestamp);
  }
  const timeline = [...timestamps].sort((a, b) => a - b);
  const cashWeight = Math.max(0, 1 - totalWeight);

  const tickers = [...weightByTicker.keys()];
  const weightValues = Float64Array.from(tickers.map((ticker) => weightByTicker.get(ticker) ?? 0));

  // Precompute each asset's forward-filled growth factors aligned to the timeline.
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
      value += (weightValues[j] ?? 0) * initialValue * (factors ? (factors[i] ?? 1) : 1);
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

  return { points, initialValue, finalValue, totalReturnPercent };
}
