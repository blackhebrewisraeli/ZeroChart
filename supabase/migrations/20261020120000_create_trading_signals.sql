-- TradingView alerts land here through the tv-webhook edge function (service
-- role). Users only read their own signals and move them out of PENDING.
create table if not exists public.trading_signals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null check (ticker ~ '^[A-Z0-9.=-]{1,20}$'),
  action text not null check (action in ('BUY', 'SELL')),
  conviction_score integer not null check (conviction_score between 0 and 100),
  suggested_size numeric not null check (suggested_size > 0),
  stop_loss numeric check (stop_loss > 0),
  status text not null default 'PENDING' check (status in ('PENDING', 'EXECUTED', 'DISMISSED')),
  created_at timestamptz not null default now()
);

create index if not exists trading_signals_pending_idx
  on public.trading_signals (user_id, created_at desc)
  where status = 'PENDING';

alter table public.trading_signals enable row level security;

-- Only `status` is client-writable: ticker, size and stop come from the webhook alone.
revoke all on table public.trading_signals from anon, authenticated;
grant select on table public.trading_signals to authenticated;
grant update (status) on table public.trading_signals to authenticated;

drop policy if exists "Users can read their own signals" on public.trading_signals;
create policy "Users can read their own signals"
  on public.trading_signals
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- A resolved (EXECUTED / DISMISSED) signal is final, so the audit trail can't be rewritten.
drop policy if exists "Users can resolve their own pending signals" on public.trading_signals;
create policy "Users can resolve their own pending signals"
  on public.trading_signals
  for update
  to authenticated
  using ((select auth.uid()) = user_id and status = 'PENDING')
  with check ((select auth.uid()) = user_id);

do $$
begin
  alter publication supabase_realtime add table public.trading_signals;
exception
  when duplicate_object then null;
end
$$;

-- One webhook secret per user, kept only as a SHA-256 hex digest. No policies:
-- tv-webhook reads it with the service role; users mint through the RPC below.
create table if not exists public.signal_webhook_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now()
);

alter table public.signal_webhook_tokens enable row level security;
revoke all on table public.signal_webhook_tokens from anon, authenticated;

-- Returns a fresh plaintext token once and replaces any previous one.
create or replace function public.rotate_signal_webhook_token()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  -- Two v4 UUIDs: 244 bits from pg_strong_random, no pgcrypto needed.
  token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  insert into public.signal_webhook_tokens (user_id, token_hash)
  values (auth.uid(), encode(sha256(convert_to(token, 'UTF8')), 'hex'))
  on conflict (user_id) do update
    set token_hash = excluded.token_hash, created_at = now();
  return token;
end;
$$;

revoke all on function public.rotate_signal_webhook_token() from public;
grant execute on function public.rotate_signal_webhook_token() to authenticated;
