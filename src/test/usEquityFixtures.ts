/**
 * Labeled fixtures, not market data: sessions come from the published NYSE
 * calendar, prices from a synthetic path. Nothing here was fetched.
 */
import {
  latestFinalSession,
  sessionsBack,
  tradingSessions,
  type EquityDailyBar,
  type EquityDailyProvider,
  type EquityDailySeries,
} from '@/lib/usEquityDaily';

/** Wednesday 28 Oct 2026, 13:00 New York (EDT): Tuesday 27 Oct is the latest final session. */
export const EQUITY_NOW = Date.UTC(2026, 9, 28, 17);
export const LATEST_FINAL = '2026-10-27';

/** The `count` sessions ending at `last`. */
export function sessionsEndingAt(count: number, last = latestFinalSession(EQUITY_NOW)!): string[] {
  return tradingSessions(sessionsBack(last, count)!, last);
}

export function bars(path: (i: number) => number, count = 200, last?: string): EquityDailyBar[] {
  return sessionsEndingAt(count, last).map((session, i) => {
    const close = path(i);
    return { session, open: close, high: close * 1.01, low: close * 0.99, close, volume: 1_000 };
  });
}

export function split(barsIn: EquityDailyBar[]): EquityDailySeries {
  return { adjustment: 'SPLIT', bars: barsIn, splits: [] };
}

export const wave = (i: number) => 100 + Math.sin(i / 6) * 8;
export const rising = (i: number) => 50 + i * 0.4;
export const falling = (i: number) => 200 - i * 0.5;

/** An in-memory adapter: records every request and answers from `map`. */
export function fixtureProvider(
  map: Record<string, EquityDailySeries | Error>,
  concurrency = 2,
): EquityDailyProvider & { calls: { symbol: string; from: string; to: string }[] } {
  const calls: { symbol: string; from: string; to: string }[] = [];
  return {
    id: 'fixture-eod',
    concurrency,
    calls,
    async fetchDaily(symbol, range) {
      calls.push({ symbol, ...range });
      const value = map[symbol];
      if (value instanceof Error) throw value;
      if (!value) throw new Error('HTTP 404');
      return value;
    },
  };
}
