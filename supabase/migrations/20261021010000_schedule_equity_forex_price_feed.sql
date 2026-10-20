-- Refresh the equity and forex quotes in assets_status (AAPL, SPY, EURUSD=X,
-- ...) every 15 minutes through the equity-forex-price-feed Edge Function. The
-- trading-agent scanner that wrote them was archived on 2026-10-14, so every
-- paper fill on them fails check_paper_transaction's 2-hour quote age check.
--
-- Source: Yahoo Finance's keyless spark endpoint, which takes the scanner's
-- yfinance symbols as they are. Each row is stamped with Yahoo's
-- regularMarketTime, so a closed market keeps its last-close time and running
-- around the clock never makes a weekend quote look fresh.
--
-- Reuses the project_url and secret_key Vault secrets that
-- 20261021000000_schedule_crypto_price_feed.sql set up. Failed runs show up in
-- net._http_response.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- cron.schedule replaces a job with the same name, so re-running is safe.
select cron.schedule(
  'equity-forex-price-feed',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
      || '/functions/v1/equity-forex-price-feed',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-region', 'eu-west-1',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'secret_key')
    ),
    timeout_milliseconds := 10000
  );
  $$
);
