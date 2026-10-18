import type { PortfolioTransaction } from '@/lib/portfolioAccounting';

export const LEDGER_SIDE_LABELS: Record<PortfolioTransaction['type'], string> = {
  buy: 'BUY',
  sell: 'SELL',
  deposit: 'DEPOSIT',
  withdrawal: 'WITHDRAW',
};

function isTrade(transaction: PortfolioTransaction): boolean {
  return transaction.type === 'buy' || transaction.type === 'sell';
}

/** Execution cost (fee + slippage, USD) of one ledger entry; 0 for cash movements. */
export function executionCost(transaction: PortfolioTransaction): number {
  return isTrade(transaction) ? (transaction.fee ?? 0) + (transaction.slippage ?? 0) : 0;
}

/** Total execution drag: fees + slippage paid across every recorded buy and sell. */
export function executionDrag(transactions: readonly PortfolioTransaction[]): number {
  return transactions.reduce((sum, transaction) => sum + executionCost(transaction), 0);
}

/** Execution cost in basis points of trade notional; null for cash movements. */
export function frictionBps(transaction: PortfolioTransaction): number | null {
  if (!isTrade(transaction) || !transaction.shares || !transaction.price) return null;
  return (executionCost(transaction) / (transaction.shares * transaction.price)) * 10_000;
}

const CSV_HEADER = [
  'timestamp',
  'side',
  'ticker',
  'quantity',
  'price',
  'fee',
  'slippage',
  'friction_bps',
  'amount',
  'realized_pnl',
  'note',
];

function csvCell(value: string | number | null | undefined): string {
  if (value == null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  // Tickers and notes are user input: neutralise spreadsheet formulas, then RFC 4180 quote.
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Serialises the ledger (in recorded order) as RFC 4180 CSV. */
export function tradeLedgerCsv(transactions: readonly PortfolioTransaction[]): string {
  const rows = transactions.map((transaction) => {
    const bps = frictionBps(transaction);
    return [
      transaction.timestamp,
      LEDGER_SIDE_LABELS[transaction.type],
      transaction.ticker,
      transaction.shares,
      transaction.price,
      transaction.fee,
      transaction.slippage,
      bps === null ? null : Number(bps.toFixed(2)),
      transaction.amount,
      transaction.realizedPnl,
      transaction.note,
    ]
      .map(csvCell)
      .join(',');
  });
  return [CSV_HEADER.join(','), ...rows].join('\r\n');
}

export function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  // Firefox and the HTML spec only follow links that are in the document.
  document.body.append(link);
  link.click();
  link.remove();
  // Revoke on the next tick so Safari has started the download first.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
