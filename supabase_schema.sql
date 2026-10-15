-- ============================================================================
-- ZeroChart — Cloud Portfolio Persistence
-- ----------------------------------------------------------------------------
-- Run this script in the Supabase SQL editor to enable the "Save to Cloud"
-- feature. It creates a `user_portfolios` table (one row per user, positions
-- stored as JSONB) and locks it down with Row Level Security so a user can
-- only read and write their own row.
-- ============================================================================

-- gen_random_uuid() lives in pgcrypto on older Postgres releases.
create extension if not exists pgcrypto;

create table if not exists public.user_portfolios (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  positions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_portfolios_user_id_key unique (user_id)
);

-- Enable Row Level Security.
alter table public.user_portfolios enable row level security;

-- Users can read only their own portfolio row.
create policy "Users can view their own portfolio"
  on public.user_portfolios
  for select
  to authenticated
  using (auth.uid() = user_id);

-- Users can insert their own portfolio row.
create policy "Users can insert their own portfolio"
  on public.user_portfolios
  for insert
  to authenticated
  with check (auth.uid() = user_id);

-- Users can update their own portfolio row.
create policy "Users can update their own portfolio"
  on public.user_portfolios
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Users can delete their own portfolio row.
create policy "Users can delete their own portfolio"
  on public.user_portfolios
  for delete
  to authenticated
  using (auth.uid() = user_id);

-- Keep updated_at fresh on every write.
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
