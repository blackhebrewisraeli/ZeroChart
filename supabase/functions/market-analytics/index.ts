// Daily candles → assets_status analytics (SMAs, RSI, volume spike,
// risk/reward, Stable and Radar signals), triggered once a day by pg_cron
// (20261021020000_schedule_market_analytics.sql). Nothing has written these
// since the trading-agent scanner was archived on 2026-10-14. current_price,
// change_24h and updated_at stay with the two price feeds; this run stamps
// analytics_updated_at instead.
import { json, serveFeed, supabase } from '../_shared/feed.ts';
import { fetchJson, report } from '../_shared/telemetry.ts';
import { candlesUrl, toRow, type AnalyticsRow } from './analytics.ts';

const FN = 'market-analytics';

// One candles request per ticker, 10 at a time so Yahoo doesn't answer the
// burst with 429. A failed request reads as null, so that ticker keeps
// yesterday's analytics, the rest still land and the summary counts it as
// skipped.
const CONCURRENCY = 10;

serveFeed(async () => {
  // The table's own rows are the watchlist, as in equity-forex-price-feed.
  const { data, error: readError } = await supabase
    .from('assets_status')
    .select('ticker, analytics_updated_at');
  if (readError) return json({ error: readError.message }, 500);

  const tickers: string[] = data.map((row) => row.ticker);
  const analyticsUpdatedAt = new Date().toISOString();
  const rows: (AnalyticsRow & { analytics_updated_at: string })[] = [];
  for (let i = 0; i < tickers.length; i += CONCURRENCY) {
    const batch = tickers.slice(i, i + CONCURRENCY);
    const bodies = await Promise.all(
      batch.map((ticker) => fetchJson(FN, candlesUrl(ticker), 10000)),
    );
    batch.forEach((ticker, j) => {
      const row = toRow(ticker, bodies[j]);
      if (row) rows.push({ ...row, analytics_updated_at: analyticsUpdatedAt });
    });
  }
  if (rows.length === 0) return json({ error: 'No candles for any ticker' }, 502);

  const { error } = await supabase.from('assets_status').upsert(rows, { onConflict: 'ticker' });
  if (error) return json({ error: error.message }, 500);
  const stored = new Map(data.map((row) => [row.ticker, row.analytics_updated_at]));
  const written = new Map(rows.map((row) => [row.ticker, row.analytics_updated_at]));
  return json(report(FN, tickers, stored, written), 200);
});
