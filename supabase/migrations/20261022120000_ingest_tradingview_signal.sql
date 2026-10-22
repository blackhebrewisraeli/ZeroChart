-- tv-webhook in one database round trip. Every TradingView delivery boots a
-- fresh Edge Function worker, and each PostgREST call from it opens a new TLS
-- connection to eu-west-1: the token lookup plus the insert took 2.1 s on the
-- 2026-10-22T00:00:22Z alert, and TradingView gives up after 3 s.

-- Where the alert came from. Null on alerts set up before these fields existed.
alter table public.trading_signals
  add column if not exists exchange text,
  add column if not exists timeframe text,
  add column if not exists bar_time timestamptz,
  add column if not exists model_version text;

-- Authenticates the webhook token's SHA-256 digest and, given a signal, records
-- it. A null signal only authenticates, so a malformed body from an unknown
-- caller still answers 401 before 400. 'duplicate' is a redelivered event_id.
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

  insert into public.trading_signals (
    user_id,
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
