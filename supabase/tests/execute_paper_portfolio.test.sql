begin;

create extension if not exists pgtap with schema extensions;

select plan(35);

insert into auth.users (id)
values
  ('00000000-0000-4000-8000-000000000021'),
  ('00000000-0000-4000-8000-000000000022');

-- BTC and ETH bind on the allocation, SOL on its ATR risk cap.
insert into public.assets_status (ticker, current_price, updated_at, atr_14, analytics_updated_at)
values
  ('BTC', 50000, now(), 1000, now()),
  ('ETH', 2500, now(), 50, now()),
  ('SOL', 100, now(), 10, now()),
  ('STALE', 10, now() - interval '3 hours', 0.2, now()),
  ('NOATR', 100, now(), null, null),
  ('OLDATR', 100, now(), 2, now() - interval '3 days'),
  ('CALMISH', 100, now(), 5, now());

-- The second account already holds 58 NOATR: no ATR, so its whole $5,800 entry is at risk.
insert into public.paper_transactions (user_id, action, ticker, quantity, price, fees)
values ('00000000-0000-4000-8000-000000000022', 'BUY', 'NOATR', 58, 100, 14.5);

create function pg_temp.sign_in(account text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', account, true);
$$;
create function pg_temp.invest(
  request uuid,
  profile text,
  budget numeric,
  holdings text,
  dry boolean default false
) returns jsonb language sql as $$
  select public.execute_paper_portfolio(request, profile, budget, holdings::jsonb, dry);
$$;
grant execute on function pg_temp.sign_in(text), pg_temp.invest(uuid, text, numeric, text, boolean)
  to authenticated, anon;

set local role authenticated;
select pg_temp.sign_in('00000000-0000-4000-8000-000000000021');

-- ===== Preview and execution =====
select is(
  pg_temp.invest(
    '20000000-0000-4000-8000-000000000001', 'moderate', 10000,
    '[{"ticker": "BTC", "amount": 2500, "score": 80}, {"ticker": "eth", "amount": 2500, "score": 75}]',
    true
  ) -> 'orders',
  '[
    {"ticker": "BTC", "quantity": 0.04987531, "price": 50000, "fees": 6.2344137500, "cost": 2499.99991375, "stop_price": 48000, "atr": 1000, "planned_risk": 99.75062000},
    {"ticker": "ETH", "quantity": 0.99750623, "price": 2500, "fees": 6.2344139375000, "cost": 2499.9999889375000, "stop_price": 2400, "atr": 50, "planned_risk": 99.75062300}
  ]'::jsonb,
  'a dry run prices each holding at the server quote and floors units under its allocation'
);
select is(
  (select count(*)::integer from public.paper_transactions where user_id = '00000000-0000-4000-8000-000000000021'),
  0,
  'a dry run books nothing'
);

select is(
  pg_temp.invest(
    '20000000-0000-4000-8000-000000000001', 'moderate', 10000,
    '[{"ticker": "BTC", "amount": 2500, "score": 80}, {"ticker": "ETH", "amount": 2500, "score": 75}]'
  ) ->> 'status',
  'executed',
  'the proposal executes'
);
select results_eq(
  $$
    select ticker, quantity, batch_id, stop_price
    from public.paper_transactions
    where user_id = '00000000-0000-4000-8000-000000000021'
    order by created_at
  $$,
  $$
    values
      ('BTC'::text, 0.04987531::numeric, '20000000-0000-4000-8000-000000000001'::uuid, 48000::numeric),
      ('ETH'::text, 0.99750623::numeric, '20000000-0000-4000-8000-000000000001'::uuid, 2400::numeric)
  $$,
  'every fill links to its batch and records its planned stop'
);
select is(
  (
    select (b.receipt ->> 'cash_after')::numeric
    from public.paper_order_batches b
    where b.id = '20000000-0000-4000-8000-000000000001'
  ),
  (select cash from public.paper_account_book('00000000-0000-4000-8000-000000000021')),
  'the receipt''s remaining cash is what the ledger now holds'
);
select is(
  (
    select count(*)::integer from public.paper_transactions
    where user_id = '00000000-0000-4000-8000-000000000021' and action = 'DEPOSIT'
  ),
  0,
  'investing deposits nothing: it spends existing Paper Cash'
);

