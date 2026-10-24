-- Separate transport checks from executable strategy signals without rewriting
-- existing rows. NULL is intentionally retained as an unverified legacy value.
alter table public.trading_signals
  add column if not exists signal_kind text;

alter table public.trading_signals
  drop constraint if exists trading_signals_signal_kind_check;

alter table public.trading_signals
  add constraint trading_signals_signal_kind_check
  check (signal_kind is null or signal_kind in ('strategy', 'transport_test'));

create index if not exists trading_signals_pending_kind_idx
  on public.trading_signals (user_id, signal_kind, created_at desc)
  where status = 'PENDING';

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
  if tactical_signal.status <> 'PENDING' then
    raise exception 'Signal is no longer waiting' using errcode = 'check_violation';
  end if;
  if tactical_signal.signal_kind is distinct from 'strategy' then
    raise exception 'Only verified strategy signals can be executed' using errcode = 'check_violation';
  end if;
  if tactical_signal.exchange is null
     or tactical_signal.timeframe is null
     or tactical_signal.bar_time is null
     or tactical_signal.model_version is null
     or tactical_signal.model_version <> '1.0.0' then
    raise exception 'Signal strategy provenance is incomplete or unsupported' using errcode = 'check_violation';
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
    raise exception '%''s server price is over 2 hours old: its market is closed or the price feed is behind.',
      canonical_ticker using errcode = 'check_violation';
  end if;
  if abs(execution_price - server_price) > server_price * 0.005 then
    raise exception '% has moved more than 0.5%% from its server price. Try again after the next price refresh.',
      canonical_ticker using errcode = 'check_violation';
  end if;

  insert into public.paper_transactions (
    user_id, action, ticker, quantity, price, fees, signal_id, stop_price
  ) values (
    $2,
    tactical_signal.action,
    canonical_ticker,
    tactical_signal.quantity,
    execution_price,
    tactical_signal.quantity * execution_price * 0.0025,
    $1,
    case when tactical_signal.action = 'BUY' then tactical_signal.stop_loss end
  )
  returning * into inserted;

  update public.trading_signals
  set status = 'EXECUTED'
  where id = $1;

  return inserted;
end;
$$;

revoke all on function public.execute_tactical_signal(uuid, uuid, numeric) from public, anon;
grant execute on function public.execute_tactical_signal(uuid, uuid, numeric) to authenticated;
