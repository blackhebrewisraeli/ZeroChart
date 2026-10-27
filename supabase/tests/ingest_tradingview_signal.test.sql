begin;

create extension if not exists pgtap with schema extensions;

select plan(26);

insert into auth.users (id) values
  ('00000000-0000-4000-8000-000000000011'),
  ('00000000-0000-4000-8000-000000000012');
insert into public.signal_webhook_tokens (user_id, token_hash)
values
  ('00000000-0000-4000-8000-000000000011', encode(sha256(convert_to('tok-ingest', 'UTF8')), 'hex')),
  ('00000000-0000-4000-8000-000000000012', encode(sha256(convert_to('tok-other', 'UTF8')), 'hex'));

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
select throws_ok(
  $$select public.ingest_tradingview_signal(
    (select token_hash from delivery),
    (select signal - 'signal_kind' || '{"event_id": "missing-kind"}' from delivery)
  )$$,
  '23514',
  'signal_kind must be strategy or transport_test',
  'a missing signal_kind is rejected'
);
select throws_ok(
  $$select public.ingest_tradingview_signal(
    (select token_hash from delivery),
    (select signal || '{"signal_kind": null, "event_id": "null-kind"}' from delivery)
  )$$,
  '23514',
  'signal_kind must be strategy or transport_test',
  'a null signal_kind is rejected'
);
select throws_ok(
  $$select public.ingest_tradingview_signal(
    (select token_hash from delivery),
    (select signal || '{"signal_kind": "legacy", "event_id": "unsupported-kind"}' from delivery)
  )$$,
  '23514',
  'signal_kind must be strategy or transport_test',
  'an unsupported signal_kind is rejected'
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

select is(
  public.ingest_tradingview_signal(
    (select token_hash from delivery),
    (select signal || jsonb_build_object(
      'timeframe', '1D',
      'bar_time', '2026-10-21T00:00:00.000Z',
      'model_version', '1.0.0-pw200'
    ) from delivery)
  ),
  'accepted',
  'a daily model event at the same delivery second is a separate signal'
);
select is(
  public.ingest_tradingview_signal(
    (select token_hash from delivery),
    (select signal || '{"event_id": "retry-after-uncertain-response"}' from delivery)
  ),
  'duplicate',
  'a retry with a new delivery id still resolves to the saved logical event'
);
select is(
  public.ingest_tradingview_signal(
    (select token_hash from delivery),
    (select signal || jsonb_build_object(
      'event_id', 'daily-alias',
      'timeframe', 'D',
      'bar_time', '2026-10-21T00:00:00.000Z',
      'model_version', '1.0.0-pw200'
    ) from delivery)
  ),
  'duplicate',
  'D and 1D identify the same logical timeframe'
);
select is(
  public.ingest_tradingview_signal(
    (select token_hash from delivery),
    (select signal || '{"event_id": "other-model", "model_version": "2.0.0"}' from delivery)
  ),
  'accepted',
  'different model implementations at the same close remain separate'
);
select is(
  public.ingest_tradingview_signal(
    (select token_hash from delivery),
    (select signal || '{"event_id": "opposite-action", "action": "BUY"}' from delivery)
  ),
  'accepted',
  'BUY and SELL events remain separate'
);
select is(
  public.ingest_tradingview_signal(
    (select token_hash from delivery),
    (select signal || '{"event_id": "changed-content", "price": 84001}' from delivery)
  ),
  'conflict',
  'changed content for one modern logical identity is refused'
);
select is(
  public.ingest_tradingview_signal(
    encode(sha256(convert_to('tok-other', 'UTF8')), 'hex'),
    (select signal from delivery)
  ),
  'accepted',
  'the same event for another user remains isolated'
);
-- Each key field alone must separate events; the cases above change several at once.
select is(
  public.ingest_tradingview_signal(
    (select token_hash from delivery),
    (select signal || '{"event_id": "next-hour", "bar_time": "2026-10-21T00:00:00Z"}' from delivery)
  ),
  'accepted',
  'another bar of the same series is a separate signal'
);
select is(
  public.ingest_tradingview_signal(
    (select token_hash from delivery),
    (select signal || '{"event_id": "same-open", "timeframe": "1D", "bar_time": "2026-10-21T00:00:00Z"}' from delivery)
  ),
  'accepted',
  'hourly and daily bars with the same open time remain separate'
);
select is(
  public.ingest_tradingview_signal(
    (select token_hash from delivery),
    (select signal || '{"event_id": "other-exchange", "exchange": "COINBASE"}' from delivery)
  ),
  'accepted',
  'the same instrument on another exchange remains separate'
);
select is(
  public.ingest_tradingview_signal(
    (select token_hash from delivery),
    (select signal || '{"event_id": "transport", "signal_kind": "transport_test"}' from delivery)
  ),
  'accepted',
  'a transport test never deduplicates a strategy event'
);
select is(
  public.ingest_tradingview_signal(
    (select token_hash from delivery),
    (select signal || '{"event_id": "lower-case", "exchange": "binance"}' from delivery)
  ),
  'duplicate',
  'exchange case does not change the logical event'
);

reset role;

select is(
  (select count(*)::integer from public.trading_signals
   where user_id = '00000000-0000-4000-8000-000000000011'
     and event_id = '2026-10-22T00:00:22Z'),
  2,
  'the retry is deduplicated without collapsing the distinct daily signal'
);
select results_eq(
  $$
    select user_id, status, signal_kind, exchange, timeframe, bar_time, model_version
    from public.trading_signals
    where event_id = '2026-10-22T00:00:22Z'
      and user_id = '00000000-0000-4000-8000-000000000011'
      and timeframe = '60'
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
select is(
  public.ingest_tradingview_signal(
    (select token_hash from delivery),
    (select signal - 'exchange' - 'timeframe' - 'bar_time' - 'model_version'
      || '{"event_id": "legacy", "price": 84001}' from delivery)
  ),
  'duplicate',
  'legacy alerts retain event-id retry behavior even when content changes'
);
select is(
  (select count(*)::integer from public.paper_transactions),
  0,
  'ingestion creates no fills or cash-ledger mutations'
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
