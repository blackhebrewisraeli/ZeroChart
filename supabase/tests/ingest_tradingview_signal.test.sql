begin;

create extension if not exists pgtap with schema extensions;

select plan(9);

insert into auth.users (id) values ('00000000-0000-4000-8000-000000000011');
insert into public.signal_webhook_tokens (user_id, token_hash)
values (
  '00000000-0000-4000-8000-000000000011',
  encode(sha256(convert_to('tok-ingest', 'UTF8')), 'hex')
);

create temporary table delivery as
select jsonb_build_object(
  'ticker', 'BTCUSD',
  'signal_kind', 'strategy',
  'action', 'SELL',
  'signal_score', 57,
  'price', 84000,
  'quantity', 0.119047619,
  'stop_loss', 83256.58,
  'event_id', '2026-10-22T00:00:22Z',
  'exchange', 'BINANCE',
  'timeframe', '60',
  'bar_time', '2026-10-21T23:00:00.000Z',
  'model_version', '1.0.0'
) as signal,
encode(sha256(convert_to('tok-ingest', 'UTF8')), 'hex') as token_hash;
grant select on delivery to service_role, authenticated;

set local role service_role;

select is(
  public.ingest_tradingview_signal(encode(sha256(convert_to('wrong', 'UTF8')), 'hex'), (select signal from delivery)),
  'unauthorized',
  'an unknown token records nothing'
);
select is(
  public.ingest_tradingview_signal((select token_hash from delivery), null),
  'authorized',
  'a null signal only authenticates'
);
select is(
  public.ingest_tradingview_signal((select token_hash from delivery), (select signal from delivery)),
  'accepted',
  'a valid delivery is accepted'
);
select is(
  public.ingest_tradingview_signal((select token_hash from delivery), (select signal from delivery)),
  'duplicate',
  'TradingView redelivering the same event is acknowledged as a duplicate'
);

reset role;

select is(
  (select count(*)::integer from public.trading_signals where event_id = '2026-10-22T00:00:22Z'),
  1,
  'the duplicate delivery creates no second signal'
);
select results_eq(
  $$
    select user_id, status, signal_kind, exchange, timeframe, bar_time, model_version
    from public.trading_signals
    where event_id = '2026-10-22T00:00:22Z'
  $$,
  $$
    values (
      '00000000-0000-4000-8000-000000000011'::uuid,
      'PENDING'::text,
      'strategy'::text,
      'BINANCE'::text,
      '60'::text,
      '2026-10-21T23:00:00Z'::timestamptz,
      '1.0.0'::text
    )
  $$,
  'the signal keeps its owner, PENDING status and source context'
);
select is(
  public.ingest_tradingview_signal(
    (select token_hash from delivery),
    (select signal - 'exchange' - 'timeframe' - 'bar_time' - 'model_version' || '{"event_id": "legacy"}' from delivery)
  ),
  'accepted',
  'alerts without source context are still accepted'
);

select ok(
  not has_function_privilege('anon', 'public.ingest_tradingview_signal(text, jsonb)', 'execute'),
  'anon cannot call the ingest RPC'
);
select ok(
  not has_function_privilege('authenticated', 'public.ingest_tradingview_signal(text, jsonb)', 'execute'),
  'signed-in users cannot forge webhook deliveries'
);

select * from finish();
rollback;
