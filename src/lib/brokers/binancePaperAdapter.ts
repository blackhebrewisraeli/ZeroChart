import {
  insertPaperTransaction,
  loadPaperTransactions,
  type PaperTransactionInsert,
} from '@/lib/db';
import { replayPaperLedger } from '@/lib/portfolioAccounting';
import type { BrokerAdapter, BrokerOrder } from '@/lib/brokers/brokerInterface';

/** The `paper_transactions` row an order books; the Paper Desk books the same one. */
export function paperOrderRow(order: BrokerOrder): PaperTransactionInsert {
  return {
    action: order.side === 'buy' ? 'BUY' : 'SELL',
    ticker: order.ticker.trim().toUpperCase(),
    quantity: order.shares,
    price: order.price,
    fees: order.fee,
  };
}

/**
 * Binance spot, simulated: an order is a row appended to the user's
 * `paper_transactions` ledger (the insert trigger refuses a fill the account
 * can't cover), and balances and positions are the replay of that ledger.
 * Paper fills are immediate, so there is never an open order to cancel.
 */
export function binancePaperAdapter(userId: string): BrokerAdapter {
  const account = async () => replayPaperLedger(await loadPaperTransactions(userId));
  return {
    name: 'Binance Spot (paper)',
    async placeOrder(order) {
      try {
        await insertPaperTransaction(paperOrderRow(order));
        return { ok: true, orderId: null };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    cancelOrder: () =>
      Promise.resolve({
        ok: false as const,
        error: 'Paper fills are immediate; there is no open order to cancel.',
      }),
    getBalances: async () => [{ currency: 'USD', available: (await account()).cashBalance }],
    getPositions: async () =>
      (await account()).positions.map((position) => ({
        ticker: position.ticker,
        quantity: position.shares,
        averagePrice: position.buyPrice,
      })),
  };
}
