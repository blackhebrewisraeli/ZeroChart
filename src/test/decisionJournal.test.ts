import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatElapsed,
  journalEntry,
  summarizeJournal,
  tickerQuery,
  type JournalFill,
  type JournalSignal,
} from '@/lib/decisionJournal';

// A thenable PostgREST builder that records each call, for loadJournalPage.
const db = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown[]]>,
  result: { data: [] as unknown[], error: null as { message: string } | null, count: 0 },
}));

vi.mock('@/lib/supabaseClient', () => {
  const builder: Record<string, unknown> = {};
  for (const method of ['from', 'select', 'eq', 'ilike', 'or', 'order', 'limit']) {
    builder[method] = (...args: unknown[]) => {
      db.calls.push([method, args]);
      return builder;
    };
  }
  builder['then'] = (resolve: (value: unknown) => unknown) => resolve(db.result);
  return { supabase: { from: builder['from'] } };
});

import { JOURNAL_PAGE_SIZE, loadJournalPage } from '@/lib/db';

const RECEIVED = '2026-10-27T07:20:00.123456+00:00';

/** SYNTHETIC: a modern strategy signal, PENDING, no fill. */
function signal(overrides: Partial<JournalSignal> = {}): JournalSignal {
  return {
    id: 'sig-1',
    ticker: 'ZCTAUSDT',
    action: 'BUY',
    signal_kind: 'strategy',
    signal_score: 81,
    quantity: 0.99501247,
    stop_loss: 97.1094,
    price: 100,
    status: 'PENDING',
    event_id: '2026-10-27T07:20:00Z',
    exchange: 'ZC_SYNTHETIC',
    timeframe: '1D',
    bar_time: '2026-10-27T00:00:00+00:00',
    model_version: '1.0.0-pw200',
    created_at: RECEIVED,
    paper_transactions: [],
    ...overrides,
  };
}

/** SYNTHETIC: the fill execute_tactical_signal books for signal(), 2m 05s later. */
function fill(overrides: Partial<JournalFill> = {}): JournalFill {
  return {
    id: 'fill-1',
    action: 'BUY',
    ticker: 'ZCTA-USD',
    quantity: 0.99501247,
    price: 100.42,
    fees: 0.249805,
    created_at: '2026-10-27T07:22:05.123456+00:00',
    ...overrides,
  };
}

describe('journalEntry states', () => {
  it('a pending strategy signal awaits the owner', () => {
    const entry = journalEntry(signal());
    expect(entry).toMatchObject({ state: 'awaiting', notes: [], fill: null, comparison: null });
    expect(entry.provenanceComplete).toBe(true);
  });

  it('a dismissed signal without a fill is dismissed', () => {
    expect(journalEntry(signal({ status: 'DISMISSED' })).state).toBe('dismissed');
  });

  it('an executed signal with its matching fill is executed, booked under the scanner ticker', () => {
    const entry = journalEntry(signal({ status: 'EXECUTED', paper_transactions: [fill()] }));
    expect(entry.state).toBe('executed');
    expect(entry.notes).toEqual([]);
    expect(entry.fill?.id).toBe('fill-1');
  });

  it('a pending transport test or legacy signal has no outcome the app can reach', () => {
    const transport = journalEntry(signal({ signal_kind: 'transport_test' }));
    expect(transport.state).toBe('unresolved');
    expect(transport.notes[0]).toMatch(/^Transport test/);
    const legacy = journalEntry(signal({ signal_kind: null }));
    expect(legacy.state).toBe('unresolved');
    expect(legacy.notes[0]).toMatch(/No signal kind was recorded/);
  });

  it('never labels a pending signal as rejected', () => {
    const entry = journalEntry(signal());
    expect(JSON.stringify(entry)).not.toMatch(/reject/i);
  });
});

