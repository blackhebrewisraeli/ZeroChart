-- Paper Trading's ledger: one append-only row per fill, top-up or reset. The
-- client replays these rows (replayPaperLedger in portfolioAccounting.ts) into
-- holdings, cash and FIFO realized P&L; the trigger below rejects any fill the
-- account can't cover, so the replay never meets an impossible row.
create table if not exists public.paper_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  action text not null check (action in ('BUY', 'SELL', 'DEPOSIT', 'RESET')),
  ticker text check (ticker ~ '^[A-Z0-9.=-]{1,20}$'),
  -- Units for BUY / SELL, USD for DEPOSIT.
  quantity numeric check (quantity > 0),
  price numeric check (price > 0),
  fees numeric not null default 0 check (fees >= 0),
  created_at timestamptz not null default now(),
  constraint paper_transactions_shape_check check (
    case
      when action in ('BUY', 'SELL') then
        ticker is not null and quantity is not null and price is not null
      when action = 'DEPOSIT' then
        ticker is null and quantity is not null and price is null and fees = 0
      else ticker is null and quantity is null and price is null and fees = 0
    end
  )
);

create index if not exists paper_transactions_user_created_idx
  on public.paper_transactions (user_id, created_at);

alter table public.paper_transactions enable row level security;

-- Append-only: no UPDATE or DELETE for clients. id, user_id and created_at are
-- server-set, so a row can't be backdated or booked to another account.
revoke all on table public.paper_transactions from anon, authenticated;
grant select on table public.paper_transactions to authenticated;
grant insert (action, ticker, quantity, price, fees)
  on table public.paper_transactions to authenticated;

drop policy if exists "Users can read their own paper transactions" on public.paper_transactions;
create policy "Users can read their own paper transactions"
  on public.paper_transactions
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can record their own paper transactions" on public.paper_transactions;
create policy "Users can record their own paper transactions"
  on public.paper_transactions
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

-- Carry over each account's last cloud-saved Paper Trading ledger from the
-- user_portfolios JSONB snapshot. Runs before the trigger exists: those fills
-- were already accepted by the client engine. Each row is nudged `ord`
-- microseconds past its timestamp so the replay keeps the snapshot's order.
with entries as (
  select up.user_id, e.t, e.ord
  from public.user_portfolios up
  cross join lateral jsonb_array_elements(
    case
      when jsonb_typeof(up.positions #> '{portfolios,paper_trading,transactions}') = 'array'
        then up.positions #> '{portfolios,paper_trading,transactions}'
      else '[]'::jsonb
    end
  ) with ordinality as e(t, ord)
  where not exists (
    select 1 from public.paper_transactions pt where pt.user_id = up.user_id
  )
),
parsed as (
  select
    user_id,
    upper(t ->> 'type') as action,
    upper(btrim(t ->> 'ticker')) as ticker,
    case when jsonb_typeof(t -> 'shares') = 'number' then (t ->> 'shares')::numeric end as shares,
    case when jsonb_typeof(t -> 'price') = 'number' then (t ->> 'price')::numeric end as price,
    case when jsonb_typeof(t -> 'amount') = 'number' then (t ->> 'amount')::numeric end as amount,
    coalesce(case when jsonb_typeof(t -> 'fee') = 'number' then (t ->> 'fee')::numeric end, 0)
      + coalesce(case when jsonb_typeof(t -> 'slippage') = 'number' then (t ->> 'slippage')::numeric end, 0)
      as fees,
    case
      when t ->> 'timestamp' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$'
        then (t ->> 'timestamp')::timestamptz + make_interval(secs => ord / 1000000.0)
    end as created_at
  from entries
)
insert into public.paper_transactions (user_id, action, ticker, quantity, price, fees, created_at)
select
  user_id,
  action,
  case when action = 'DEPOSIT' then null else ticker end,
  case when action = 'DEPOSIT' then amount else shares end,
  case when action = 'DEPOSIT' then null else price end,
  case when action = 'DEPOSIT' then 0 else fees end,
  created_at
from parsed
where created_at is not null
  and (
    (action = 'DEPOSIT' and amount > 0)
    or (
      action in ('BUY', 'SELL')
      and ticker ~ '^[A-Z0-9.=-]{1,20}$'
      and shares > 0
      and price > 0
      and fees >= 0
    )
  );

-- Server authority over every new row: a BUY must fit the account's cash and a
-- SELL its open shares, both replayed from this account's rows since its last
-- RESET. 100000 mirrors PAPER_STARTING_CASH in portfolioAccounting.ts.
create or replace function public.check_paper_transaction()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  cash numeric;
  held numeric;
begin
  -- One writer per account at a time, so two tabs can't spend the same cash.
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));
  -- Stamp after the lock: now() is the transaction start, which would sort a
  -- row that waited on the lock before the row it waited for.
  new.created_at := clock_timestamp();
  if new.action not in ('BUY', 'SELL') then
    return new;
  end if;

  select
    100000 + coalesce(sum(
      case pt.action
        when 'DEPOSIT' then pt.quantity
        when 'BUY' then -(pt.quantity * pt.price + pt.fees)
        when 'SELL' then pt.quantity * pt.price - pt.fees
        else 0
      end
    ), 0),
    coalesce(sum(
      case
        when pt.ticker = new.ticker and pt.action = 'BUY' then pt.quantity
        when pt.ticker = new.ticker and pt.action = 'SELL' then -pt.quantity
        else 0
      end
    ), 0)
  into cash, held
  from public.paper_transactions pt
  where pt.user_id = new.user_id
    and pt.created_at > coalesce(
      (
        select max(r.created_at)
        from public.paper_transactions r
        where r.user_id = new.user_id and r.action = 'RESET'
      ),
      '-infinity'
    );

  if new.action = 'BUY' and new.quantity * new.price + new.fees > cash then
    raise exception 'Insufficient cash' using errcode = 'check_violation';
  end if;
  -- 1e-9 matches the engine's ZERO_SHARE_EPSILON, so "sell all" of a
  -- float-summed position still clears.
  if new.action = 'SELL' and new.quantity > held + 1e-9 then
    raise exception 'Insufficient shares' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.check_paper_transaction() from public;

drop trigger if exists paper_transactions_check on public.paper_transactions;
create trigger paper_transactions_check
  before insert on public.paper_transactions
  for each row execute function public.check_paper_transaction();
