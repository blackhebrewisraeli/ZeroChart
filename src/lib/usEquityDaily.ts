/**
 * The us-equity-daily-v1 candle contract: US-listed stocks and ETFs on daily
 * bars of the regular NYSE/Nasdaq session, keyed by exchange-local session
 * date. docs/EQUITY_DATA.md is the specification; this file enforces it.
 *
 * It is not the crypto policy with different numbers. Crypto days are 24h UTC
 * intervals that close at 23:59:59.999 every day; an equity bar is one
 * trading session in America/New_York, with weekends, exchange holidays,
 * 13:00 early closes and daylight-saving shifts between sessions. So a missing
 * bar is a missing *session*, not a missing 24h step, and freshness is counted
 * in sessions, not hours.
 *
 * Like binance-daily-v1 it never repairs data: no forward-fill, deduplication,
 * interpolation or re-adjustment. A series either passes as the provider sent
 * it or is reported with every issue found.
 */
import type { Candle } from '@/lib/binance';
import { issue, validatePrices, type CandleIssue } from '@/lib/candleValidation';

export const US_EQUITY_DAILY_CANDLE_POLICY_VERSION = 'us-equity-daily-v1' as const;

/**
 * NYSE holidays and early closes as published at
 * https://www.nyse.com/markets/hours-calendars (retrieved 2026-10-28). Nasdaq,
 * NYSE Arca and Cboe follow the same calendar for the regular session. The
 * table ends where the exchange's own publication ends; a scan outside it is
 * reported as CALENDAR_OUT_OF_RANGE rather than guessed.
 */
export const US_EQUITY_CALENDAR = {
  source: 'NYSE hours-calendars, retrieved 2026-10-28',
  firstYear: 2026,
  lastYear: 2028,
} as const;

const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19',
  '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18',
  '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
  '2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-06-19', '2028-07-04',
  '2028-09-04', '2028-11-23', '2028-12-25',
]); // prettier-ignore

/** 13:00 ET closes. */
const EARLY_CLOSES = new Set([
  '2026-11-27', '2026-12-24', '2027-11-26', '2028-07-03', '2028-11-24',
]); // prettier-ignore

const DAY_MS = 86_400_000;

function isoDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** Every regular session in the published calendar, oldest first. */
const SESSIONS: readonly string[] = (() => {
  const sessions: string[] = [];
  const end = Date.UTC(US_EQUITY_CALENDAR.lastYear + 1, 0, 1);
  for (let day = Date.UTC(US_EQUITY_CALENDAR.firstYear, 0, 1); day < end; day += DAY_MS) {
    const weekday = new Date(day).getUTCDay();
    const date = isoDay(day);
    if (weekday !== 0 && weekday !== 6 && !HOLIDAYS.has(date)) sessions.push(date);
  }
  return sessions;
})();
const SESSION_INDEX = new Map(SESSIONS.map((session, index) => [session, index]));

const ET_OFFSET = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  timeZoneName: 'longOffset',
});

/**
 * UTC time of an America/New_York wall-clock time on a session date. The
 * offset comes from the runtime's time-zone database, so EST/EDT follows the
 * law in force rather than a hard-coded rule. 09:30, 13:00 and 16:00 are never
 * within the 02:00 switch hour, so one lookup is exact.
 */
function newYorkTime(session: string, hour: number, minute: number): number {
  const [year, month, day] = session.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const name = ET_OFFSET.formatToParts(wall + 5 * 3_600_000).find(
    (part) => part.type === 'timeZoneName',
  )?.value;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name ?? '');
  if (!match) throw new Error(`No America/New_York offset for ${session}`);
  const minutes = (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '-' ? -1 : 1);
  return wall - minutes * 60_000;
}

export function isEarlyClose(session: string): boolean {
  return EARLY_CLOSES.has(session);
}

/** Regular-session open (09:30 ET) in epoch ms. */
export function sessionOpen(session: string): number {
  return newYorkTime(session, 9, 30);
}

/** Regular-session close (16:00 ET, 13:00 on an early close) in epoch ms. */
export function sessionClose(session: string): number {
  return isEarlyClose(session) ? newYorkTime(session, 13, 0) : newYorkTime(session, 16, 0);
}

