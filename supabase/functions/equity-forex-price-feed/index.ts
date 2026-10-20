// Yahoo Finance → assets_status equity and forex quotes, triggered every 15
// minutes by pg_cron (20261021010000_schedule_equity_forex_price_feed.sql).
// crypto-price-feed covers the crypto rows; nothing else has written these
// since the trading-agent scanner was archived on 2026-10-14.
import { json, serveFeed, supabase } from '../_shared/feed.ts';
import { classifyTicker } from '../../../src/lib/ticker.ts';
import { fetchJson, report } from '../_shared/telemetry.ts';
import { sparkUrls, toRows } from './quotes.ts';

const FN = 'equity-forex-price-feed';

serveFeed(async () => {
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
