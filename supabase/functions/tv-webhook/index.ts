// TradingView alert webhook → trading_signals (PENDING). TradingView can't send
// a Supabase JWT, so verify_jwt is off (supabase/config.toml) and the body's
// secret_token, minted by rotate_signal_webhook_token(), identifies the user.
//
// TradingView cancels a delivery after 3 s, and every delivery boots a fresh
// worker. So no supabase-js (its cold import and client setup cost hundreds of
// milliseconds) and one PostgREST call that authenticates and inserts together.
import { handleWebhook, type Ingested } from './handler.ts';

const RPC = `${Deno.env.get('SUPABASE_URL') ?? ''}/rest/v1/rpc/ingest_tradingview_signal`;
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
// The RPC took 139-301 ms in production (2026-10-22); 2 s leaves the worker's
// boot and the network room inside TradingView's 3 s.
const INGEST_TIMEOUT_MS = 2000;

async function ingest(tokenHash: string, signal: unknown): Promise<Ingested> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token_hash: tokenHash, signal }),
    signal: AbortSignal.timeout(INGEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ingest_tradingview_signal ${res.status}: ${await res.text()}`);
  return (await res.json()) as Ingested;
}

Deno.serve((req) => handleWebhook(req, { ingest, log: console.log }));