/**
 * How long after the scheduled close a session's bar counts as final. Closing
 * auctions print just after 16:00, late reports and corrections follow (Tiingo
 * documents corrections until 20:00 ET), and Massive's free tier serves a day
 * only after midnight ET. Nine hours (01:00 ET; 22:00 ET after an early close)
 * clears all of them, so a scan never scores a bar that can still change.
 */
export const FINAL_BAR_DELAY_MS = 9 * 3_600_000;

/** A session is final once FINAL_BAR_DELAY_MS has passed since its close. */
export function sessionFinalAt(session: string): number {
  return sessionClose(session) + FINAL_BAR_DELAY_MS;
}

/**
 * The latest session whose bar is final at `time`; null when `time` falls
 * outside the published calendar, so the answer is never guessed.
 */
let finalTimes: number[] | null = null;

export function latestFinalSession(time: number): string | null {
  if (time >= newYorkTime(`${US_EQUITY_CALENDAR.lastYear + 1}-01-01`, 0, 0)) return null;
  finalTimes ??= SESSIONS.map(sessionFinalAt);
  for (let index = finalTimes.length - 1; index >= 0; index -= 1) {
    if (finalTimes[index]! <= time) return SESSIONS[index]!;
  }
  return null;
}

/** Every session from `from` to `to`, inclusive. */
export function tradingSessions(from: string, to: string): string[] {
  return SESSIONS.filter((session) => session >= from && session <= to);
}

/** The session `count - 1` sessions before `session` (inclusive window start); null before the calendar. */
export function sessionsBack(session: string, count: number): string | null {
  const index = SESSION_INDEX.get(session);
  if (index === undefined || index - (count - 1) < 0) return null;
  return SESSIONS[index - (count - 1)] ?? null;
}

/**
 * Configured US-listed instruments and their type. A ticker absent here is not
 * scanned even with a provider: identity is explicit, never inferred from the
 * ticker's shape. All trade on the consolidated US tape in the regular session.
 */
export const US_EQUITY_INSTRUMENTS: Readonly<Record<string, 'stock' | 'etf'>> = Object.fromEntries([
  ...'AAL AAPL ABBV ABNB ACN ADBE AFRM AMD AMZN AVGO AXP BA BAC C CAT COIN COST CRM CSCO CVX DIS DKNG F GE GM GOOGL GS HD HON HOOD IBM INTC JNJ JPM KO LCID LMT MA MCD META MRK MRNA MS MSFT NFLX NKE NVDA ORCL PEP PFE PG PINS PLTR PYPL QCOM RBLX RIVN RTX SHOP SNAP SOFI TSLA TXN UBER UNH V VZ WFC WMT XOM XYZ'
    .split(' ')
    .map((ticker) => [ticker, 'stock'] as const),
  ...'ARKK DIA GLD IWM QQQ SLV SMH SPY VOO VTI XLB XLE XLF XLI XLK XLP XLU XLV XLY'
    .split(' ')
    .map((ticker) => [ticker, 'etf'] as const),
]);

/** The scanned instrument for a configured US equity or ETF; null when it is not mapped. */
export function usEquityInstrument(ticker: string): string | null {
  return Object.hasOwn(US_EQUITY_INSTRUMENTS, ticker) ? `US:${ticker}` : null;
}

/**
 * How a provider's prices are adjusted. The policy accepts SPLIT only: every
 * OHLC field divided by the same cumulative split factor, no dividend
 * adjustment. An unadjusted split is a fake crash in RSI, MACD and ATR;
 * dividend adjustment is a modelling choice that changes past readings on
 * every ex-date, and one of the candidate providers cannot supply it.
 */
export type EquityAdjustment = 'SPLIT' | 'SPLIT_AND_DIVIDEND' | 'NONE';
export const REQUIRED_ADJUSTMENT: EquityAdjustment = 'SPLIT';

