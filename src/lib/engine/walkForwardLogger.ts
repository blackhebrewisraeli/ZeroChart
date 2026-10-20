import { computePortfolioValuation, type PortfolioContainer } from '@/lib/portfolioAccounting';
import { maxDrawdown } from '@/lib/risk';
import { tradeStats } from '@/lib/tradeLedger';

/** One day of the closed-beta walk-forward evaluation of the Paper Trading account. */
export interface WalkForwardSnapshot {
  /** UTC calendar day (YYYY-MM-DD), the Binance daily close. */
  date: string;
  /** Paper cash plus open positions at the latest price. */
  equity: number;
  /** Every BUY and SELL fill in the ledger. */
  totalTrades: number;
  /** Closes booked at a profit over all closes, 0–1; null before the first close. */
  winRate: number | null;
  /** Worst peak-to-trough drop of the daily equity series so far, 0–1. */
  maxDrawdown: number;
}

const storageKey = (userId: string) => `zerochart:walk-forward:${userId}`;

/** The user's recorded days, oldest first; empty when storage is unavailable. */
export function loadWalkForward(userId: string): WalkForwardSnapshot[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey(userId)) ?? '[]');
    return Array.isArray(parsed) ? (parsed as WalkForwardSnapshot[]) : [];
  } catch {
    return [];
  }
}

/**
 * Records today's snapshot, replacing any earlier one from the same UTC day,
 * so the last write of a day stands as its end-of-day row.
 * ponytail: written only while the app is open, so a day nobody opens has no
 * row and drawdown is close-to-close; a Supabase table filled by a pg_cron job
 * gives a true end-of-day series if the audit needs it.
 */
export function recordWalkForward(
  userId: string,
  paper: PortfolioContainer,
  prices: Readonly<Record<string, number | null | undefined>>,
  now = new Date(),
): WalkForwardSnapshot[] {
  const date = now.toISOString().slice(0, 10);
  const history = loadWalkForward(userId).filter((snapshot) => snapshot.date !== date);
  const equity = computePortfolioValuation(paper, prices).totalEquity;
  const { fills, closes, wins } = tradeStats(paper.transactions);
  const days = [
    ...history,
    {
      date,
      equity,
      totalTrades: fills,
      winRate: closes > 0 ? wins / closes : null,
      maxDrawdown: maxDrawdown([...history.map((snapshot) => snapshot.equity), equity]),
    },
  ];
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(days));
  } catch {
    // Storage full or blocked: the in-app numbers are unaffected.
  }
  return days;
}

/** The audit as CSV, one row per recorded day. */
export function walkForwardCsv(snapshots: readonly WalkForwardSnapshot[]): string {
  const rows = snapshots.map((snapshot) =>
    [
      snapshot.date,
      snapshot.equity.toFixed(2),
      snapshot.totalTrades,
      snapshot.winRate === null ? '' : snapshot.winRate.toFixed(4),
      snapshot.maxDrawdown.toFixed(4),
    ].join(','),
  );
  return ['date,paper_equity,total_trades,win_rate,max_drawdown', ...rows].join('\r\n');
}
