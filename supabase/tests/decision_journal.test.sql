-- The Decision Journal's read (src/lib/db.ts loadJournalPage): an
-- authenticated owner's signals with their linked fills. SYNTHETIC rows only.
begin;

create extension if not exists pgtap with schema extensions;

select plan(16);

insert into auth.users (id) values
  ('00000000-0000-4000-8000-000000000021'),
  ('00000000-0000-4000-8000-000000000022');
insert into public.signal_webhook_tokens (user_id, token_hash)
values
  ('00000000-0000-4000-8000-000000000021', encode(sha256(convert_to('tok-journal-a', 'UTF8')), 'hex')),
  ('00000000-0000-4000-8000-000000000022', encode(sha256(convert_to('tok-journal-b', 'UTF8')), 'hex'));
insert into public.assets_status (ticker, current_price, updated_at, atr_14, analytics_updated_at)
values ('ZCTJ-USD', 100, now(), 1, now());

create temporary table delivery as
select jsonb_build_object(
  'signal_kind', 'strategy',
  'ticker', 'ZCTJUSDT',
  'action', 'BUY',
  'signal_score', 81,
  'price', 100,
  'quantity', 1,
  'stop_loss', 97,
  'event_id', 'attempt-1',
  'exchange', 'ZC_SYNTHETIC',
  'timeframe', '1D',
  'bar_time', '2026-10-27T00:00:00Z',
  'model_version', '1.0.0-pw200'
) as signal,
encode(sha256(convert_to('tok-journal-a', 'UTF8')), 'hex') as owner_a,
encode(sha256(convert_to('tok-journal-b', 'UTF8')), 'hex') as owner_b;
grant select on delivery to authenticated, anon;

select is(
  (select public.ingest_tradingview_signal(owner_a, signal) from delivery),
  'accepted',
  'the first delivery is recorded'
);
select is(
  (select public.ingest_tradingview_signal(owner_a, signal || '{"event_id": "attempt-2"}') from delivery),
  'duplicate',
  'a redelivery with another attempt id is a duplicate'
);
select is(
  (
    select count(*)::int
    from public.trading_signals
    where user_id = '00000000-0000-4000-8000-000000000021' and bar_time = '2026-10-27T00:00:00Z'
  ),
  1,
  'the duplicated delivery is one journal signal'
);
select is(
  (select public.ingest_tradingview_signal(owner_b, signal) from delivery),
  'accepted',
  'another owner''s identical event is that owner''s own row'
);

select public.ingest_tradingview_signal(
  owner_a,
  signal || '{"event_id": "attempt-dismiss", "bar_time": "2026-10-26T00:00:00Z"}'
) from delivery;
select public.ingest_tradingview_signal(
  owner_a,
  signal || '{"event_id": "attempt-pending", "bar_time": "2026-10-25T00:00:00Z"}'
) from delivery;
-- Executed before 20261022090000: the client booked the fill itself, unlinked.
insert into public.trading_signals (user_id, ticker, action, signal_score, quantity, status, event_id)
values ('00000000-0000-4000-8000-000000000021', 'ZCTJUSDT', 'BUY', 81, 1, 'EXECUTED', 'legacy-executed');

create temporary table ids as
select
  (select id from public.trading_signals where user_id = '00000000-0000-4000-8000-000000000021' and event_id = 'attempt-1') as a1,
  (select id from public.trading_signals where user_id = '00000000-0000-4000-8000-000000000022' and event_id = 'attempt-1') as b1;
grant select on ids to authenticated, anon;

set local role authenticated;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000022', true);
select public.execute_tactical_signal((select b1 from ids), '00000000-0000-4000-8000-000000000022', 100);

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000021', true);
select lives_ok(
  $$select public.execute_tactical_signal((select a1 from ids), '00000000-0000-4000-8000-000000000021', 100)$$,
  'the owner executes the signal'
);
select throws_ok(
  $$select public.execute_tactical_signal((select a1 from ids), '00000000-0000-4000-8000-000000000021', 100)$$,
  '23514',
  'Signal is no longer waiting',
  'a retried execution is refused'
);
select is(
  (select count(*)::int from public.paper_transactions where signal_id = (select a1 from ids)),
  1,
  'the retry left one linked fill'
);
update public.trading_signals set status = 'DISMISSED' where event_id = 'attempt-dismiss';

select results_eq(
  $$
    select s.event_id, s.status, p.ticker, p.quantity, p.price, p.fees
    from public.trading_signals s
    left join public.paper_transactions p on p.signal_id = s.id
    order by s.event_id
  $$,
  $$
    values
      ('attempt-1', 'EXECUTED', 'ZCTJ-USD', 1::numeric, 100::numeric, 0.25::numeric),
      ('attempt-dismiss', 'DISMISSED', null, null, null, null),
      ('attempt-pending', 'PENDING', null, null, null, null),
      ('legacy-executed', 'EXECUTED', null, null, null, null)
  $$,
  'the owner reads each signal with its own linked fill and amounts, and none of another owner''s'
);
select is(
  (
    select count(*)::int
    from public.trading_signals
    where user_id = '00000000-0000-4000-8000-000000000022'
  ),
  0,
  'asking for another owner''s signals returns none'
);
select is(
  (select count(*)::int from public.paper_transactions where signal_id = (select b1 from ids)),
  0,
  'another owner''s linked fill is not readable'
);
select is(
  (
    select count(*)::int
    from public.trading_signals
    where id = (select b1 from ids) and status = 'EXECUTED'
  ),
  0,
  'another owner''s signal is not readable by its id'
);
select throws_ok(
  $$select * from public.signal_webhook_tokens$$,
  '42501',
  null,
  'the journal''s role cannot read webhook token hashes'
);

reset role;
set local role anon;
select throws_ok(
  $$select * from public.trading_signals$$,
  '42501',
  null,
  'anon cannot read signals'
);
select throws_ok(
  $$select * from public.paper_transactions$$,
  '42501',
  null,
  'anon cannot read fills'
);

reset role;
select is_empty(
  $$
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name in ('trading_signals', 'paper_transactions')
      and column_name ~* '(token|secret|hash|payload)'
  $$,
  'neither journal table stores a token, hash or raw payload'
);
select is(
  (
    select count(*)::int
    from public.paper_transactions
    where user_id = '00000000-0000-4000-8000-000000000022' and signal_id = (select b1 from ids)
  ),
  1,
  'the other owner''s fill exists, so the refusals above are RLS, not missing rows'
);

select * from finish();
rollback;
