// The tv-webhook request flow, free of Deno globals so vitest covers it from
// src/test. index.ts wires `ingest` to the ingest_tradingview_signal RPC.
import { parseSignal, readToken, sha256Hex, type SignalInsert } from './payload.ts';

/** The RPC's answer; 'authorized' only comes back for a null signal. */
export type Ingested = 'accepted' | 'duplicate' | 'unauthorized' | 'authorized';

export interface WebhookDeps {
  /** One database round trip: authenticates the token digest and, given a signal, records it. */
  ingest: (tokenHash: string, signal: SignalInsert | null) => Promise<Ingested>;
  /** Receives one JSON line per request. Never given the token or the raw body. */
  log: (line: string) => void;
  now?: () => number;
}

/** Every way a delivery can end, so the log explorer can count each one. */
export type Outcome =
  | 'accepted'
  | 'duplicate'
  | 'auth_missing'
  | 'auth_invalid'
  | 'validation_failed'
  | 'db_error'
  | 'bad_json'
  | 'method_not_allowed';

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/**
 * Acknowledges only after the signal row is committed (or found already
 * committed), and does nothing after that, so a 2xx always means durable.
 */
export async function handleWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  const now = deps.now ?? Date.now;
  const started = now();
  let signal: SignalInsert | null = null;
  const done = (outcome: Outcome, status: number, body: unknown, detail?: string) => {
    deps.log(
      JSON.stringify({
        fn: 'tv-webhook',
        event: 'delivery',
        outcome,
        status,
        ms: now() - started,
        ...(signal
          ? { ticker: signal.ticker, action: signal.action, event_id: signal.event_id }
          : {}),
        ...(detail ? { detail } : {}),
      }),
    );
    return json(body, status);
  };

  if (req.method !== 'POST')
    return done('method_not_allowed', 405, { error: 'Method not allowed' });

  // TradingView posts JSON alerts as text/plain unless the message parses, so read text.
  let body: unknown;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return done('bad_json', 400, { error: 'Body must be JSON' });
  }

  const token = readToken(body);
  if (!token) {
    return done('auth_missing', 401, { error: 'secret_token is missing or still the placeholder' });
  }
  const parsed = parseSignal(body);
  if (parsed.ok) signal = parsed.signal;

  let result: Ingested;
  try {
    result = await deps.ingest(await sha256Hex(token), signal);
  } catch (error) {
    return done('db_error', 500, { error: 'Could not record signal' }, String(error).slice(0, 200));
  }

  // Authenticate before reporting validation, so unknown callers learn nothing about the schema.
  if (result === 'unauthorized')
    return done('auth_invalid', 401, { error: 'Invalid secret_token' });
  if (!parsed.ok) return done('validation_failed', 400, { error: parsed.error }, parsed.error);
  if (result === 'duplicate') return done('duplicate', 200, { ok: true, duplicate: true });
  if (result === 'accepted') return done('accepted', 201, { ok: true });
  return done('db_error', 500, { error: 'Could not record signal' }, `unexpected ${result}`);
}
