begin;

create extension if not exists pgtap with schema extensions;

select plan(18);

insert into auth.users (id)
values
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002');

insert into public.assets_status (ticker, current_price, updated_at)
values ('AAPL', 100, now()), ('STALECOIN', 10, now() - interval '3 hours');

insert into public.trading_signals
  (id, user_id, ticker, action, signal_score, quantity, price, event_id)
values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'AAPL', 'BUY', 85, 10, 100, 'atomic-success'),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'AAPL', 'BUY', 85, 2000, 100, 'insufficient-cash'),
  ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'AAPL', 'BUY', 85, 1, 100, 'bad-price'),
  ('10000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001', 'AAPL', 'SELL', 20, 100, 100, 'insufficient-shares'),
  ('10000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001', 'NOPRICE', 'BUY', 85, 1, 100, 'missing-price'),
  ('10000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000001', 'STALECOIN', 'BUY', 85, 1, 10, 'stale-price'),
  ('10000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000002', 'AAPL', 'BUY', 85, 1, 100, 'other-account');

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
