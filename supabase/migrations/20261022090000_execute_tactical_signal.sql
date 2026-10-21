-- Execute a TradingView signal and append its Paper Trading fill in the same
-- database transaction. PostgreSQL functions run atomically: any exception
-- raised below (including by paper_transactions_check) rolls back both writes.

alter table public.paper_transactions
  add column if not exists signal_id uuid references public.trading_signals (id);

create unique index if not exists paper_transactions_signal_id_idx
  on public.paper_transactions (signal_id)
  where signal_id is not null;

-- Clients may still dismiss their own waiting signal, but only this RPC may
-- write EXECUTED. That prevents bypassing the fill by updating status directly.
alter policy "Users can resolve their own pending signals" on public.trading_signals
  using ((select auth.uid()) = user_id and status = 'PENDING')
  with check ((select auth.uid()) = user_id and status = 'DISMISSED');

-- Tighten all client and RPC paper fills from the old 5% band to 0.5%.
create or replace function public.check_paper_transaction()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  tolerance constant numeric := 0.005;
  max_quote_age_hours constant int := 2;
  rejected constant text := 'check_violation';
  cash numeric;
  held numeric;
  quote numeric;
  quoted_at timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));
  new.created_at := clock_timestamp();
  if new.action not in ('BUY', 'SELL') then
    return new;
  end if;

  select a.current_price, a.updated_at
  into quote, quoted_at
  from public.assets_status a
  where upper(a.ticker) = new.ticker and a.current_price > 0
  order by a.updated_at desc
  limit 1;

  if quote is null then
    raise exception '% has no server price, so Paper Trading can''t fill it', new.ticker
      using errcode = rejected;
  end if;
  if quoted_at is null
    or quoted_at < new.created_at - make_interval(hours => max_quote_age_hours) then
    raise exception '%''s server price is over % hours old. Try again after the next price refresh.',
      new.ticker, max_quote_age_hours
      using errcode = rejected;
  end if;
  if abs(new.price - quote) > quote * tolerance then
    raise exception '% has moved more than % from its server price. Try again after the next price refresh.',
      new.ticker, trim_scale(tolerance * 100) || '%'
      using errcode = rejected;
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
    raise exception 'Insufficient cash' using errcode = rejected;
  end if;
  if new.action = 'SELL' and new.quantity > held + 1e-9 then
    raise exception 'Insufficient shares' using errcode = rejected;
  end if;
  return new;
end;
$$;

create or replace function public.execute_tactical_signal(
  signal_id uuid,
  user_id uuid,
  execution_price numeric
)
returns public.paper_transactions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  tactical_signal public.trading_signals%rowtype;
  canonical_ticker text;
  server_price numeric;
  quote_time timestamptz;
  inserted public.paper_transactions%rowtype;
begin
  if (select auth.uid()) is null or (select auth.uid()) <> $2 then
    raise exception 'Not authorized to execute this signal' using errcode = '42501';
  end if;
  if execution_price is null or execution_price <= 0 then
    raise exception 'Execution price must be greater than zero' using errcode = '22003';
  end if;

  select s.*
  into tactical_signal
  from public.trading_signals s
  where s.id = $1 and s.user_id = $2
  for update;

  if not found then
    raise exception 'Signal not found' using errcode = 'P0002';
  end if;
  -- PENDING is the existing database value for a signal waiting for action.
  if tactical_signal.status <> 'PENDING' then
    raise exception 'Signal is no longer waiting' using errcode = 'check_violation';
  end if;

  select upper(a.ticker), a.current_price, a.updated_at
  into canonical_ticker, server_price, quote_time
  from public.assets_status a
  where a.current_price > 0
    and (
      regexp_replace(upper(a.ticker), '[^A-Z0-9]', '', 'g') =
        regexp_replace(upper(tactical_signal.ticker), '[^A-Z0-9]', '', 'g')
      or regexp_replace(
        regexp_replace(upper(tactical_signal.ticker), '[^A-Z0-9]', '', 'g'),
        'USDT$',
        'USD'
      ) = regexp_replace(upper(a.ticker), '[^A-Z0-9]', '', 'g')
    )
  order by
    (upper(a.ticker) = upper(tactical_signal.ticker)) desc,
    a.updated_at desc
  limit 1;

  if server_price is null then
    raise exception '% has no server price, so Paper Trading can''t fill it', tactical_signal.ticker
      using errcode = 'check_violation';
  end if;
  if quote_time is null or quote_time < clock_timestamp() - interval '2 hours' then
    raise exception '%''s server price is over 2 hours old. Try again after the next price refresh.',
      canonical_ticker using errcode = 'check_violation';
  end if;
  if abs(execution_price - server_price) > server_price * 0.005 then
    raise exception '% has moved more than 0.5%% from its server price. Try again after the next price refresh.',
      canonical_ticker using errcode = 'check_violation';
  end if;

  insert into public.paper_transactions (
    user_id,
    action,
    ticker,
    quantity,
    price,
    fees,
    signal_id
  ) values (
    $2,
    tactical_signal.action,
    canonical_ticker,
    tactical_signal.quantity,
    execution_price,
    tactical_signal.quantity * execution_price * 0.0025,
    $1
  )
  returning * into inserted;

  update public.trading_signals s
  set status = 'EXECUTED'
  where s.id = $1;

  return inserted;
end;
$$;

revoke all on function public.execute_tactical_signal(uuid, uuid, numeric) from public, anon;
grant execute on function public.execute_tactical_signal(uuid, uuid, numeric) to authenticated;
