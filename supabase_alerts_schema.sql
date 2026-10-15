-- ZeroChart — Real-time price alerts
-- Run this script in the Supabase SQL Editor to create the `user_alerts` table
-- and its row-level security (RLS) policies.

create extension if not exists "pgcrypto";

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

-- Users can only read their own alerts.
drop policy if exists "Users can view their own alerts" on public.user_alerts;
create policy "Users can view their own alerts"
  on public.user_alerts for select
  using (auth.uid() = user_id);

-- Users can only insert alerts that belong to themselves.
drop policy if exists "Users can insert their own alerts" on public.user_alerts;
create policy "Users can insert their own alerts"
  on public.user_alerts for insert
  with check (auth.uid() = user_id);

-- Users can only update (e.g. deactivate) their own alerts.
drop policy if exists "Users can update their own alerts" on public.user_alerts;
create policy "Users can update their own alerts"
  on public.user_alerts for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Users can only delete their own alerts.
drop policy if exists "Users can delete their own alerts" on public.user_alerts;
create policy "Users can delete their own alerts"
  on public.user_alerts for delete
  using (auth.uid() = user_id);
