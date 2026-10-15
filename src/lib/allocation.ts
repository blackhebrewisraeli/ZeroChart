import type { Asset } from '@/lib/assets';
import type { Position } from '@/lib/portfolioManager';

export const ALLOCATION_PALETTE: string[] = [
  '#00E5FF',
  '#6366F1',
  '#22D3EE',
  '#64748B',
  '#0EA5E9',
  '#818CF8',
  '#14B8A6',
  '#38BDF8',
];

export interface AllocationSlice {
  ticker: string;
  /** Current total holding value in USD: (live price ?? buy price) × shares. */
  value: number;
  /** Percentage of the total portfolio value (0–100). */
  percent: number;
  color: string;
}

/**
 * Builds the data model for the allocation donut. Each holding is valued at its
 * live price (falling back to buy price), aggregated by ticker, and converted
 * into a percentage of the total. Slices are sorted largest-first and assigned
 * a deterministic palette color so the legend and the pie always agree.
 */
export function computeAllocation(positions: Position[], assets: Asset[]): AllocationSlice[] {
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
  let total = 0;
  for (const position of positions) {
    const price = priceByTicker.get(position.ticker) ?? position.buyPrice;
    const value = price * position.shares;
    valueByTicker.set(position.ticker, (valueByTicker.get(position.ticker) ?? 0) + value);
    total += value;
  }

  if (total <= 0) return [];

  return [...valueByTicker.entries()]
    .map(([ticker, value]) => ({ ticker, value, percent: (value / total) * 100 }))
    .sort((a, b) => b.value - a.value)
    .map((slice, index) => ({
      ...slice,
      color: ALLOCATION_PALETTE[index % ALLOCATION_PALETTE.length] ?? '#00E5FF',
    }));
}
