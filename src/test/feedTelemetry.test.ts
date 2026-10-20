import { afterEach, describe, expect, it, vi } from 'vitest';
import { report } from '../../supabase/functions/_shared/telemetry';

afterEach(() => vi.restoreAllMocks());

describe('feed telemetry', () => {
  it('counts and logs skipped tickers and ages the stalest row', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const now = Date.parse('2026-10-20T12:00:00Z');
    const stored = new Map<string, string | null>([
      ['AAPL', '2026-10-20T10:00:00Z'],
      ['MSFT', '2026-10-19T12:00:00Z'],
      ['NEW', null],
    ]);
    // AAPL is rewritten fresh; MSFT and NEW are missed. NEW has never had data,
    // so it counts as skipped but cannot age the summary.
    const written = new Map([['AAPL', '2026-10-20T12:00:00Z']]);

    expect(report('feed', ['AAPL', 'MSFT', 'NEW'], stored, written, now)).toEqual({
      status: 200,
      expected: 3,
      updated: 1,
      skipped: 2,
      oldest_data_age_mins: 24 * 60,
    });
    const events = warn.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(events.filter((e) => e.event === 'ticker_skipped').map((e) => e.ticker)).toEqual([
      'MSFT',
      'NEW',
    ]);
    expect(events.at(-1)).toMatchObject({ fn: 'feed', event: 'run_summary', skipped: 2 });
  });

  it('logs a clean run at info level', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const now = Date.parse('2026-10-20T12:00:00Z');
    const written = new Map([['BTC-USD', '2026-10-20T12:00:00Z']]);
    expect(report('feed', ['BTC-USD'], new Map(), written, now)).toMatchObject({
      skipped: 0,
      oldest_data_age_mins: 0,
    });
    expect(info).toHaveBeenCalledTimes(1);
  });
});
