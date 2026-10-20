import { beforeEach, expect, it } from 'vitest';
import {
  applyPaperRow,
  freshPaperContainer,
  type PaperLedgerRow,
  type PortfolioContainer,
} from '@/lib/portfolioAccounting';
import { loadWalkForward, recordWalkForward, walkForwardCsv } from '@/lib/engine/walkForwardLogger';

function book(container: PortfolioContainer, row: Omit<PaperLedgerRow, 'fees'>) {
  const next = applyPaperRow(container, { ...row, fees: 0 });
  if (!next.ok) throw new Error(next.error);
  return next.container;
}

beforeEach(() => localStorage.clear());

it('keeps one row per UTC day, the latest write winning, and tracks drawdown across days', () => {
  const start = freshPaperContainer();
  recordWalkForward('user-a', start, {}, new Date('2026-10-20T12:00:00Z'));

  const long = book(start, {
    id: 'buy',
    action: 'BUY',
    ticker: 'BTC',
    quantity: 1,
    price: 50_000,
    created_at: '2026-10-21T08:00:00Z',
  });
  recordWalkForward('user-a', long, { BTC: 40_000 }, new Date('2026-10-21T09:00:00Z'));
  recordWalkForward('user-a', long, { BTC: 45_000 }, new Date('2026-10-21T23:00:00Z'));

  const closed = book(long, {
    id: 'sell',
    action: 'SELL',
    ticker: 'BTC',
    quantity: 1,
    price: 60_000,
    created_at: '2026-10-22T08:00:00Z',
  });
  recordWalkForward('user-a', closed, {}, new Date('2026-10-22T20:00:00Z'));

  const days = loadWalkForward('user-a');
  expect(walkForwardCsv(days).split('\r\n')).toEqual([
    'date,paper_equity,total_trades,win_rate,max_drawdown',
    '2026-10-20,100000.00,0,,0.0000',
    '2026-10-21,95000.00,1,,0.0500',
    '2026-10-22,110000.00,2,1.0000,0.0500',
  ]);
  expect(loadWalkForward('user-b')).toEqual([]);
});
