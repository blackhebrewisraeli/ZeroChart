begin;

create extension if not exists pgtap with schema extensions;

select plan(29);

insert into auth.users (id)
values
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002');

insert into public.assets_status (ticker, current_price, updated_at)
values ('AAPL', 100, now()), ('STALECOIN', 10, now() - interval '3 hours');

insert into public.trading_signals
  (id, user_id, ticker, action, signal_score, quantity, price, event_id, signal_kind, exchange, timeframe, bar_time, model_version)
values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'AAPL', 'BUY', 85, 10, 100, 'atomic-success', 'strategy', 'NYSE', '1D', now(), '1.0.0'),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'AAPL', 'BUY', 85, 2000, 100, 'insufficient-cash', 'strategy', 'NYSE', '1D', now() - interval '1 minute', '1.0.0'),
  ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'AAPL', 'BUY', 85, 1, 100, 'bad-price', 'strategy', 'NYSE', '1D', now() - interval '2 minutes', '1.0.0'),
  ('10000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001', 'AAPL', 'SELL', 20, 100, 100, 'insufficient-shares', 'strategy', 'NYSE', '1D', now(), '1.0.0'),
  ('10000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001', 'NOPRICE', 'BUY', 85, 1, 100, 'missing-price', 'strategy', 'NYSE', '1D', now(), '1.0.0'),
  ('10000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000001', 'STALECOIN', 'BUY', 85, 1, 10, 'stale-price', 'strategy', 'NYSE', '1D', now(), '1.0.0'),
  ('10000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000002', 'AAPL', 'BUY', 85, 1, 100, 'other-account', 'strategy', 'NYSE', '1D', now(), '1.0.0'),
  ('10000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000001', 'AAPL', 'BUY', 85, 1, 100, 'transport-test', 'transport_test', null, null, null, null),
  ('10000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-000000000001', 'AAPL', 'BUY', 85, 1, 100, 'legacy', null, 'NYSE', '1D', now(), '1.0.0'),
  ('10000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-000000000001', 'AAPL', 'BUY', 85, 1, 100, 'pw200-1d', 'strategy', 'BINANCE', '1D', now(), '1.0.0-pw200'),
  ('10000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-000000000001', 'AAPL', 'BUY', 85, 1, 100, 'pw200-d', 'strategy', 'BINANCE', 'D', now() - interval '1 day', '1.0.0-pw200'),
  ('10000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-000000000001', 'AAPL', 'BUY', 85, 1, 100, 'pw200-60', 'strategy', 'BINANCE', '60', now(), '1.0.0-pw200'),
  ('10000000-0000-4000-8000-00000000000d', '00000000-0000-4000-8000-000000000001', 'AAPL', 'BUY', 85, 1, 100, 'candidate-c1', 'strategy', 'BINANCE', '1D', now(), '1.0.0-pw200.c1'),
  ('10000000-0000-4000-8000-00000000000e', '00000000-0000-4000-8000-000000000001', 'AAPL', 'BUY', 85, 1, 100, 'unknown-version', 'strategy', 'BINANCE', '1D', now(), '2.0.0'),
  ('10000000-0000-4000-8000-00000000000f', '00000000-0000-4000-8000-000000000001', 'AAPL', 'BUY', 85, 1, 100, 'legacy-model-60', 'strategy', 'BINANCE', '60', now(), '1.0.0');

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-8000-000000000001',
  true
);

select lives_ok(
  $$
    select public.execute_tactical_signal(
      '10000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000001',
      100
    )
  $$,
  'a valid signal executes atomically'
);

select is(
  (
    select status
    from public.trading_signals
    where id = '10000000-0000-4000-8000-000000000001'
  ),
  'EXECUTED',
  'the successful signal is marked executed'
);

select throws_ok(
  $$select public.execute_tactical_signal(
    '10000000-0000-4000-8000-000000000008',
    '00000000-0000-4000-8000-000000000001',
    100
  )$$,
  '23514',
  'Only verified strategy signals can be executed',
  'transport-test signals cannot execute'
);

select throws_ok(
  $$select public.execute_tactical_signal(
    '10000000-0000-4000-8000-000000000009',
    '00000000-0000-4000-8000-000000000001',
    100
  )$$,
  '23514',
  'Only verified strategy signals can be executed',
  'legacy unverified signals cannot execute'
);

select is(
  (
    select count(*)::integer
    from public.paper_transactions
    where signal_id in (
      '10000000-0000-4000-8000-000000000008',
      '10000000-0000-4000-8000-000000000009'
    )
  ),
  0,
  'rejected classifications create no fills'
);

-- ===== Model versions =====
-- 1.0.0-pw200 executes on daily alerts only; 1.0.0 keeps executing on any
-- timeframe until a later migration withdraws it.
select lives_ok(
  format(
    'select public.execute_tactical_signal(%L, %L, 100)',
    accepted.signal_id,
    '00000000-0000-4000-8000-000000000001'
  ),
  accepted.description
)
from (
  values
    ('10000000-0000-4000-8000-00000000000a', 'the window-200 Pine version executes on a 1D alert'),
    ('10000000-0000-4000-8000-00000000000b', 'the window-200 Pine version executes on a D alert'),
    ('10000000-0000-4000-8000-00000000000f', '1.0.0 still executes, on any timeframe, during the switch-over')
) as accepted (signal_id, description);

