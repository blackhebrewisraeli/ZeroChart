import { describe, expect, it } from 'vitest';
import { evaluateCandles, type CanonicalScore } from '@/lib/canonicalModel';
import {
  FINAL_BAR_DELAY_MS,
  latestFinalSession,
  sessionClose,
  sessionOpen,
  tradingSessions,
  US_EQUITY_INSTRUMENTS,
  usEquityInstrument,
  validateUsEquityDailySeries,
  type EquityDailyBar,
} from '@/lib/usEquityDaily';
import { bars, EQUITY_NOW, LATEST_FINAL, sessionsEndingAt, split, wave } from './usEquityFixtures';

const utc = (iso: string) => Date.parse(iso);
const validate = (input: Parameters<typeof validateUsEquityDailySeries>[0], at = EQUITY_NOW) =>
  validateUsEquityDailySeries(input, { evaluationTime: at, modelWindow: 199 });
const codes = (result: ReturnType<typeof validate>) => result.issues.map((item) => item.code);

describe('US equity session calendar', () => {
  it('skips weekends and published NYSE holidays', () => {
    // Thanksgiving week: Thursday 26 Nov is closed, the weekend is not a session.
    expect(tradingSessions('2026-11-23', '2026-11-30')).toEqual([
      '2026-11-23',
      '2026-11-24',
      '2026-11-25',
      '2026-11-27',
      '2026-11-30',
    ]);
    expect(tradingSessions('2026-04-02', '2026-04-06')).toEqual(['2026-04-02', '2026-04-06']); // Good Friday
    expect(tradingSessions('2027-12-23', '2027-12-27')).toEqual(['2027-12-23', '2027-12-27']); // Christmas observed Fri 24
    expect(tradingSessions('2026-01-01', '2026-01-02')).toEqual(['2026-01-02']);
  });

  it('closes at 13:00 New York on early-close days and follows daylight saving', () => {
    expect(sessionClose('2026-11-25')).toBe(utc('2026-11-25T21:00:00Z')); // 16:00 EST
    expect(sessionClose('2026-11-27')).toBe(utc('2026-11-27T18:00:00Z')); // 13:00 EST, early close
    expect(sessionClose('2026-12-24')).toBe(utc('2026-12-24T18:00:00Z'));
    // DST starts Sunday 8 Mar 2026 and ends Sunday 1 Nov 2026.
    expect(sessionOpen('2026-03-06')).toBe(utc('2026-03-06T14:30:00Z'));
    expect(sessionClose('2026-03-06')).toBe(utc('2026-03-06T21:00:00Z'));
    expect(sessionOpen('2026-03-09')).toBe(utc('2026-03-09T13:30:00Z'));
    expect(sessionClose('2026-03-09')).toBe(utc('2026-03-09T20:00:00Z'));
    expect(sessionClose('2026-10-30')).toBe(utc('2026-10-30T20:00:00Z'));
    expect(sessionClose('2026-11-02')).toBe(utc('2026-11-02T21:00:00Z'));
  });

  it('counts a session as final 9h after its close, and never guesses outside the calendar', () => {
    expect(FINAL_BAR_DELAY_MS).toBe(9 * 3_600_000);
    // 00:59 / 01:00 New York on Wednesday 28 Oct.
    expect(latestFinalSession(utc('2026-10-28T04:59:59Z'))).toBe('2026-10-26');
    expect(latestFinalSession(utc('2026-10-28T05:00:00Z'))).toBe('2026-10-27');
    // A Monday morning scan rests on Friday; a weekend changes nothing.
    expect(latestFinalSession(utc('2026-11-02T14:00:00Z'))).toBe('2026-10-30');
    expect(latestFinalSession(utc('2026-11-01T14:00:00Z'))).toBe('2026-10-30');
    // The early close is final at 22:00 EST, three hours earlier than a full day.
    expect(latestFinalSession(utc('2026-11-28T02:59:59Z'))).toBe('2026-11-25');
    expect(latestFinalSession(utc('2026-11-28T03:00:00Z'))).toBe('2026-11-27');
    expect(latestFinalSession(utc('2026-01-02T12:00:00Z'))).toBeNull();
    expect(latestFinalSession(utc('2029-01-03T12:00:00Z'))).toBeNull();
  });

  it('maps exactly the 90 configured US stocks and ETFs, and nothing by shape', () => {
    const types = Object.values(US_EQUITY_INSTRUMENTS);
    expect(types).toHaveLength(90);
    expect(types.filter((type) => type === 'etf')).toHaveLength(19);
    expect(usEquityInstrument('AAPL')).toBe('US:AAPL');
    expect(usEquityInstrument('SPY')).toBe('US:SPY');
    expect(usEquityInstrument('ZZZZ')).toBeNull();
    expect(usEquityInstrument('toString')).toBeNull();
  });
});

