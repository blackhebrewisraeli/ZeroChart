import { vi } from 'vitest';
import type { PaperTransactionInsert } from '@/lib/db';
import type { PaperLedgerRow } from '@/lib/portfolioAccounting';

/**
 * One account's `paper_transactions` table, for `vi.mock('@/lib/db')`
 * factories: inserts land in `rows`, loads return them oldest first.
 * Reset with `paperDb.rows.length = 0`.
 */
export const paperDb = {
  rows: [] as PaperLedgerRow[],
  insertPaperTransaction: vi.fn(async (row: PaperTransactionInsert) => {
    paperDb.rows.push({
      ...row,
      id: `row-${paperDb.rows.length}`,
      created_at: new Date().toISOString(),
    });
  }),
  loadPaperTransactions: vi.fn(async () => [...paperDb.rows]),
};