/** One provider bar, keyed by its exchange-local session date. */
export interface EquityDailyBar {
  session: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** What an equity provider adapter returns for one symbol. */
export interface EquityDailySeries {
  adjustment: EquityAdjustment;
  bars: readonly EquityDailyBar[];
  /** Splits the provider reports, so an unadjusted one can be caught. Ratio is new shares per old. */
  splits: readonly { session: string; ratio: number }[];
}

/**
 * The provider-neutral seam. An adapter maps one vendor's response into the
 * contract and throws ProviderRateLimitError on 429, CandleProviderDataError
 * on an unparseable body, or Error otherwise. It holds its credential itself,
 * server-side; nothing here takes a key.
 */
export interface EquityDailyProvider {
  /** Names vendor, endpoint and licence in evidence, e.g. "tiingo-eod-commercial". */
  id: string;
  /** Requests in flight at once, from the vendor's documented limits. */
  concurrency: number;
  fetchDaily(symbol: string, range: { from: string; to: string }): Promise<EquityDailySeries>;
}

export interface UsEquityValidation {
  policyVersion: typeof US_EQUITY_DAILY_CANDLE_POLICY_VERSION;
  /** The window as engine candles: open 09:30 ET, close 16:00/13:00 ET, in epoch ms. */
  closed: Candle[];
  /** Bars in the window, valid or not. */
  windowSessions: number;
  /** Bars for sessions not yet final at the evaluation time (open, or closed under 9h ago). */
  excludedOpenCount: number;
  issues: CandleIssue[];
  structurallyValid: boolean;
  /** Latest final session at the evaluation time; null outside the calendar. */
  requiredSession: string | null;
  latestSession: string | null;
  latestCloseTime: number | null;
  /** True when the latest bar is the required session or the one before it. */
  fresh: boolean | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function placeIssue(bar: EquityDailyBar, index: number): CandleIssue | null {
  if (SESSION_INDEX.has(bar.session)) return null;
  const time = Date.parse(bar.session);
  const valid = ISO_DATE.test(bar.session) && Number.isFinite(time) && isoDay(time) === bar.session;
  if (!valid) {
    return issue('INVALID_SESSION_DATE', index, {}, `"${bar.session}" is not a YYYY-MM-DD date.`);
  }
  const year = Number(bar.session.slice(0, 4));
  if (year < US_EQUITY_CALENDAR.firstYear || year > US_EQUITY_CALENDAR.lastYear) {
    return issue(
      'CALENDAR_OUT_OF_RANGE',
      index,
      {},
      `${bar.session} is outside the published calendar (${US_EQUITY_CALENDAR.firstYear}–${US_EQUITY_CALENDAR.lastYear}).`,
    );
  }
  return issue(
    'NON_SESSION_BAR',
    index,
    {},
    `${bar.session} is a weekend or exchange holiday; a bar there is not a trading session.`,
  );
}

/**
 * Flags a split the provider reports inside the window whose price step is
 * still in the bars: the open after it sits near the previous close divided
 * by the ratio. ponytail: ratio-match heuristic within 15%; a genuine gap of
 * the same size on the split day would be flagged too, which is the safe side.
 */
function splitIssues(
  window: readonly EquityDailyBar[],
  splits: EquityDailySeries['splits'],
): CandleIssue[] {
  const issues: CandleIssue[] = [];
  for (const split of splits) {
    const index = window.findIndex((bar) => bar.session === split.session);
    const previous = window[index - 1];
    const bar = window[index];
    if (
      !previous ||
      !bar ||
      !Number.isFinite(split.ratio) ||
      split.ratio <= 0 ||
      Math.abs(Math.log(split.ratio)) < Math.log(1.25)
    )
      continue;
    const step = Math.log(previous.close / bar.open);
    if (Math.abs(step - Math.log(split.ratio)) < Math.log(1.15)) {
      issues.push(
        issue(
          'UNADJUSTED_SPLIT',
          index,
          { timestamp: sessionOpen(bar.session) },
          `A ${split.ratio}:1 split on ${split.session} is still a price step in the bars (close ${previous.close} → open ${bar.open}).`,
        ),
      );
    }
  }
  return issues;
}

/** ISO dates sort chronologically as strings; malformed ones still sort deterministically. */
function bySession(a: EquityDailyBar, b: EquityDailyBar): number {
  if (a.session === b.session) return 0;
  return a.session < b.session ? -1 : 1;
}

/**
 * Validates one provider series for a scan at `evaluationTime`: keeps the
 * last `modelWindow` final sessions and reports, without repairing, bad dates,
 * non-session bars, duplicates, missing sessions, invalid OHLC, a wrong
 * adjustment basis and unadjusted splits.
 */
export function validateUsEquityDailySeries(
  series: EquityDailySeries,
  options: { evaluationTime: number; modelWindow: number },
): UsEquityValidation {
  const requiredSession = latestFinalSession(options.evaluationTime);
  const empty: UsEquityValidation = {
    policyVersion: US_EQUITY_DAILY_CANDLE_POLICY_VERSION,
    closed: [],
    windowSessions: 0,
    excludedOpenCount: 0,
    issues: [],
    structurallyValid: false,
    requiredSession,
    latestSession: null,
    latestCloseTime: null,
    fresh: null,
  };
  if (requiredSession === null) {
    return {
      ...empty,
      issues: [
        issue(
          'CALENDAR_OUT_OF_RANGE',
          -1,
          {},
          `The scan time is outside the published calendar (${US_EQUITY_CALENDAR.firstYear}–${US_EQUITY_CALENDAR.lastYear}).`,
        ),
      ],
    };
  }
  const sorted = [...series.bars].sort(bySession);
  const final = sorted.filter((bar) => bar.session <= requiredSession);
  const window = final.slice(-options.modelWindow);
  const issues: CandleIssue[] = [];
  if (series.adjustment !== REQUIRED_ADJUSTMENT) {
    issues.push(
      issue(
        'ADJUSTMENT_BASIS_MISMATCH',
        -1,
        {},
        `Prices are ${series.adjustment}-adjusted; ${US_EQUITY_DAILY_CANDLE_POLICY_VERSION} needs ${REQUIRED_ADJUSTMENT}-adjusted OHLC.`,
      ),
    );
  }
  window.forEach((bar, index) => {
    const placed = placeIssue(bar, index);
    if (placed) issues.push(placed);
    const timestamp = placed ? Number.NaN : sessionOpen(bar.session);
    issues.push(...validatePrices({ ...bar, timestamp, closeTime: timestamp }, index));
  });
  for (let index = 1; index < window.length; index += 1) {
    const before = SESSION_INDEX.get(window[index - 1]!.session);
    const current = SESSION_INDEX.get(window[index]!.session);
    if (before === undefined || current === undefined) continue;
    if (current === before) {
      issues.push(
        issue(
          'DUPLICATE_SESSION',
          index,
          { timestamp: sessionOpen(window[index]!.session) },
          `${window[index]!.session} appears more than once; duplicates are not deduplicated.`,
        ),
      );
    } else if (current - before > 1) {
      issues.push(
        issue(
          'MISSING_SESSION',
          index,
          { timestamp: sessionOpen(window[index]!.session) },
          `${current - before - 1} session(s) missing from ${SESSIONS[before + 1]} before ${window[index]!.session}; none are filled.`,
        ),
      );
    }
  }
  issues.push(...splitIssues(window, series.splits));

  const latestSession = window.at(-1)?.session ?? null;
  const latestIndex = latestSession === null ? undefined : SESSION_INDEX.get(latestSession);
  const requiredIndex = SESSION_INDEX.get(requiredSession)!;
  const structurallyValid = issues.length === 0;
  return {
    ...empty,
    closed: structurallyValid
      ? window.map((bar) => ({
          timestamp: sessionOpen(bar.session),
          closeTime: sessionClose(bar.session),
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
        }))
      : [],
    windowSessions: window.length,
    excludedOpenCount: sorted.length - final.length,
    issues,
    structurallyValid,
    latestSession,
    latestCloseTime: latestIndex === undefined ? null : sessionClose(latestSession!),
    fresh: latestIndex === undefined ? null : latestIndex >= requiredIndex - 1,
  };
}
