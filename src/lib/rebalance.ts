import type { Position } from '@/lib/portfolioAccounting';

/**
 * Core Portfolio drift rebalancer (M2-T2). Passive by design: it compares the
 * portfolio's actual weights with the user's target allocation and never
 * reads quant signals — tactical BUY/SELL ideas live in `tacticalSignals.ts`.
 */

/** A holding more than 5 percentage points off its target triggers a rebalance. */
export const REBALANCE_BAND = 0.05;

const SIDE_ORDER = { sell: 0, buy: 1 } as const;

/** Trades under $1 or 0.1% of the portfolio are fee noise and are not suggested. */
const MIN_TRADE_VALUE = 1;
const MIN_TRADE_SHARE = 0.001;

export interface DriftRow {
  ticker: string;
  /** Market value at the live price, or at cost when no live price exists. */
  value: number;
  actualWeight: number;
  targetWeight: number;
  /** actualWeight − targetWeight, as a fraction (0.06 = +6 pts overweight). */
  drift: number;
  /** False when the ticker has no live price, so it cannot be traded. */
  priced: boolean;
}

export interface RebalanceTrade {
  ticker: string;
  side: 'buy' | 'sell';
  /** Gross USD notional (before fees) that restores the target weight. */
  amount: number;
  price: number;
}

export interface RebalancePlan {
  rows: DriftRow[];
  /** Cash share of the base; its target is 0%, so idle cash is drift too. */
  cashWeight: number;
  /** True when any holding drifts beyond the band. */
  breached: boolean;
  /** Sells first (they fund the buys); empty unless `breached`. */
  trades: RebalanceTrade[];
  /** Holdings plus cash. */
  totalValue: number;
}

/**
 * Builds the drift table and, once any holding (or idle cash) leaves the
 * band, the trades that bring every holding back to its exact target.
 * Targets are normalized to sum to 1; a held ticker without a target counts
 * as 0%. Cash is part of the base, so a sell's proceeds keep the follow-up
 * buys on the list until they are reinvested.
 *
 * ponytail: cash always targets 0% — add a cash target if users want a buffer.
 */
export function computeRebalancePlan(
  positions: readonly Position[],
  targets: Readonly<Record<string, number>>,
  prices: ReadonlyMap<string, number>,
  cash = 0,
  band: number = REBALANCE_BAND,
): RebalancePlan {
  const targetSum = Object.values(targets).reduce((sum, weight) => sum + weight, 0);
  const shares = new Map<string, number>();
  const costValue = new Map<string, number>();
  for (const position of positions) {
    const ticker = position.ticker.toUpperCase();
    shares.set(ticker, (shares.get(ticker) ?? 0) + position.shares);
    costValue.set(ticker, (costValue.get(ticker) ?? 0) + position.shares * position.buyPrice);
  }

  const tickers = [...new Set([...shares.keys(), ...Object.keys(targets)])].sort((a, b) =>
    a.localeCompare(b),
  );
  const valued = tickers.map((ticker) => {
    const price = prices.get(ticker);
    const held = shares.get(ticker) ?? 0;
    return {
      ticker,
      price,
      value: price !== undefined ? held * price : (costValue.get(ticker) ?? 0),
    };
  });
  const totalValue = valued.reduce((sum, row) => sum + row.value, Math.max(cash, 0));
  const cashWeight = totalValue > 0 ? Math.max(cash, 0) / totalValue : 0;

  const rows: DriftRow[] = valued.map(({ ticker, price, value }) => {
    const actualWeight = totalValue > 0 ? value / totalValue : 0;
    const targetWeight = targetSum > 0 ? (targets[ticker] ?? 0) / targetSum : 0;
    return {
      ticker,
      value,
      actualWeight,
      targetWeight,
      drift: actualWeight - targetWeight,
      priced: price !== undefined,
    };
  });

  const breached =
    totalValue > 0 && (cashWeight > band || rows.some((row) => Math.abs(row.drift) > band));
  const trades: RebalanceTrade[] = [];
  if (breached) {
    const minTrade = Math.max(MIN_TRADE_VALUE, totalValue * MIN_TRADE_SHARE);
    for (const row of rows) {
      const price = prices.get(row.ticker);
      const delta = row.targetWeight * totalValue - row.value;
      if (price === undefined || Math.abs(delta) < minTrade) continue;
      trades.push({
        ticker: row.ticker,
        side: delta > 0 ? 'buy' : 'sell',
        amount: Math.abs(delta),
        price,
      });
    }
    // Sells first: they free the cash the buys spend.
    trades.sort((a, b) => SIDE_ORDER[a.side] - SIDE_ORDER[b.side]);
  }

  return { rows, cashWeight, breached, trades, totalValue };
}
