create table if not exists public.shared_portfolios (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz not null default now(),
  -- Caps what a signed-in user can store per link (~300 holdings fit easily).
  constraint shared_portfolios_snapshot_size_check check (octet_length(snapshot::text) <= 65536)
);

create index if not exists shared_portfolios_user_id_created_at_idx
  on public.shared_portfolios (user_id, created_at desc);

alter table public.shared_portfolios enable row level security;

-- No table-level SELECT: a select policy would let anyone holding the public
-- anon key list every shared portfolio. Links stay unlisted — a snapshot is
-- readable only by its id through get_shared_portfolio(), which also keeps
-- user_id private.
revoke all on table public.shared_portfolios from anon, authenticated;
grant insert (id, user_id, snapshot) on table public.shared_portfolios to authenticated;

drop policy if exists "Users can publish their own portfolios" on public.shared_portfolios;
create policy "Users can publish their own portfolios"
  on public.shared_portfolios
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create or replace function public.get_shared_portfolio(share_id uuid)
returns table (id uuid, snapshot jsonb, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select sp.id, sp.snapshot, sp.created_at
  from public.shared_portfolios sp
  where sp.id = share_id;
$$;

revoke all on function public.get_shared_portfolio(uuid) from public;
grant execute on function public.get_shared_portfolio(uuid) to anon, authenticated;