select throws_ok(
  format(
    'select public.execute_tactical_signal(%L, %L, 100)',
    refused.signal_id,
    '00000000-0000-4000-8000-000000000001'
  ),
  '23514',
  'Signal strategy provenance is incomplete or unsupported',
  refused.description
)
from (
  values
    ('10000000-0000-4000-8000-00000000000c', 'the window-200 Pine version is refused on a 60-minute alert'),
    ('10000000-0000-4000-8000-00000000000d', 'the unpromoted candidate attribution is refused'),
    ('10000000-0000-4000-8000-00000000000e', 'an unknown model version is refused')
) as refused (signal_id, description);

select is(
  (
    select count(*)::integer
    from public.paper_transactions
    where signal_id in (
      '10000000-0000-4000-8000-00000000000a',
      '10000000-0000-4000-8000-00000000000b',
      '10000000-0000-4000-8000-00000000000f'
    )
  ),
  3,
  'each accepted model version creates one fill'
);

select is(
  (
    select count(*)::integer
    from public.trading_signals as signal
    where signal.id in (
      '10000000-0000-4000-8000-00000000000c',
      '10000000-0000-4000-8000-00000000000d',
      '10000000-0000-4000-8000-00000000000e'
    )
      and signal.status = 'PENDING'
      and not exists (
        select 1 from public.paper_transactions as fill where fill.signal_id = signal.id
      )
  ),
  3,
  'refused model versions stay pending with no fill'
);

select is(
  (
    select count(*)::integer
    from public.paper_transactions
    where signal_id = '10000000-0000-4000-8000-000000000001'
  ),
  1,
  'the successful signal creates exactly one fill'
);

select is(
  (
    select quantity * price + fees
    from public.paper_transactions
    where signal_id = '10000000-0000-4000-8000-000000000001'
  ),
  1002.5::numeric,
  'the fill deducts notional plus the 0.25% fee from Paper Cash'
);

select throws_ok(
  $$
    select public.execute_tactical_signal(
      '10000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000001',
      100
    )
  $$,
  '23514',
  'Signal is no longer waiting',
  'a second execution of the same signal is rejected'
);

select is(
  (
    select count(*)::integer
    from public.paper_transactions
    where signal_id = '10000000-0000-4000-8000-000000000001'
  ),
  1,
  'the rejected duplicate creates no second fill'
);

select throws_ok(
  format(
    'select public.execute_tactical_signal(%L, %L, %s)',
    rejected.signal_id,
    '00000000-0000-4000-8000-000000000001',
    rejected.fill_price
  ),
  '23514',
  rejected.message,
  rejected.description
)
from (
  values
    (
      '10000000-0000-4000-8000-000000000002',
      100,
      'Insufficient cash',
      'an unaffordable fill is rejected by the server'
    ),
    (
      '10000000-0000-4000-8000-000000000003',
      100.51,
      'AAPL has moved more than 0.5% from its server price. Try again after the next price refresh.',
      'a price outside the 0.5% band is rejected'
    ),
    (
      '10000000-0000-4000-8000-000000000004',
      100,
      'Insufficient shares',
      'selling more than the account holds is rejected'
    ),
    (
      '10000000-0000-4000-8000-000000000005',
      100,
      'NOPRICE has no server price, so Paper Trading can''t fill it',
      'a ticker without a server price is rejected'
    ),
    (
      '10000000-0000-4000-8000-000000000006',
      10,
      'STALECOIN''s server price is over 2 hours old: its market is closed or the price feed is behind.',
      'a stale server price is rejected'
    )
) as rejected (signal_id, fill_price, message, description);

select is(
  (
    select count(*)::integer
    from public.trading_signals as signal
    where signal.id in (
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000004',
      '10000000-0000-4000-8000-000000000005',
      '10000000-0000-4000-8000-000000000006'
    )
      and signal.status = 'PENDING'
      and not exists (
        select 1
        from public.paper_transactions as fill
        where fill.signal_id = signal.id
      )
  ),
  5,
  'rejected signals stay pending with no partial fill'
);

-- ===== Access =====
-- Signed in as the first account: its own id on the second account's signal,
-- then the second account's id.
select throws_ok(
  format(
    'select public.execute_tactical_signal(%L, %L, 100)',
    '10000000-0000-4000-8000-000000000007',
    claimed.user_id
  ),
  claimed.code,
  claimed.message,
  claimed.description
)
from (
  values
    ('00000000-0000-4000-8000-000000000001', 'P0002', 'Signal not found',
      'another account''s signal cannot be executed'),
    ('00000000-0000-4000-8000-000000000002', '42501', 'Not authorized to execute this signal',
      'claiming another account''s user_id is refused')
) as claimed (user_id, code, message, description);

select throws_ok(
  $$update public.trading_signals set status = 'EXECUTED' where id = '10000000-0000-4000-8000-000000000002'$$,
  '42501',
  null,
  'a client cannot mark a signal EXECUTED without its fill'
);

select set_config('request.jwt.claim.sub', '', true);
select throws_ok(
  $$select public.execute_tactical_signal('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 100)$$,
  '42501',
  'Not authorized to execute this signal',
  'a request without a signed-in user is refused'
);

reset role;
select is(
  (
    select status || ' / ' || (
      select count(*) from public.paper_transactions where signal_id = s.id
    )
    from public.trading_signals as s
    where s.id = '10000000-0000-4000-8000-000000000007'
  ),
  'PENDING / 0',
  'the other account''s signal is untouched'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.execute_tactical_signal(uuid, uuid, numeric)',
    'execute'
  ),
  'anon cannot call the signal RPC'
);

select * from finish();
rollback;
