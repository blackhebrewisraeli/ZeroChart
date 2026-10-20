// Yahoo Finance → assets_status equity and forex quotes, triggered every 15
// minutes by pg_cron (20261021010000_schedule_equity_forex_price_feed.sql).
// crypto-price-feed covers the crypto rows; nothing else has written these
// since the trading-agent scanner was archived on 2026-10-14.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { classifyTicker } from '../../../src/lib/ticker.ts';
import { fetchJson, report } from '../_shared/telemetry.ts';
import { sparkUrls, toRows } from './quotes.ts';

const FN = 'equity-forex-price-feed';

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

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const apikey = req.headers.get('apikey');
  if (!apikey || !secretKeys.includes(apikey)) return json({ error: 'Unauthorized' }, 401);

  // The table's own rows are the watchlist, so covering a new ticker is one insert.
  const { data, error: readError } = await supabase
    .from('assets_status')
    .select('ticker, updated_at');
  if (readError) return json({ error: readError.message }, 500);

  // A failed batch reads as null, so its tickers keep their old (soon stale)
  // row, the rest still land and the summary counts them as skipped.
  const expected: string[] = data
    .map((row) => row.ticker)
    .filter((ticker) => classifyTicker(ticker) !== 'crypto');
  const bodies = await Promise.all(sparkUrls(expected).map((url) => fetchJson(FN, url, 5000)));
  const rows = bodies.flatMap((body) => toRows(body));
  if (rows.length === 0) return json({ error: 'Yahoo returned no prices', yahoo: bodies }, 502);

  const { error } = await supabase.from('assets_status').upsert(rows, { onConflict: 'ticker' });
  if (error) return json({ error: error.message }, 500);
  const stored = new Map(data.map((row) => [row.ticker, row.updated_at]));
  const written = new Map(rows.map((row) => [row.ticker, row.updated_at]));
  return json(report(FN, expected, stored, written), 200);
});