describe('legacy metadata', () => {
  it('keeps omitted fields null and marks the provenance incomplete', () => {
    const entry = journalEntry(
      signal({
        signal_kind: null,
        exchange: null,
        timeframe: null,
        bar_time: null,
        model_version: null,
        price: null,
        event_id: null,
        stop_loss: null,
        status: 'DISMISSED',
      }),
    );
    expect(entry.state).toBe('dismissed');
    expect(entry.provenanceComplete).toBe(false);
    expect(entry.signal).toMatchObject({ exchange: null, bar_time: null, price: null });
  });

  it('one missing provenance field is enough to mark it incomplete', () => {
    expect(journalEntry(signal({ bar_time: null })).provenanceComplete).toBe(false);
  });

  it('has no price change when the signal price was not recorded', () => {
    const entry = journalEntry(
      signal({ status: 'EXECUTED', price: null, paper_transactions: [fill()] }),
    );
    expect(entry.state).toBe('executed');
    expect(entry.comparison).toMatchObject({ signalPrice: null, priceChangePct: null });
  });
});

describe('missing and contradictory evidence', () => {
  it('an executed signal without a linked fill is inconsistent', () => {
    const entry = journalEntry(signal({ status: 'EXECUTED' }));
    expect(entry.state).toBe('inconsistent');
    expect(entry.notes).toEqual([expect.stringMatching(/no fill is linked.*20261022090000/)]);
    expect(entry.comparison).toBeNull();
  });

  it.each(['PENDING', 'DISMISSED'])('a fill linked to a %s signal is inconsistent', (status) => {
    const entry = journalEntry(signal({ status, paper_transactions: [fill()] }));
    expect(entry.state).toBe('inconsistent');
    expect(entry.notes).toContain(`A fill is linked, but the signal is recorded as ${status}.`);
  });

  it('reports each mismatch between the fill and its signal', () => {
    const notes = (overrides: Partial<JournalFill>) =>
      journalEntry(signal({ status: 'EXECUTED', paper_transactions: [fill(overrides)] })).notes;
    expect(notes({ action: 'SELL' })).toEqual(['The linked fill is a SELL; the signal is a BUY.']);
    expect(notes({ quantity: 0.995 })).toEqual([
      "The linked fill's quantity differs from the signal's.",
    ]);
    expect(notes({ ticker: 'ZCTB-USD' })).toEqual([
      'The linked fill booked ZCTB-USD, not ZCTAUSDT.',
    ]);
    expect(notes({ created_at: '2026-10-27T07:19:59+00:00' })).toEqual([
      'The linked fill booked before the signal was received.',
    ]);
  });

  it('more than one linked fill is inconsistent', () => {
    const entry = journalEntry(
      signal({ status: 'EXECUTED', paper_transactions: [fill(), fill({ id: 'fill-2' })] }),
    );
    expect(entry.state).toBe('inconsistent');
    expect(entry.notes).toEqual(['2 fills are linked; execution books one.']);
  });

  it('accepts the tickers execute_tactical_signal treats as one asset', () => {
    const pairs: Array<[string, string]> = [
      ['BTCUSDT', 'BTC-USD'],
      ['BTCUSD', 'BTC-USD'],
      ['AAPL', 'AAPL'],
    ];
    for (const [signalTicker, fillTicker] of pairs) {
      const entry = journalEntry(
        signal({
          ticker: signalTicker,
          status: 'EXECUTED',
          paper_transactions: [fill({ ticker: fillTicker })],
        }),
      );
      expect(entry.notes).toEqual([]);
    }
  });
});

describe('execution comparison', () => {
  it('uses the stored prices, times and fee', () => {
    const { comparison } = journalEntry(
      signal({ status: 'EXECUTED', paper_transactions: [fill()] }),
    );
    expect(comparison?.signalPrice).toBe(100);
    expect(comparison?.fillPrice).toBe(100.42);
    expect(comparison?.priceChangePct).toBeCloseTo(0.42, 10);
    expect(comparison?.elapsedMs).toBe(125_000);
    expect(comparison?.fees).toBe(0.249805);
  });

  it('is negative when the fill is below the signal price', () => {
    const { comparison } = journalEntry(
      signal({ status: 'EXECUTED', price: 200, paper_transactions: [fill({ price: 190 })] }),
    );
    expect(comparison?.priceChangePct).toBeCloseTo(-5, 10);
  });

  it('formats elapsed time at each boundary', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(59_400)).toBe('59s');
    expect(formatElapsed(125_000)).toBe('2m 05s');
    expect(formatElapsed(3_600_000 + 7 * 60_000)).toBe('1h 07m');
    expect(formatElapsed(3 * 86_400_000 + 4 * 3_600_000)).toBe('3d 4h');
    expect(formatElapsed(-1_000)).toBe('−1s');
  });
});

