-- Refresh the crypto quotes in assets_status every 15 minutes through the
-- crypto-price-feed Edge Function. check_paper_transaction (20261020210000)
-- rejects fills against quotes over 2 hours old, and the trading-agent scanner
-- that wrote them was archived on 2026-10-14.
--
-- The schedule lives in the database rather than a GitHub Actions cron: Actions
-- schedules drift by tens of minutes, switch off after 60 days without commits,
-- and run from US runners that api.binance.com refuses (HTTP 451).
--
-- One-time setup per project, in the SQL editor (keys stay out of the repo):
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<sb_secret_... key>', 'secret_key');
-- Failed runs show up in net._http_response.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- cron.schedule replaces a job with the same name, so re-running is safe.
-- x-region keeps the function next to the eu-west-1 database and out of US
-- regions, where Binance answers 451.
select cron.schedule(
  'crypto-price-feed',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
      || '/functions/v1/crypto-price-feed',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-region', 'eu-west-1',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'secret_key')
    ),
    timeout_milliseconds := 10000
  );
  $$
);