describe('us-equity-daily-v1 validation', () => {
  it('keeps the last 199 final sessions as engine candles stamped with session open and close', () => {
    const result = validate(split(bars(wave)));
    expect(result.structurallyValid).toBe(true);
    expect(result.requiredSession).toBe(LATEST_FINAL);
    expect(result.closed).toHaveLength(199);
    expect(result.closed.at(-1)).toMatchObject({
      timestamp: utc('2026-10-27T13:30:00Z'),
      closeTime: utc('2026-10-27T20:00:00Z'),
    });
    expect(result.latestCloseTime).toBe(utc('2026-10-27T20:00:00Z'));
    expect(result.fresh).toBe(true);
  });

  it('excludes the open session and a closed session that is not yet final', () => {
    const today: EquityDailyBar = {
      session: '2026-10-28',
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
    };
    const during = validate(split([...bars(wave), today]));
    expect(during.excludedOpenCount).toBe(1);
    expect(during.closed.at(-1)?.close).toBe(wave(199));

    // 23:00 New York on the 27th: the session closed but is not final until 01:00.
    const evening = validate(split(bars(wave)), utc('2026-10-28T03:00:00Z'));
    expect(evening.requiredSession).toBe('2026-10-26');
    expect(evening.excludedOpenCount).toBe(1);
    expect(evening.latestSession).toBe('2026-10-26');
  });

  it('reports weekend, holiday, malformed and out-of-calendar bars instead of dropping them', () => {
    const series = bars(wave);
    const weekend = { ...series[150]!, session: '2026-08-29' }; // Saturday
    const holiday = { ...series[160]!, session: '2026-09-07' }; // Labor Day
    const malformed = { ...series[170]!, session: '2026-02-30' };
    const result = validate(
      split(
        [...series.slice(1), weekend, holiday, malformed].sort((a, b) =>
          a.session < b.session ? -1 : 1,
        ),
      ),
    );
    expect(codes(result)).toEqual(
      expect.arrayContaining(['NON_SESSION_BAR', 'INVALID_SESSION_DATE']),
    );
    expect(codes(result).filter((code) => code === 'NON_SESSION_BAR')).toHaveLength(2);
    expect(result.closed).toEqual([]);

    const old = validate(split([{ ...series[0]!, session: '2025-12-31' }, ...series.slice(-198)]));
    expect(codes(old)).toContain('CALENDAR_OUT_OF_RANGE');
  });

  it('reports duplicate and missing sessions and never fills them', () => {
    const series = bars(wave);
    const duplicate = validate(
      split([...series.slice(0, 120), series[119]!, ...series.slice(120)]),
    );
    expect(codes(duplicate)).toEqual(['DUPLICATE_SESSION']);

    const missing = validate(split([...series.slice(0, 100), ...series.slice(103)]));
    expect(codes(missing)).toEqual(['MISSING_SESSION']);
    expect(missing.issues[0]?.detail).toMatch(/^3 session\(s\) missing from \d{4}-\d{2}-\d{2}/);
    expect(missing.closed).toEqual([]);
  });

  it('reports invalid OHLC', () => {
    const series = bars(wave);
    series[180] = { ...series[180]!, high: 90, low: 110 };
    series[181] = { ...series[181]!, close: 0 };
    const result = validate(split(series));
    expect(codes(result)).toEqual(
      expect.arrayContaining(['HIGH_BELOW_LOW', 'NON_POSITIVE_PRICE', 'CLOSE_OUTSIDE_RANGE']),
    );
  });

  it('counts freshness in sessions: one session behind is fresh, two is stale', () => {
    expect(validate(split(bars(wave, 200, '2026-10-26'))).fresh).toBe(true);
    const stale = validate(split(bars(wave, 200, '2026-10-23')));
    expect(stale.structurallyValid).toBe(true);
    expect(stale.fresh).toBe(false);
  });

  it('fails outright when the scan time is outside the published calendar', () => {
    const result = validate(split(bars(wave)), utc('2029-01-03T12:00:00Z'));
    expect(codes(result)).toEqual(['CALENDAR_OUT_OF_RANGE']);
    expect(result.structurallyValid).toBe(false);
  });
});

describe('split adjustment', () => {
  // A 4-for-1 split on the 150th of 200 sessions.
  const series = bars(wave);
  const splitSession = series[150]!.session;
  const splits = [{ session: splitSession, ratio: 4 }];
  const raw = series.map((bar, i) =>
    i < 150
      ? { ...bar, open: bar.open * 4, high: bar.high * 4, low: bar.low * 4, close: bar.close * 4 }
      : bar,
  );

  it('accepts split-adjusted OHLC across the split', () => {
    const result = validate({ adjustment: 'SPLIT', bars: series, splits });
    expect(result.structurallyValid).toBe(true);
  });

  it('catches a split still in the prices, which would read as a 75% crash', () => {
    const result = validate({ adjustment: 'SPLIT', bars: raw, splits });
    expect(codes(result)).toEqual(['UNADJUSTED_SPLIT']);
    expect(result.issues[0]?.detail).toContain(`4:1 split on ${splitSession}`);
  });

  it('catches an adjusted close mixed with raw high and low', () => {
    const mixed = raw.map((bar, i) => ({ ...bar, close: series[i]!.close }));
    const result = validate({ adjustment: 'SPLIT', bars: mixed, splits: [] });
    expect(codes(result)).toContain('CLOSE_OUTSIDE_RANGE');
  });

  it('refuses any adjustment basis other than split-only', () => {
    for (const adjustment of ['NONE', 'SPLIT_AND_DIVIDEND'] as const) {
      expect(codes(validate({ adjustment, bars: series, splits: [] }))).toEqual([
        'ADJUSTMENT_BASIS_MISMATCH',
      ]);
    }
  });

  it('scores a consistently adjusted series the same at any price scale', () => {
    const base = validate(split(series)).closed;
    const scaled = base.map((bar) => ({
      ...bar,
      open: bar.open * 4,
      high: bar.high * 4,
      low: bar.low * 4,
      close: bar.close * 4,
    }));
    const a = evaluateCandles(base) as CanonicalScore;
    const b = evaluateCandles(scaled) as CanonicalScore;
    expect(a.status).toBe('OK');
    expect(b.signal_score).toBe(a.signal_score);
    expect(b.regime).toBe(a.regime);
  });

  it('is exercised on the same sessions the fixtures use', () => {
    expect(sessionsEndingAt(3)).toEqual(['2026-10-23', '2026-10-26', '2026-10-27']);
  });
});
