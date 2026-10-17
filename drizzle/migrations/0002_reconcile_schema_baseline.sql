-- =============================================================================
-- ZeroChart — 0002: schema baseline reconciliation (M1-T1, finding F-3.1a)
-- -----------------------------------------------------------------------------
-- Idempotent and NON-DESTRUCTIVE: safe to run on fresh databases (after 0000 /
-- 0001, where `assets_status` was created with a legacy `symbol` column) and
-- on long-lived remotes whose tables were evolved out-of-band in the SQL
-- editor. Never drops or renames data destructively; the legacy `symbol`
-- column is intentionally RETAINED (drop deferred until a verified cleanup
-- migration). Mirrors `drizzle/schema.ts` and the ad-hoc root scripts
-- `supabase_schema.sql` / `supabase_alerts_schema.sql`.
-- =============================================================================

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- 1. assets_status — reconcile with the schema the application actually queries
-- -----------------------------------------------------------------------------

-- 1a. Ensure the ticker column exists (legacy 0000 created `symbol` instead).
alter table public.assets_status add column if not exists ticker text;

-- 1b. Backfill ticker from the legacy `symbol` column when it exists.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'assets_status' and column_name = 'symbol'
  ) then
    update public.assets_status
    set ticker = symbol
    where (ticker is null or ticker = '') and symbol is not null;
  end if;
end $$;

-- 1c. Indicator/analysis columns the application selects today
--     (assets.ts fetchAssets, generated types.ts).
alter table public.assets_status add column if not exists name text;
alter table public.assets_status add column if not exists current_price numeric;
alter table public.assets_status add column if not exists stable_signal text;
alter table public.assets_status add column if not exists stable_explanation text;
alter table public.assets_status add column if not exists radar_signal text;
alter table public.assets_status add column if not exists radar_explanation text;
alter table public.assets_status add column if not exists risk_pct numeric;
alter table public.assets_status add column if not exists reward_pct numeric;
alter table public.assets_status add column if not exists volume_spike numeric;
alter table public.assets_status add column if not exists rsi_14 numeric;
alter table public.assets_status add column if not exists sma_50 numeric;
alter table public.assets_status add column if not exists sma_200 numeric;
alter table public.assets_status add column if not exists change_24h numeric;

-- 1d. updated_at guarantees.
alter table public.assets_status alter column updated_at set default now();
do $$
begin
  if exists (select 1 from public.assets_status where updated_at is null) then
    update public.assets_status set updated_at = now() where updated_at is null;
  end if;
  alter table public.assets_status alter column updated_at set not null;
end $$;

-- 1e. ticker uniqueness + NOT NULL (applied after the backfill; NOT NULL is
--     skipped when orphan rows still lack a ticker so nothing is destroyed).
create unique index if not exists assets_status_ticker_key
  on public.assets_status (ticker);
do $$
begin
  if not exists (select 1 from public.assets_status where ticker is null) then
    alter table public.assets_status alter column ticker set not null;
  end if;
end $$;

-- 1f. Signal value checks (mirror 0000; only added when absent).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.assets_status'::regclass
      and conname = 'assets_status_stable_signal_check'
  ) then
    alter table public.assets_status
      add constraint assets_status_stable_signal_check
      check (stable_signal in ('Green', 'Yellow', 'Red'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.assets_status'::regclass
      and conname = 'assets_status_radar_signal_check'
  ) then
    alter table public.assets_status
      add constraint assets_status_radar_signal_check
      check (radar_signal in ('Green', 'Yellow', 'Red'));
  end if;
end $$;

-- 1g. Public read-only access (idempotent grants) + RLS policy.
grant select on public.assets_status to anon, authenticated;
grant all on public.assets_status to service_role;
alter table public.assets_status enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'assets_status'
      and policyname = 'Public market signals are readable'
  ) then
    create policy "Public market signals are readable"
      on public.assets_status for select to anon, authenticated using (true);
  end if;
end $$;

-- NOTE: legacy column `public.assets_status.symbol` is intentionally retained
-- (non-destructive). Drop it in a future verified cleanup migration once no
-- external consumer depends on it.

-- -----------------------------------------------------------------------------
-- 2. user_portfolios — idempotent baseline (previously only an ad-hoc SQL
--    editor script; now tracked in migration history). See supabase_schema.sql.
-- -----------------------------------------------------------------------------
create table if not exists public.user_portfolios (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  positions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists user_portfolios_user_id_key
  on public.user_portfolios (user_id);
alter table public.user_portfolios enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public'
      and tablename = 'user_portfolios' and policyname = 'Users can view their own portfolio'
  ) then
    create policy "Users can view their own portfolio" on public.user_portfolios
      for select to authenticated using (auth.uid() = user_id);
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'public'
      and tablename = 'user_portfolios' and policyname = 'Users can insert their own portfolio'
  ) then
    create policy "Users can insert their own portfolio" on public.user_portfolios
      for insert to authenticated with check (auth.uid() = user_id);
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'public'
      and tablename = 'user_portfolios' and policyname = 'Users can update their own portfolio'
  ) then
    create policy "Users can update their own portfolio" on public.user_portfolios
      for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'public'
      and tablename = 'user_portfolios' and policyname = 'Users can delete their own portfolio'
  ) then
    create policy "Users can delete their own portfolio" on public.user_portfolios
      for delete to authenticated using (auth.uid() = user_id);
  end if;
end $$;
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists user_portfolios_set_updated_at on public.user_portfolios;
create trigger user_portfolios_set_updated_at
  before update on public.user_portfolios
  for each row
  execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 3. user_alerts — idempotent baseline (previously only an ad-hoc SQL editor
--    script). See supabase_alerts_schema.sql.
-- -----------------------------------------------------------------------------
create table if not exists public.user_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  ticker text not null,
  target_price numeric not null check (target_price > 0),
  condition text not null check (condition in ('above', 'below')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists user_alerts_user_id_active_idx
  on public.user_alerts (user_id, is_active);
alter table public.user_alerts enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public'
      and tablename = 'user_alerts' and policyname = 'Users can view their own alerts'
  ) then
    create policy "Users can view their own alerts" on public.user_alerts
      for select using (auth.uid() = user_id);
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'public'
      and tablename = 'user_alerts' and policyname = 'Users can insert their own alerts'
  ) then
    create policy "Users can insert their own alerts" on public.user_alerts
      for insert with check (auth.uid() = user_id);
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'public'
      and tablename = 'user_alerts' and policyname = 'Users can update their own alerts'
  ) then
    create policy "Users can update their own alerts" on public.user_alerts
      for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'public'
      and tablename = 'user_alerts' and policyname = 'Users can delete their own alerts'
  ) then
    create policy "Users can delete their own alerts" on public.user_alerts
      for delete using (auth.uid() = user_id);
  end if;
end $$;
