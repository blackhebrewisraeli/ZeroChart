// Binance spot → assets_status crypto quotes, triggered every 15 minutes by
// pg_cron (20261021000000_schedule_crypto_price_feed.sql). Replaces the
// archived trading-agent scanner, so check_paper_transaction's 2-hour quote
// age check passes again.
import { json, serveFeed, supabase } from '../_shared/feed.ts';
import { fetchJson, report } from '../_shared/telemetry.ts';
import { BINANCE_URL, TICKERS, toRows } from './prices.ts';

const FN = 'crypto-price-feed';

serveFeed(async () => {
  // The rows' current times, so the summary can age the tickers Binance misses.
  const { data, error: readError } = await supabase
    .from('assets_status')
    .select('ticker, updated_at')
    .in('ticker', TICKERS);
  if (readError) return json({ error: readError.message }, 500);

  const body = await fetchJson(FN, BINANCE_URL, 5000);
  if (body === null) return json({ error: 'Binance request failed' }, 502);
  const rows = toRows(body);
  if (rows.length === 0) return json({ error: 'Binance returned no prices', binance: body }, 502);

  const { error } = await supabase.from('assets_status').upsert(rows, { onConflict: 'ticker' });
  if (error) return json({ error: error.message }, 500);
  const stored = new Map(data.map((row) => [row.ticker, row.updated_at]));
  const written = new Map(rows.map((row) => [row.ticker, row.updated_at]));
  return json(report(FN, TICKERS, stored, written), 200);
});
