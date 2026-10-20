// Yahoo Finance → assets_status equity and forex quotes, triggered every 15
// minutes by pg_cron (20261021010000_schedule_equity_forex_price_feed.sql).
// crypto-price-feed covers the crypto rows; nothing else has written these
// since the trading-agent scanner was archived on 2026-10-14.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { sparkUrls, toRows } from './quotes.ts';

// Service role bypasses RLS: clients lost write access in 20261020230000.
const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
);

// Same gate as crypto-price-feed: verify_jwt is off (supabase/config.toml), so
// only a caller holding a project secret key (the cron job, via Vault) gets in.
const secretKeys: unknown[] = Object.values(
  JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}'),
);

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

// Yahoo answers 429 to non-browser user agents. A failed batch reads as null,
// so its tickers just keep their old (soon stale) row and the rest still land.
const fetchBatch = (url: string): Promise<unknown> =>
  fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) })
    .then((res) => res.json())
    .catch(() => null);

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const apikey = req.headers.get('apikey');
  if (!apikey || !secretKeys.includes(apikey)) return json({ error: 'Unauthorized' }, 401);

  // The table's own rows are the watchlist, so covering a new ticker is one insert.
  const { data, error: readError } = await supabase.from('assets_status').select('ticker');
  if (readError) return json({ error: readError.message }, 500);

  const bodies = await Promise.all(sparkUrls(data.map((row) => row.ticker)).map(fetchBatch));
  const rows = bodies.flatMap((body) => toRows(body));
  if (rows.length === 0) return json({ error: 'Yahoo returned no prices', yahoo: bodies }, 502);

  const { error } = await supabase.from('assets_status').upsert(rows, { onConflict: 'ticker' });
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, updated: rows.map((row) => row.ticker) }, 200);
});
