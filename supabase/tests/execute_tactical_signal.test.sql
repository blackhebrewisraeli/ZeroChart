begin;

create extension if not exists pgtap with schema extensions;

select plan(12);

insert into auth.users (id)
values
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002');

insert into public.assets_status (ticker, current_price, updated_at)
values ('AAPL', 100, now());

insert into public.trading_signals (
  id,
  user_id,
  ticker,
  action,
  signal_score,
  quantity,
  price,
  event_id
)
values
  (
    '10000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000001',
    'AAPL',
    'BUY',
    85,
    10,
    100,
    'atomic-success'
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001',
    'AAPL',
    'BUY',
    85,
    2000,
    100,
    'insufficient-cash'
  ),
  (
    '10000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000001',
    'AAPL',
    'BUY',
    85,
    1,
    100,
    'bad-price'
  );

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
  $$
    select public.execute_tactical_signal(
      '10000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000001',
      100
    )
  $$,
  '23514',
  'Insufficient cash',
  'an unaffordable fill is rejected by the server'
);

select is(
  (
    select status
    from public.trading_signals
    where id = '10000000-0000-4000-8000-000000000002'
  ),
  'PENDING',
  'cash rejection rolls the signal status back to pending'
);

select is(
  (
    select count(*)::integer
    from public.paper_transactions
    where signal_id = '10000000-0000-4000-8000-000000000002'
  ),
  0,
  'cash rejection leaves no partial fill'
);

select throws_ok(
  $$
    select public.execute_tactical_signal(
      '10000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000001',
      100.51
    )
  $$,
  '23514',
  'AAPL has moved more than 0.5% from its server price. Try again after the next price refresh.',
  'a price outside the 0.5% band is rejected'
);

select is(
  (
    select status
    from public.trading_signals
    where id = '10000000-0000-4000-8000-000000000003'
  ),
  'PENDING',
  'price rejection leaves the signal pending'
);

select is(
  (
    select count(*)::integer
    from public.paper_transactions
    where signal_id = '10000000-0000-4000-8000-000000000003'
  ),
  0,
  'price rejection leaves no partial fill'
);

select * from finish();
rollback;
