// Daily candles → assets_status analytics (SMAs, RSI, volume spike,
// risk/reward, Stable and Radar signals), triggered once a day by pg_cron
// (20261021020000_schedule_market_analytics.sql). Nothing has written these
// since the trading-agent scanner was archived on 2026-10-14. current_price,
// change_24h and updated_at stay with the two price feeds.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { candlesUrl, toRow, type AnalyticsRow } from './analytics.ts';

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

// One candles request per ticker, 10 at a time so Yahoo doesn't answer the
// burst with 429. A failed request reads as null, so that ticker keeps
// yesterday's analytics and the rest still land.
const CONCURRENCY = 10;
const fetchJson = (url: string): Promise<unknown> =>
  fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) })
    .then((res) => res.json())
    .catch(() => null);

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const apikey = req.headers.get('apikey');
  if (!apikey || !secretKeys.includes(apikey)) return json({ error: 'Unauthorized' }, 401);

  // The table's own rows are the watchlist, as in equity-forex-price-feed.
  const { data, error: readError } = await supabase.from('assets_status').select('ticker');
  if (readError) return json({ error: readError.message }, 500);

  const tickers: string[] = data.map((row) => row.ticker);
  const rows: AnalyticsRow[] = [];
  for (let i = 0; i < tickers.length; i += CONCURRENCY) {
    const batch = tickers.slice(i, i + CONCURRENCY);
    const bodies = await Promise.all(batch.map((ticker) => fetchJson(candlesUrl(ticker))));
    batch.forEach((ticker, j) => {
      const row = toRow(ticker, bodies[j]);
      if (row) rows.push(row);
    });
  }
  if (rows.length === 0) return json({ error: 'No candles for any ticker' }, 502);

  const { error } = await supabase.from('assets_status').upsert(rows, { onConflict: 'ticker' });
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, updated: rows.map((row) => row.ticker) }, 200);
});