-- ===== A lost response, retried =====
select is(
  pg_temp.invest(
    '20000000-0000-4000-8000-000000000001', 'moderate', 10000,
    '[{"ticker": "BTC", "amount": 2500, "score": 80}, {"ticker": "ETH", "amount": 2500, "score": 75}]'
  ),
  (
    select receipt || '{"replayed": true}'
    from public.paper_order_batches
    where id = '20000000-0000-4000-8000-000000000001'
  ),
  'a retry with the same request ID returns the original receipt'
);
select is(
  pg_temp.invest(
    '20000000-0000-4000-8000-000000000001', 'moderate', 10000, '[{"ticker": "SOL", "amount": 1, "score": 99}]', true
  ) ->> 'replayed',
  'true',
  'reconciling by request ID finds the executed proposal'
);
select is(
  (select count(*)::integer from public.paper_transactions where user_id = '00000000-0000-4000-8000-000000000021'),
  2,
  'the retry creates no new fills'
);

-- ===== ATR quantity cap =====
select is(
  (pg_temp.invest(
    '20000000-0000-4000-8000-000000000002', 'moderate', 10000, '[{"ticker": "SOL", "amount": 2500, "score": 70}]', true
  ) #> '{orders,0}') - 'fees' - 'cost',
  '{"ticker": "SOL", "quantity": 10, "price": 100, "stop_price": 80, "atr": 10, "planned_risk": 200}'::jsonb,
  'a holding risks at most 2% of the budget at a 2 x ATR stop'
);

-- ===== Rejections book nothing =====
select throws_ok(
  $$select pg_temp.invest('20000000-0000-4000-8000-000000000003', 'moderate', 10000,
    '[{"ticker": "SOL", "amount": 2000, "score": 70}, {"ticker": "STALE", "amount": 2000, "score": 70}]')$$,
  '23514',
  'STALE''s server price is over 2 hours old: its market is closed or the price feed is behind.',
  'a stale price rejects the proposal'
);
select is(
  (
    select count(*)::integer from public.paper_transactions
    where batch_id = '20000000-0000-4000-8000-000000000003' or ticker = 'SOL'
  ) + (select count(*)::integer from public.paper_order_batches where id = '20000000-0000-4000-8000-000000000003'),
  0,
  'the valid holding before the failing one is rolled back with it'
);

select throws_ok(
  format(
    'select pg_temp.invest(%L, %L, %s, %L)',
    '20000000-0000-4000-8000-000000000004', rejected.profile, rejected.budget, rejected.holdings
  ),
  rejected.code,
  rejected.message,
  rejected.description
)
from (
  values
    ('moderate', 10000, '[{"ticker": "MISSING", "amount": 100, "score": 70}]', '23514',
      'MISSING has no server price, so Paper Trading can''t fill it', 'a missing price rejects'),
    ('moderate', 10000, '[{"ticker": "NOATR", "amount": 100, "score": 70}]', '23514',
      'NOATR has no current ATR(14) reading, so its risk can''t be sized. Try again after the daily market analytics run.',
      'a missing ATR rejects'),
    ('moderate', 10000, '[{"ticker": "OLDATR", "amount": 100, "score": 70}]', '23514',
      'OLDATR has no current ATR(14) reading, so its risk can''t be sized. Try again after the daily market analytics run.',
      'a stale ATR rejects'),
    ('moderate', 10000, '[{"ticker": "SOL", "amount": -5, "score": 70}]', '22023',
      'SOL needs an allocation greater than $0', 'a negative allocation rejects'),
    ('moderate', 10000, '[{"ticker": "SOL", "amount": "lots", "score": 70}]', '22023',
      'SOL needs an allocation greater than $0', 'a non-numeric allocation rejects'),
    ('moderate', 10000, '[{"ticker": "SOL", "amount": 2600, "score": 70}]', '23514',
      'SOL''s $2,600.00 allocation is over the 25% a moderate portfolio allows per holding',
      'a holding over its share of the budget rejects'),
    ('moderate', 10000, '[{"ticker": "SOL", "amount": 100, "score": 59}]', '23514',
      'SOL''s Signal Score 59 is below the 60 a moderate portfolio requires',
      'a balanced portfolio refuses a weak score'),
    ('conservative', 10000, '[{"ticker": "SOL", "amount": 100, "score": 59}]', '23514',
      'SOL''s Signal Score 59 is below the 60 a conservative portfolio requires',
      'a conservative portfolio refuses a weak score'),
    ('aggressive', 10000, '[{"ticker": "SOL", "amount": 100, "score": 70}]', '23514',
      'SOL''s Signal Score 70 is below the 71 a aggressive portfolio requires',
      'an aggressive portfolio keeps its stricter bar'),
    ('conservative', 10000, '[{"ticker": "CALMISH", "amount": 100, "score": 90}]', '23514',
      'CALMISH is in a high-volatility regime (ATR is 5.0% of its price), which a conservative portfolio excludes',
      'a conservative portfolio excludes the high-volatility regime'),
    ('moderate', 1000000, '[{"ticker": "SOL", "amount": 100, "score": 70}]', '23514',
      'The $1,000,000.00 budget is more than your $95,000.00 Paper Cash',
      'a budget over Paper Cash rejects instead of depositing'),
    ('aggressive', 10000, '[{"ticker": "BTC", "amount": 1, "score": 80}, {"ticker": "ETH", "amount": 1, "score": 80}, {"ticker": "SOL", "amount": 1, "score": 80}, {"ticker": "CALMISH", "amount": 1, "score": 80}]',
      '23514', 'A aggressive portfolio holds at most 3 assets', 'too many holdings rejects'),
    ('moderate', 10000, '[{"ticker": "SOL", "amount": 1, "score": 70}, {"ticker": "sol", "amount": 1, "score": 70}]',
      '22023', 'Each asset can appear only once in a proposal', 'a repeated asset rejects'),
    ('reckless', 10000, '[{"ticker": "SOL", "amount": 1, "score": 70}]', '22023',
      'Unknown risk profile reckless', 'an unknown profile rejects')
) as rejected (profile, budget, holdings, code, message, description);

-- ===== Total-portfolio risk cap =====
select pg_temp.sign_in('00000000-0000-4000-8000-000000000022');
select throws_ok(
  $$select pg_temp.invest('20000000-0000-4000-8000-000000000005', 'moderate', 10000,
    '[{"ticker": "BTC", "amount": 2500, "score": 80}, {"ticker": "SOL", "amount": 2500, "score": 70}]')$$,
  '23514',
  'Portfolio max risk reached: 5.8% open + 0.3% new would pass the 6% limit. No current ATR(14) reading for NOATR, so its whole entry counts as at risk until the next daily market analytics run. Lower the amount.',
  'open risk plus the proposal''s planned risk may not pass 6% of total equity'
);
select throws_ok(
  $$insert into public.paper_transactions (action, ticker, quantity, price, fees) values ('BUY', 'NOATR', 3, 100, 0.75)$$,
  '23514',
  'Portfolio max risk reached: 5.8% open + 0.3% new would pass the 6% limit. No current ATR(14) reading for NOATR, so its whole entry counts as at risk until the next daily market analytics run.',
  'the same cap applies to a single order from the trade ticket'
);
select is(
  (select unsized from public.paper_account_book('00000000-0000-4000-8000-000000000022')),
  'NOATR',
  'the account book names the position whose risk is its whole entry for want of an ATR'
);

-- ===== Access =====
select throws_ok(
  $$select pg_temp.invest('20000000-0000-4000-8000-000000000001', 'moderate', 10000,
    '[{"ticker": "SOL", "amount": 100, "score": 70}]')$$,
  '42501',
  'This request ID belongs to another account',
  'another account cannot replay or read someone else''s request'
);
select is(
  (select count(*)::integer from public.paper_order_batches),
  0,
  'batches are private to their owner'
);
select throws_ok(
  $$insert into public.paper_transactions (action, ticker, quantity, price, fees, batch_id)
    values ('BUY', 'SOL', 1, 100, 0.25, '20000000-0000-4000-8000-000000000001')$$,
  '42501',
  null,
  'clients cannot link a fill to a batch themselves'
);
select throws_ok(
  $$insert into public.paper_order_batches (id, user_id, risk_profile, policy_version, budget, receipt)
    values (gen_random_uuid(), '00000000-0000-4000-8000-000000000022', 'moderate', 'x', 1, '{}')$$,
  '42501',
  null,
  'clients cannot write receipts'
);

select set_config('request.jwt.claim.sub', '', true);
select throws_ok(
  $$select pg_temp.invest(gen_random_uuid(), 'moderate', 100, '[{"ticker": "SOL", "amount": 100, "score": 70}]')$$,
  '42501',
  'Sign in to invest from Paper Cash',
  'a request without a signed-in user is refused'
);

reset role;
select ok(
  not has_function_privilege('anon', 'public.execute_paper_portfolio(uuid, text, numeric, jsonb, boolean)', 'execute'),
  'anon cannot call the portfolio RPC'
);

select * from finish();
rollback;
