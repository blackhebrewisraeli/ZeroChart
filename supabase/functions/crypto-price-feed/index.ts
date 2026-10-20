// Binance spot → assets_status crypto quotes, triggered every 15 minutes by
// pg_cron (20261021000000_schedule_crypto_price_feed.sql). Replaces the
// archived trading-agent scanner, so check_paper_transaction's 2-hour quote
// age check passes again.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { BINANCE_URL, toRows } from './prices.ts';

// Service role bypasses RLS: clients lost write access in 20261020230000.
const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
);

// The platform's verify_jwt only understands legacy JWT keys, so it is off
// (supabase/config.toml) and the caller must present a project secret key, which
// only the cron job holds (Vault). Anyone else could burn our Binance rate limit.
const secretKeys: unknown[] = Object.values(
  JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}'),
);

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const apikey = req.headers.get('apikey');
  if (!apikey || !secretKeys.includes(apikey)) return json({ error: 'Unauthorized' }, 401);

  let body: unknown;
  try {
    body = await (await fetch(BINANCE_URL, { signal: AbortSignal.timeout(5000) })).json();
  } catch {
    return json({ error: 'Binance unreachable' }, 502);
  }
  const rows = toRows(body);
  if (rows.length === 0) return json({ error: 'Binance returned no prices', binance: body }, 502);

  const { error } = await supabase.from('assets_status').upsert(rows, { onConflict: 'ticker' });
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, updated: rows.map((row) => row.ticker) }, 200);
});
