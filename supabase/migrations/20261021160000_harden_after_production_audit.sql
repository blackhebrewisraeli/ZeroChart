-- Fixes from the 2026-10-21 production audit (Supabase advisors, pg_net
-- responses and Edge Function logs).

-- 1. virtual_trades: a leftover of the archived trading-agent that no migration
-- creates and no code reads. Its policies let anyone with the public key read,
-- insert and update rows. Lock it to service_role and keep the rows; it exists
-- only in production, hence the guard.
do $$
begin
  if to_regclass('public.virtual_trades') is not null then
    drop policy if exists "Allow public INSERT" on public.virtual_trades;
    drop policy if exists "Allow public SELECT" on public.virtual_trades;
    drop policy if exists "Allow public UPDATE" on public.virtual_trades;
    revoke all on table public.virtual_trades from anon, authenticated;
  end if;
end $$;

-- 2. Evaluate auth.uid() once per query instead of once per row (advisor
-- auth_rls_initplan), and scope the alert policies to signed-in users; anon
-- never matched them anyway.
alter policy "Users can view their own portfolio" on public.user_portfolios
  to authenticated using ((select auth.uid()) = user_id);
alter policy "Users can insert their own portfolio" on public.user_portfolios
  to authenticated with check ((select auth.uid()) = user_id);
alter policy "Users can update their own portfolio" on public.user_portfolios
  to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "Users can delete their own portfolio" on public.user_portfolios
  to authenticated using ((select auth.uid()) = user_id);

alter policy "Users can view their own alerts" on public.user_alerts
  to authenticated using ((select auth.uid()) = user_id);
alter policy "Users can insert their own alerts" on public.user_alerts
  to authenticated with check ((select auth.uid()) = user_id);
alter policy "Users can update their own alerts" on public.user_alerts
  to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "Users can delete their own alerts" on public.user_alerts
  to authenticated using ((select auth.uid()) = user_id);

-- 3. Pin the trigger function's search_path (advisor function_search_path_mutable).
alter function public.set_updated_at() set search_path = '';

-- 4. 20261020120000 revoked EXECUTE from PUBLIC, but Supabase also grants it to
-- anon directly. The function already rejects callers without a session.
revoke execute on function public.rotate_signal_webhook_token() from anon;

-- 5. About one feed run in six takes 10-19 s. pg_net gave up at 10 s and logged
-- a timeout although the function finished and wrote its rows, which buried
-- real failures in net._http_response. Same jobs, 30 s timeout; cron.schedule
-- replaces a job with the same name.
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
    timeout_milliseconds := 30000
  );
  $$
);

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
    timeout_milliseconds := 30000
  );
  $$
);