describe('summary and filters', () => {
  it('counts each state and the incomplete rows', () => {
    const summary = summarizeJournal(
      [
        signal(),
        signal({ status: 'DISMISSED', bar_time: null }),
        signal({ status: 'EXECUTED', paper_transactions: [fill()] }),
        signal({ status: 'EXECUTED' }),
      ].map(journalEntry),
    );
    expect(summary).toEqual({
      loaded: 4,
      states: { awaiting: 1, dismissed: 1, executed: 1, unresolved: 0, inconsistent: 1 },
      provenanceIncomplete: 1,
    });
  });

  it('leaves only ticker characters, so the asset filter has no wildcards', () => {
    expect(tickerQuery(' btc%_usd,(x) ')).toBe('BTCUSDX');
    expect(tickerQuery('brk.b')).toBe('BRK.B');
  });
});

describe('loadJournalPage', () => {
  const rows = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      signal({
        id: `sig-${i}`,
        created_at: `2026-10-27T07:${String(59 - i).padStart(2, '0')}:00+00:00`,
      }),
    );
  const call = (method: string) => db.calls.filter(([name]) => name === method).map(([, a]) => a);

  beforeEach(() => {
    db.calls = [];
    db.result = { data: [], error: null, count: 0 };
  });

  it('reads named columns with the linked fills embedded, newest first, one row past the page', async () => {
    db.result = { data: rows(JOURNAL_PAGE_SIZE + 1), error: null, count: 40 };
    const page = await loadJournalPage('user-a', { ticker: '', status: null }, null);

    expect(call('from')).toEqual([['trading_signals']]);
    const [[columns, options]] = call('select') as [[string, unknown]];
    expect(columns).toContain(
      'paper_transactions(id, action, ticker, quantity, price, fees, created_at)',
    );
    expect(columns).not.toMatch(/\*|token|secret|payload/);
    expect(options).toEqual({ count: 'exact' });
    expect(call('eq')).toEqual([['user_id', 'user-a']]);
    expect(call('or')).toEqual([]);
    expect(call('order')).toEqual([
      ['created_at', { ascending: false }],
      ['id', { ascending: false }],
    ]);
    expect(call('limit')).toEqual([[JOURNAL_PAGE_SIZE + 1]]);

    expect(page.rows).toHaveLength(JOURNAL_PAGE_SIZE);
    const last = page.rows.at(-1);
    expect(page.next).toEqual({ createdAt: last?.created_at, id: last?.id });
    expect(page.total).toBe(40);
  });

  it('filters on the server and continues after the cursor without recounting', async () => {
    db.result = { data: rows(3), error: null, count: 0 };
    const page = await loadJournalPage(
      'user-a',
      { ticker: 'BTC', status: 'DISMISSED' },
      { createdAt: RECEIVED, id: 'sig-9' },
    );
    expect(call('eq')).toEqual([
      ['user_id', 'user-a'],
      ['status', 'DISMISSED'],
    ]);
    expect(call('ilike')).toEqual([['ticker', '%BTC%']]);
    expect(call('or')).toEqual([
      [`created_at.lt."${RECEIVED}",and(created_at.eq."${RECEIVED}",id.lt.sig-9)`],
    ]);
    expect(call('select')[0]?.[1]).toEqual({});
    expect(page.next).toBeNull();
  });

  it('throws on a read error rather than returning an empty page', async () => {
    db.result = { data: [], error: { message: 'JWT expired' }, count: 0 };
    await expect(loadJournalPage('user-a', { ticker: '', status: null }, null)).rejects.toThrow(
      'JWT expired',
    );
  });
});
