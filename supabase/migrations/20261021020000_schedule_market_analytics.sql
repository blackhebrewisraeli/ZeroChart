-- Refresh the analytics columns of assets_status (rsi_14, sma_50, sma_200,
-- volume_spike, risk_pct, reward_pct, stable_* and radar_*) once a day through
-- the market-analytics Edge Function. The trading-agent scanner that computed
-- them was archived on 2026-10-14, so the Markets table and Action Center show
-- its last signals next to fresh prices.
--
-- 21:45 UTC is after the US close in both summer (20:00) and winter (21:00).
-- It runs every day because crypto trades at weekends; on a weekend the
-- equity rows just recompute Friday's values.
--
-- Reuses the project_url and secret_key Vault secrets that
-- 20261021000000_schedule_crypto_price_feed.sql set up. Failed runs show up in
-- net._http_response.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- cron.schedule replaces a job with the same name, so re-running is safe.
-- One request per ticker takes a while, hence the longer timeout than the feeds.
select cron.schedule(
  'market-analytics',
  '45 21 * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
      || '/functions/v1/market-analytics',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-region', 'eu-west-1',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'secret_key')
    ),
    timeout_milliseconds := 120000
  );
  $$
);
