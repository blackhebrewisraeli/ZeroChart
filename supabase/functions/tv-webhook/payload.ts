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
const TIMEFRAME = /^[0-9]{0,4}[A-Z]?$/;
const MODEL_VERSION = /^[0-9A-Za-z.-]{1,20}$/;
const MAX_EVENT_ID = 64;

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

/** Validates everything but the token; `now` buckets alerts that carry no event_id. */
export function parseSignal(body: unknown, now = new Date()): ParsedSignal {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Body must be a JSON object' };
  }
  const fields = body as Record<string, unknown>;
  // {{ticker}} is bare ("BTCUSDT"); "{{exchange}}:{{ticker}}" is accepted too.
  const [, prefix, ticker = ''] = /^(?:([A-Z0-9_]+):)?(.*)$/.exec(upper(fields['ticker'])) ?? [];
  if (!TICKER.test(ticker)) return { ok: false, error: 'ticker is invalid' };
  const exchange = fields['exchange'] == null ? prefix : upper(fields['exchange']);
  if (exchange !== undefined && !EXCHANGE.test(exchange)) {
    return { ok: false, error: 'exchange is invalid' };
  }
  const timeframe = fields['timeframe'] == null ? undefined : upper(fields['timeframe']);
  if (timeframe !== undefined && (timeframe === '' || !TIMEFRAME.test(timeframe))) {
    return { ok: false, error: 'timeframe is invalid' };
  }
  // Pine's `time` is epoch milliseconds; TradingView's {{time}} is ISO.
  const rawBarTime = fields['bar_time'];
  const barTime =
    rawBarTime == null
      ? undefined
      : new Date(typeof rawBarTime === 'string' ? rawBarTime : num(rawBarTime));
  if (barTime !== undefined && Number.isNaN(barTime.getTime())) {
    return { ok: false, error: 'bar_time is invalid' };
  }
  const modelVersion = fields['model_version'];
  if (
    modelVersion != null &&
    (typeof modelVersion !== 'string' || !MODEL_VERSION.test(modelVersion))
  ) {
    return { ok: false, error: 'model_version is invalid' };
  }
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
  const rawEventId = fields['event_id'] ?? '';
  if (typeof rawEventId !== 'string') return { ok: false, error: 'event_id must be a string' };
  // No event_id: the same ticker + action within one minute counts as one alert.
  const eventId = rawEventId.trim() || now.toISOString().slice(0, 16);
  if (eventId.length > MAX_EVENT_ID) return { ok: false, error: 'event_id is too long' };
  return {
    ok: true,
    signal: {
      ticker,
      action,
      signal_score: Math.round(score),
      price,
      quantity,
      stop_loss: stop,
      event_id: eventId,
      ...(exchange !== undefined ? { exchange } : {}),
      ...(timeframe !== undefined ? { timeframe } : {}),
      ...(barTime !== undefined ? { bar_time: barTime.toISOString() } : {}),
      ...(modelVersion != null ? { model_version: modelVersion } : {}),
    },
  };
}

/** Matches Postgres `encode(sha256(convert_to(token, 'UTF8')), 'hex')`. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
