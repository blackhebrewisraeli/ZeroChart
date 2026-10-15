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
 * Returns the growth factor for a single asset at a given timestamp: the last
 * known close on or before `timestamp`, divided by the asset's first close.
 * Timestamps before the first data point use the first close (factor 1).
 */
function growthFactor(sortedPoints: PricePoint[], timestamp: number): number {
  const first = sortedPoints[0];
  if (!first || first.price <= 0) return 1;

  let lastClose = first.price;
  for (const point of sortedPoints) {
    if (point.timestamp <= timestamp) {
      lastClose = point.price;
    } else {
      break;
    }
  }
  return lastClose / first.price;
}

/**
 * Simulates a buy-and-hold portfolio over a shared timeline of historical
 * daily prices. Each asset grows by `price(t) / price(first)`, scaled by its
 * weight and the initial investment. Assets without a price series are held
 * flat, and any weight not allocated to an asset is held as flat cash.
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

  const points: BacktestPoint[] = timeline.map((timestamp) => {
    let value = cashWeight * initialValue;
    for (const [ticker, weight] of weightByTicker) {
      const assetPoints = seriesByTicker.get(ticker);
      const factor = assetPoints ? growthFactor(assetPoints, timestamp) : 1;
      value += weight * initialValue * factor;
    }
    return { timestamp, value };
  });

  const lastPoint = points[points.length - 1];
  const finalValue = lastPoint ? lastPoint.value : initialValue;
  const totalReturnPercent = initialValue > 0 ? (finalValue / initialValue - 1) * 100 : 0;

  return { points, initialValue, finalValue, totalReturnPercent };
}
