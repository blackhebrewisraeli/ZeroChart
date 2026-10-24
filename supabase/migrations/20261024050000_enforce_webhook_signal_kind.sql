-- Require every webhook delivery to declare an executable strategy or a
-- non-executable transport test. This replaces the #79 definition so null or
-- missing signal_kind values cannot pass PostgreSQL's three-valued NOT IN test.
create or replace function public.ingest_tradingview_signal(token_hash text, signal jsonb)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  owner uuid;
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
  on conflict (user_id, ticker, action, event_id) do nothing;

  return case when found then 'accepted' else 'duplicate' end;
end;
$$;

revoke all on function public.ingest_tradingview_signal(text, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_tradingview_signal(text, jsonb) to service_role;
