// Pure parsing for the TradingView alert body: no Deno or Supabase imports, so
// vitest covers it from src/test.

export interface SignalInsert {
  ticker: string;
  action: 'BUY' | 'SELL';
  signal_score: number;
  /** Price on the chart when the alert fired. */
  price: number;
  /** Units of the asset (shares / coins), never dollars. */
  quantity: number;
  stop_loss: number | null;
  /** Idempotency key: one row per (user, ticker, action, event_id). */
  event_id: string;
  /** Source context; absent on alerts created before the HUD sent it. */
  exchange?: string;
  timeframe?: string;
  /** ISO open time of the bar that fired. */
  bar_time?: string;
  model_version?: string;
}

export type ParsedSignal = { ok: true; signal: SignalInsert } | { ok: false; error: string };

/** What the Pine script sends until ZeroChart injects the user's token. */
export const SECRET_PLACEHOLDER = 'USER_SECRET_PLACEHOLDER';

const TICKER = /^[A-Z0-9.=-]{1,20}$/;
const EXCHANGE = /^[A-Z0-9_]{1,20}$/;
// TradingView periods: "60", "240", "1D", "D", "W", "12M".
const TIMEFRAME = /^(\d{1,4}[A-Z]?|[A-Z])$/;
const MODEL_VERSION = /^[\dA-Za-z.-]{1,20}$/;
const MAX_EVENT_ID = 64;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
type SourceContext = Pick<SignalInsert, 'exchange' | 'timeframe' | 'bar_time' | 'model_version'>;

/** Pine's str.tostring() sends numbers as strings, so accept both. */
function num(value: unknown): number {
  if (typeof value === 'number') return value;
  return typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
}

const positive = (n: number) => Number.isFinite(n) && n > 0;

/** Non-strings become '' so objects can't sneak through as "[object Object]". */
function upper(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

/** The body's secret_token, or null when it is missing or still the placeholder. */
export function readToken(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const token = (body as Record<string, unknown>)['secret_token'];
  return typeof token === 'string' && token !== '' && token !== SECRET_PLACEHOLDER ? token : null;
}

/** Drops undefined values, so a field the alert didn't send stays absent. */
function defined<T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

/** Pine's `time` is epoch milliseconds; TradingView's {{time}} is ISO. null when unparseable. */
function isoTime(value: unknown): string | null | undefined {
  if (value == null) return undefined;
  const date = new Date(typeof value === 'string' ? value : num(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The idempotency key. No event_id: the same ticker + action within one minute counts as one alert. */
function parseEventId(raw: unknown, now: Date): Parsed<string> {
  if (raw != null && typeof raw !== 'string')
    return { ok: false, error: 'event_id must be a string' };
  const eventId = raw?.trim() || now.toISOString().slice(0, 16);
  if (eventId.length > MAX_EVENT_ID) return { ok: false, error: 'event_id is too long' };
  return { ok: true, value: eventId };
}

/** Where the alert came from; every field is optional, but a malformed one is refused. */
function parseContext(fields: Record<string, unknown>): Parsed<SourceContext> {
  // "{{exchange}}:{{ticker}}" carries the exchange when the alert sends no field for it.
  const prefix = /^([A-Z0-9_]+):/.exec(upper(fields['ticker']))?.[1];
  const exchange = fields['exchange'] == null ? prefix : upper(fields['exchange']);
  if (exchange !== undefined && !EXCHANGE.test(exchange)) {
    return { ok: false, error: 'exchange is invalid' };
  }
  const timeframe = fields['timeframe'] == null ? undefined : upper(fields['timeframe']);
  if (timeframe !== undefined && !TIMEFRAME.test(timeframe)) {
    return { ok: false, error: 'timeframe is invalid' };
  }
  const barTime = isoTime(fields['bar_time']);
  if (barTime === null) return { ok: false, error: 'bar_time is invalid' };
  const version = fields['model_version'];
  if (version != null && (typeof version !== 'string' || !MODEL_VERSION.test(version))) {
    return { ok: false, error: 'model_version is invalid' };
  }
  return {
    ok: true,
    value: defined({
      exchange,
      timeframe,
      bar_time: barTime,
      model_version: typeof version === 'string' ? version : undefined,
    }),
  };
}

/** Validates everything but the token; `now` buckets alerts that carry no event_id. */
export function parseSignal(body: unknown, now = new Date()): ParsedSignal {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Body must be a JSON object' };
  }
  const fields = body as Record<string, unknown>;
  // {{ticker}} is bare ("BTCUSDT"); "{{exchange}}:{{ticker}}" is accepted too.
  const ticker = upper(fields['ticker']).replace(/^[A-Z0-9_]+:/, '');
  if (!TICKER.test(ticker)) return { ok: false, error: 'ticker is invalid' };
  const action = upper(fields['action']);
  if (action !== 'BUY' && action !== 'SELL') {
    return { ok: false, error: 'action must be BUY or SELL' };
  }
  const score = num(fields['signal_score']);
  if (!(score >= 0 && score <= 100)) return { ok: false, error: 'signal_score must be 0-100' };
  const price = num(fields['price']);
  if (!positive(price)) {
    return { ok: false, error: 'price must be greater than zero' };
  }
  const quantity = num(fields['quantity']);
  if (!positive(quantity)) {
    return { ok: false, error: 'quantity must be greater than zero' };
  }
  const stop = fields['stop_loss'] == null ? null : num(fields['stop_loss']);
  if (stop !== null && !positive(stop)) {
    return { ok: false, error: 'stop_loss must be greater than zero' };
  }
  const eventId = parseEventId(fields['event_id'], now);
  if (!eventId.ok) return eventId;
  const context = parseContext(fields);
  if (!context.ok) return context;
  return {
    ok: true,
    signal: {
      ticker,
      action,
      signal_score: Math.round(score),
      price,
      quantity,
      stop_loss: stop,
      event_id: eventId.value,
      ...context.value,
    },
  };
}

/** Matches Postgres `encode(sha256(convert_to(token, 'UTF8')), 'hex')`. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
