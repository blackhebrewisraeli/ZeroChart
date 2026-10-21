-- Core tables that existed before the Supabase migration history began:
-- assets_status, user_portfolios and user_alerts. They were created by hand and
-- by the retired drizzle/migrations, so a fresh database could not run the
-- later migrations that alter them. This file mirrors production as it stood
-- before 20261017221447; later columns (analytics_updated_at, fired_at) and
-- the write lockdown come from their own migrations.
--
-- Production already has all of this. Mark it applied there instead of
-- running it: supabase migration repair --status applied 20261017000000

create table if not exists public.assets_status (
  ticker text primary key,
  current_price numeric,
  stable_signal text,
  stable_explanation text,
  radar_signal text,
  radar_explanation text,
  risk_pct numeric,
  updated_at timestamptz,
  reward_pct numeric,
  volume_spike numeric,
  rsi_14 numeric,
  sma_50 numeric,
  sma_200 numeric,
  change_24h numeric
);

alter table public.assets_status enable row level security;

drop policy if exists "Allow anonymous read" on public.assets_status;
create policy "Allow anonymous read" on public.assets_status
  for select using (true);

create table if not exists public.user_portfolios (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  positions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_portfolios enable row level security;

drop policy if exists "Users can view their own portfolio" on public.user_portfolios;
create policy "Users can view their own portfolio" on public.user_portfolios
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists "Users can insert their own portfolio" on public.user_portfolios;
create policy "Users can insert their own portfolio" on public.user_portfolios
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "Users can update their own portfolio" on public.user_portfolios;
create policy "Users can update their own portfolio" on public.user_portfolios
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Users can delete their own portfolio" on public.user_portfolios;
create policy "Users can delete their own portfolio" on public.user_portfolios
  for delete to authenticated using (auth.uid() = user_id);

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

drop policy if exists "Users can view their own alerts" on public.user_alerts;
create policy "Users can view their own alerts" on public.user_alerts
  for select using (auth.uid() = user_id);
drop policy if exists "Users can insert their own alerts" on public.user_alerts;
create policy "Users can insert their own alerts" on public.user_alerts
  for insert with check (auth.uid() = user_id);
drop policy if exists "Users can update their own alerts" on public.user_alerts;
create policy "Users can update their own alerts" on public.user_alerts
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Users can delete their own alerts" on public.user_alerts;
create policy "Users can delete their own alerts" on public.user_alerts
  for delete using (auth.uid() = user_id);
