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
}

export type ParsedSignal = { ok: true; signal: SignalInsert } | { ok: false; error: string };

/** What the Pine script sends until ZeroChart injects the user's token. */
export const SECRET_PLACEHOLDER = 'USER_SECRET_PLACEHOLDER';

const TICKER = /^[A-Z0-9.=-]{1,20}$/;
const MAX_EVENT_ID = 64;

/** Pine's str.tostring() sends numbers as strings, so accept both. */
function num(value: unknown): number {
  if (typeof value === 'number') return value;
  return typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
}

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
  const ticker = upper(fields['ticker']).replace(/^[A-Z0-9_]+:/, '');
  if (!TICKER.test(ticker)) return { ok: false, error: 'ticker is invalid' };
  const action = upper(fields['action']);
  if (action !== 'BUY' && action !== 'SELL') {
    return { ok: false, error: 'action must be BUY or SELL' };
  }
  const score = num(fields['signal_score']);
  if (!(score >= 0 && score <= 100)) return { ok: false, error: 'signal_score must be 0-100' };
  const price = num(fields['price']);
  if (!(Number.isFinite(price) && price > 0)) {
    return { ok: false, error: 'price must be greater than zero' };
  }
  const quantity = num(fields['quantity']);
  if (!(Number.isFinite(quantity) && quantity > 0)) {
    return { ok: false, error: 'quantity must be greater than zero' };
  }
  const stop = fields['stop_loss'] == null ? null : num(fields['stop_loss']);
  if (stop !== null && !(Number.isFinite(stop) && stop > 0)) {
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
    },
  };
}

/** Matches Postgres `encode(sha256(convert_to(token, 'UTF8')), 'hex')`. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
