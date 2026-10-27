-- Modern TradingView deliveries are idempotent by logical strategy event, not
-- by the provider's delivery-attempt id. Legacy rows keep their original key.
drop index if exists public.trading_signals_event_idx;

create unique index trading_signals_legacy_event_idx
  on public.trading_signals (user_id, ticker, action, event_id)
  where exchange is null or timeframe is null or bar_time is null or model_version is null;

create unique index trading_signals_logical_event_idx
  on public.trading_signals (
    user_id,
    signal_kind,
    upper(exchange),
    upper(ticker),
    (case when upper(timeframe) in ('D', '1D') then '1D' else upper(timeframe) end),
    model_version,
    action,
    bar_time
  )
  where exchange is not null and timeframe is not null and bar_time is not null and model_version is not null;

create or replace function public.ingest_tradingview_signal(token_hash text, signal jsonb)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  owner uuid;
  existing public.trading_signals%rowtype;
  modern boolean;
begin
  select t.user_id into owner
  from public.signal_webhook_tokens t
  where t.token_hash = $1;

  if owner is null then
    return 'unauthorized';
  end if;
  if signal is null then
    return 'authorized';
  end if;
  if signal ->> 'signal_kind' is null
     or signal ->> 'signal_kind' not in ('strategy', 'transport_test') then
    raise exception 'signal_kind must be strategy or transport_test' using errcode = 'check_violation';
  end if;

  modern := signal ->> 'exchange' is not null
    and signal ->> 'timeframe' is not null
    and signal ->> 'bar_time' is not null
    and signal ->> 'model_version' is not null;

  insert into public.trading_signals (
    user_id,
    signal_kind,
    ticker,
    action,
    signal_score,
    price,
    quantity,
    stop_loss,
    event_id,
    exchange,
    timeframe,
    bar_time,
    model_version
  ) values (
    owner,
    signal ->> 'signal_kind',
    signal ->> 'ticker',
    signal ->> 'action',
    (signal ->> 'signal_score')::integer,
    (signal ->> 'price')::numeric,
    (signal ->> 'quantity')::numeric,
    (signal ->> 'stop_loss')::numeric,
    signal ->> 'event_id',
    signal ->> 'exchange',
    signal ->> 'timeframe',
    (signal ->> 'bar_time')::timestamptz,
    signal ->> 'model_version'
  )
  on conflict do nothing
  returning * into existing;

  if existing.id is not null then
    return 'accepted';
  end if;

  if modern then
    select s.* into existing
    from public.trading_signals s
    where s.user_id = owner
      and s.signal_kind = signal ->> 'signal_kind'
      and upper(s.exchange) = upper(signal ->> 'exchange')
      and upper(s.ticker) = upper(signal ->> 'ticker')
      and (case when upper(s.timeframe) in ('D', '1D') then '1D' else upper(s.timeframe) end)
        = (case when upper(signal ->> 'timeframe') in ('D', '1D') then '1D' else upper(signal ->> 'timeframe') end)
      and s.model_version = signal ->> 'model_version'
      and s.action = signal ->> 'action'
      and s.bar_time = (signal ->> 'bar_time')::timestamptz;

    if existing.signal_score is distinct from (signal ->> 'signal_score')::integer
       or existing.price is distinct from (signal ->> 'price')::numeric
       or existing.quantity is distinct from (signal ->> 'quantity')::numeric
       or existing.stop_loss is distinct from (signal ->> 'stop_loss')::numeric then
      return 'conflict';
    end if;
  end if;

  return 'duplicate';
end;
$$;

revoke all on function public.ingest_tradingview_signal(text, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_tradingview_signal(text, jsonb) to service_role;
