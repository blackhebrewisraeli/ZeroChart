// Pure parsing for the TradingView alert body: no Deno or Supabase imports, so
// vitest covers it from src/test.

export interface SignalInsert {
  ticker: string;
  action: 'BUY' | 'SELL';
  conviction_score: number;
  suggested_size: number;
  stop_loss: number | null;
}

export type ParsedSignal =
  { ok: true; token: string; signal: SignalInsert } | { ok: false; error: string };

const TICKER = /^[A-Z0-9.=-]{1,20}$/;

/** Pine's str.tostring() sends numbers as strings, so accept both. */
function num(value: unknown): number {
  if (typeof value === 'number') return value;
  return typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
}

export function parseSignal(body: unknown): ParsedSignal {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Body must be a JSON object' };
  }
  const fields = body as Record<string, unknown>;
  const token = fields['secret_token'];
  if (typeof token !== 'string' || token === '') {
    return { ok: false, error: 'secret_token is required' };
  }
  // {{ticker}} is bare ("BTCUSDT"); "{{exchange}}:{{ticker}}" is accepted too.
  const ticker = String(fields['ticker'] ?? '')
    .trim()
    .toUpperCase()
    .replace(/^[A-Z0-9_]+:/, '');
  if (!TICKER.test(ticker)) return { ok: false, error: 'ticker is invalid' };
  const action = String(fields['action'] ?? '')
    .trim()
    .toUpperCase();
  if (action !== 'BUY' && action !== 'SELL') {
    return { ok: false, error: 'action must be BUY or SELL' };
  }
  const score = num(fields['score']);
  if (!(score >= 0 && score <= 100)) return { ok: false, error: 'score must be 0-100' };
  const size = num(fields['size']);
  if (!(Number.isFinite(size) && size > 0)) {
    return { ok: false, error: 'size must be greater than zero' };
  }
  const stop = fields['stop_loss'] == null ? null : num(fields['stop_loss']);
  if (stop !== null && !(Number.isFinite(stop) && stop > 0)) {
    return { ok: false, error: 'stop_loss must be greater than zero' };
  }
  return {
    ok: true,
    token,
    signal: {
      ticker,
      action,
      conviction_score: Math.round(score),
      suggested_size: size,
      stop_loss: stop,
    },
  };
}

/** Matches Postgres `encode(sha256(convert_to(token, 'UTF8')), 'hex')`. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
