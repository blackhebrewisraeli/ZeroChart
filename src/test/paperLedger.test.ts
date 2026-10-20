import { describe, expect, it } from 'vitest';
import {
  PAPER_STARTING_CASH,
  replayPaperLedger,
  type PaperLedgerRow,
} from '@/lib/portfolioAccounting';

let sequence = 0;
function row(action: string, fields: Partial<PaperLedgerRow> = {}): PaperLedgerRow {
  sequence += 1;
  return {
    id: `row-${sequence}`,
    action,
    ticker: null,
    quantity: null,
    price: null,
    fees: 0,
    created_at: `2026-10-0${sequence}T00:00:00.000Z`,
    ...fields,
  };
}

const fill = (action: 'BUY' | 'SELL', quantity: number, price: number, fees = 0) =>
  row(action, { ticker: 'NVDA', quantity, price, fees });

describe('replayPaperLedger', () => {
  it('derives FIFO lots, cash and realized P&L from the rows', () => {
    sequence = 0;
    const account = replayPaperLedger([
      fill('BUY', 10, 100, 5), // lot 1: $1,005 basis
      fill('BUY', 10, 200), // lot 2: $2,000 basis
      row('DEPOSIT', { quantity: 500 }),
      fill('SELL', 15, 300, 10), // all of lot 1 + half of lot 2
    ]);

    // 4,490 net proceeds − (1,005 + 1,000) basis sold
    expect(account.realizedPnl).toBe(2_485);
    expect(account.cashBalance).toBe(PAPER_STARTING_CASH - 1_005 - 2_000 + 500 + 4_490);
    expect(account.positions).toHaveLength(1);
    expect(account.positions[0]).toMatchObject({ ticker: 'NVDA', shares: 5, buyPrice: 200 });
    expect(account.transactions.map(({ type, intent }) => [type, intent])).toEqual([
      ['buy', 'tactical'],
      ['buy', 'tactical'],
      ['deposit', undefined],
      ['sell', 'tactical'],
    ]);
  });

  it('starts over at starting cash after a RESET', () => {
    sequence = 0;
    const account = replayPaperLedger([
      fill('BUY', 10, 100),
      row('RESET'),
      row('DEPOSIT', { quantity: 1_000 }),
    ]);

    expect(account.positions).toEqual([]);
    expect(account.realizedPnl).toBe(0);
    expect(account.cashBalance).toBe(PAPER_STARTING_CASH + 1_000);
    expect(account.transactions.map(({ type }) => type)).toEqual(['deposit']);
  });

  it('books nothing for a row the engine rejects', () => {
    sequence = 0;
    const account = replayPaperLedger([fill('SELL', 1, 100), row('BOGUS'), fill('BUY', 1, 100)]);

    expect(account.transactions.map(({ type }) => type)).toEqual(['buy']);
    expect(account.cashBalance).toBe(PAPER_STARTING_CASH - 100);
  });
});
