-- dismiss_tactical_signal and the dismissal evidence it records
-- (20261028120000). SYNTHETIC rows only.
begin;

create extension if not exists pgtap with schema extensions;

select plan(36);

insert into auth.users (id) values
  ('00000000-0000-4000-8000-000000000031'),
  ('00000000-0000-4000-8000-000000000032');
insert into public.assets_status (ticker, current_price, updated_at, atr_14, analytics_updated_at)
values ('ZCTD-USD', 100, now(), 1, now());

insert into public.trading_signals
  (id, user_id, ticker, action, signal_score, quantity, price, event_id, signal_kind, exchange, timeframe, bar_time, model_version, status)
values
  ('50000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000031', 'ZCTDUSDT', 'BUY', 80, 1, 100, 'no-reason', 'strategy', 'ZC_SYNTHETIC', '1D', '2026-10-01T00:00:00Z', '1.0.0', 'PENDING'),
  ('50000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000031', 'ZCTDUSDT', 'BUY', 80, 1, 100, 'with-reason', 'strategy', 'ZC_SYNTHETIC', '1D', '2026-10-02T00:00:00Z', '1.0.0', 'PENDING'),
  ('50000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000031', 'ZCTDUSDT', 'BUY', 80, 1, 100, 'executed', 'strategy', 'ZC_SYNTHETIC', '1D', '2026-10-03T00:00:00Z', '1.0.0', 'PENDING'),
  -- Dismissed before 20261028120000: no record, and none may be made up.
  ('50000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000031', 'ZCTDUSDT', 'BUY', 80, 1, 100, 'legacy-dismissed', null, null, null, null, null, 'DISMISSED'),
  ('50000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000031', 'ZCTDUSDT', 'BUY', 80, 1, 100, 'old-client', 'strategy', 'ZC_SYNTHETIC', '1D', '2026-10-04T00:00:00Z', '1.0.0', 'PENDING'),
  ('50000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000031', 'ZCTDUSDT', 'BUY', 80, 1, 100, 'still-pending', 'strategy', 'ZC_SYNTHETIC', '1D', '2026-10-05T00:00:00Z', '1.0.0', 'PENDING'),
  ('50000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000031', 'ZCTDUSDT', 'BUY', 80, 1, 100, 'fill-linked', 'strategy', 'ZC_SYNTHETIC', '1D', '2026-10-06T00:00:00Z', '1.0.0', 'PENDING'),
  ('50000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000032', 'ZCTDUSDT', 'BUY', 80, 1, 100, 'other-owner', 'strategy', 'ZC_SYNTHETIC', '1D', '2026-10-07T00:00:00Z', '1.0.0', 'PENDING'),
  ('50000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-000000000031', 'ZCTDUSDT', 'BUY', 80, 1, 100, 'conflict', 'strategy', 'ZC_SYNTHETIC', '1D', '2026-10-08T00:00:00Z', '1.0.0', 'PENDING');

-- A contradiction no client or RPC can create: a fill linked to a PENDING signal.
insert into public.paper_transactions (user_id, action, ticker, quantity, price, fees, signal_id)
values ('00000000-0000-4000-8000-000000000031', 'BUY', 'ZCTD-USD', 1, 100, 0.25, '50000000-0000-4000-8000-000000000007');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000031', true);

-- One-click dismissal, no reason.
select lives_ok(
  $$select public.dismiss_tactical_signal('50000000-0000-4000-8000-000000000001')$$,
  'the owner dismisses a pending signal without a reason'
);
select results_eq(
  $$
    select s.status, d.user_id, d.actor_id, d.reason, d.dismissed_at is not null
    from public.trading_signals s
    join public.trading_signal_dismissals d on d.signal_id = s.id
    where s.id = '50000000-0000-4000-8000-000000000001'
  $$,
  $$
    values (
      'DISMISSED',
      '00000000-0000-4000-8000-000000000031'::uuid,
      '00000000-0000-4000-8000-000000000031'::uuid,
      null::text,
      true
    )
  $$,
  'the status change and its evidence (owner, actor, server time, no reason) commit together'
);

select is(
  (select reason from public.dismiss_tactical_signal('50000000-0000-4000-8000-000000000002', 'price_moved')),
  'price_moved',
  'a dismissal records an allowlisted reason'
);
select is(
  (select dismissed_at from public.dismiss_tactical_signal('50000000-0000-4000-8000-000000000002', 'price_moved')),
  (select dismissed_at from public.trading_signal_dismissals where signal_id = '50000000-0000-4000-8000-000000000002'),
  'a retry with the same reason returns the original record'
);
select is(
  (select public.dismiss_tactical_signal('50000000-0000-4000-8000-000000000001')).dismissed_at,
  (select dismissed_at from public.trading_signal_dismissals where signal_id = '50000000-0000-4000-8000-000000000001'),
  'a retry without a reason returns the original record'
);
select is(
  (
    select count(*)::int
    from public.trading_signal_dismissals
    where signal_id in ('50000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000002')
  ),
  2,
  'retries add no second record'
);

-- A retry with another reason: refused, and the first reason stands.
select public.dismiss_tactical_signal('50000000-0000-4000-8000-000000000009', 'too_risky');
create temporary table first_conflict on commit drop as
select dismissed_at from public.trading_signal_dismissals
where signal_id = '50000000-0000-4000-8000-000000000009';
select throws_ok(
  $$select public.dismiss_tactical_signal('50000000-0000-4000-8000-000000000009', 'stale')$$,
  'PT409',
  'Signal was already dismissed with another reason',
  'a retry with a different reason is refused as a conflict'
);
select throws_ok(
  $$select public.dismiss_tactical_signal('50000000-0000-4000-8000-000000000009')$$,
  'PT409',
  'Signal was already dismissed with another reason',
  'a retry dropping the reason is refused as a conflict'
);
select results_eq(
  $$
    select d.reason, d.dismissed_at = f.dismissed_at
    from public.trading_signal_dismissals d, first_conflict f
    where d.signal_id = '50000000-0000-4000-8000-000000000009'
  $$,
  $$values ('too_risky'::text, true)$$,
  'the conflicting retries left the original reason and time'
);

-- Executed first: a dismissal is refused and records nothing.
select public.execute_tactical_signal(
  '50000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000031', 100
);
select throws_ok(
  $$select public.dismiss_tactical_signal('50000000-0000-4000-8000-000000000003')$$,
  '23514',
  'Signal was executed, so it can''t be dismissed',
  'an executed signal cannot be dismissed'
);
select results_eq(
  $$
    select s.status,
      (select count(*)::int from public.paper_transactions p where p.signal_id = s.id),
      (select count(*)::int from public.trading_signal_dismissals d where d.signal_id = s.id)
    from public.trading_signals s
    where s.id = '50000000-0000-4000-8000-000000000003'
  $$,
  $$values ('EXECUTED'::text, 1, 0)$$,
  'the executed signal keeps its one fill and gets no dismissal record'
);

select throws_ok(
  $$select public.dismiss_tactical_signal('50000000-0000-4000-8000-000000000004')$$,
  '23514',
  'Signal was dismissed before dismissals were recorded',
  'a legacy dismissed signal is not dismissed again'
);
select is_empty(
  $$select 1 from public.trading_signal_dismissals where signal_id = '50000000-0000-4000-8000-000000000004'$$,
  'no dismissal history is made up for a legacy dismissed signal'
);

select throws_ok(
  $$select public.dismiss_tactical_signal('50000000-0000-4000-8000-000000000006', 'because I said so')$$,
  '23514',
  null,
  'a reason outside the allowlist is refused'
);
select throws_ok(
  $$select public.dismiss_tactical_signal('50000000-0000-4000-8000-000000000007')$$,
  '23514',
  'Signal has a booked fill, so it can''t be dismissed',
  'a pending signal with a linked fill is not dismissed'
);
select throws_ok(
  $$select public.dismiss_tactical_signal('50000000-0000-4000-8000-000000000008')$$,
  'P0002',
  'Signal not found',
  'another owner''s signal cannot be dismissed'
);
select throws_ok(
  $$select public.dismiss_tactical_signal('50000000-0000-4000-8000-000000000006', null, '00000000-0000-4000-8000-000000000032')$$,
  '42883',
  null,
  'the caller cannot pass an actor'
);
select throws_ok(
  $$select public.dismiss_tactical_signal(signal_id => '50000000-0000-4000-8000-000000000006', dismissed_at => now())$$,
  '42883',
  null,
  'the caller cannot pass a time'
);
select results_eq(
  $$
    select id::text, status
    from public.trading_signals
    where id in (
      '50000000-0000-4000-8000-000000000006',
      '50000000-0000-4000-8000-000000000007'
    )
    order by id
  $$,
  $$
    values
      ('50000000-0000-4000-8000-000000000006', 'PENDING'),
      ('50000000-0000-4000-8000-000000000007', 'PENDING')
  $$,
  'refused dismissals leave the signals pending'
);

-- Clients can't forge, rewrite or delete evidence.
select throws_ok(
  $$
    insert into public.trading_signal_dismissals (signal_id, user_id, actor_id, dismissed_at)
    values (
      '50000000-0000-4000-8000-000000000006',
      '00000000-0000-4000-8000-000000000031',
      '00000000-0000-4000-8000-000000000032',
      '2026-01-01T00:00:00Z'
    )
  $$,
  '42501',
  null,
  'a client cannot insert a dismissal record'
);
select throws_ok(
  $$update public.trading_signal_dismissals set dismissed_at = '2026-01-01T00:00:00Z', reason = 'other'$$,
  '42501',
  null,
  'a client cannot change a dismissal record'
);
select throws_ok(
  $$delete from public.trading_signal_dismissals$$,
  '42501',
  null,
  'a client cannot delete a dismissal record'
);

-- A frontend released before 20261028120000 still sends a direct UPDATE: it
-- records evidence too, with no reason.
update public.trading_signals set status = 'DISMISSED'
where id = '50000000-0000-4000-8000-000000000005' and status = 'PENDING';
select results_eq(
  $$
    select d.user_id, d.actor_id, d.reason, d.dismissed_at is not null
    from public.trading_signal_dismissals d
    where d.signal_id = '50000000-0000-4000-8000-000000000005'
  $$,
  $$
    values (
      '00000000-0000-4000-8000-000000000031'::uuid,
      '00000000-0000-4000-8000-000000000031'::uuid,
      null::text,
      true
    )
  $$,
  'an old client''s direct dismissal records its evidence in the same statement'
);
with changed as (
  update public.trading_signals set status = 'DISMISSED'
  where id = '50000000-0000-4000-8000-000000000008'
  returning 1
)
select is(count(*)::int, 0, 'a direct update cannot dismiss another owner''s signal') from changed;
select throws_ok(
  $$update public.trading_signals set status = 'EXECUTED' where id = '50000000-0000-4000-8000-000000000006'$$,
  '42501',
  null,
  'a client still cannot mark a signal EXECUTED without its fill'
);

-- What the journal reads: each of the owner's signals with its record, if any.
select results_eq(
  $$
    select s.event_id, s.status, d.reason, d.signal_id is not null
    from public.trading_signals s
    left join public.trading_signal_dismissals d on d.signal_id = s.id
    order by s.event_id
  $$,
  $$
    values
      ('conflict', 'DISMISSED', 'too_risky', true),
      ('executed', 'EXECUTED', null, false),
      ('fill-linked', 'PENDING', null, false),
      ('legacy-dismissed', 'DISMISSED', null, false),
      ('no-reason', 'DISMISSED', null, true),
      ('old-client', 'DISMISSED', null, true),
      ('still-pending', 'PENDING', null, false),
      ('with-reason', 'DISMISSED', 'price_moved', true)
  $$,
  'the owner reads every signal with its own dismissal evidence, legacy rows without any'
);
select is_empty(
  $$
    select 1
    from public.trading_signal_dismissals d
    join public.paper_transactions p on p.signal_id = d.signal_id
  $$,
  'no dismissed signal carries a booked fill'
);
select is(
  (select count(*)::int from public.paper_transactions where user_id = '00000000-0000-4000-8000-000000000031'),
  2,
  'dismissals booked nothing: the one execution and the injected fill only'
);

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000032', true);
select is_empty(
  $$select 1 from public.trading_signal_dismissals$$,
  'another owner reads none of these dismissal records'
);
select is(
  (select status from public.trading_signals where id = '50000000-0000-4000-8000-000000000008'),
  'PENDING',
  'the other owner''s signal is still pending'
);

select set_config('request.jwt.claim.sub', '', true);
select throws_ok(
  $$select public.dismiss_tactical_signal('50000000-0000-4000-8000-000000000006')$$,
  '42501',
  'Not authorized to dismiss this signal',
  'a request without a signed-in user is refused'
);

reset role;
set local role anon;
select throws_ok(
  $$select public.dismiss_tactical_signal('50000000-0000-4000-8000-000000000006')$$,
  '42501',
  null,
  'anon cannot call dismiss_tactical_signal'
);
select throws_ok(
  $$select * from public.trading_signal_dismissals$$,
  '42501',
  null,
  'anon cannot read dismissal records'
);

-- Even the service role can't rewrite a record or dismiss without an owner.
reset role;
set local role service_role;
select throws_ok(
  $$update public.trading_signal_dismissals set reason = 'other' where signal_id = '50000000-0000-4000-8000-000000000001'$$,
  '42501',
  'Signal dismissals are append-only',
  'a dismissal record is append-only for the service role too'
);
select throws_ok(
  $$update public.trading_signals set status = 'DISMISSED' where id = '50000000-0000-4000-8000-000000000006'$$,
  '42501',
  'Only the signal''s owner can dismiss it',
  'a dismissal without a signed-in owner is refused on every path'
);

reset role;
select is(
  (select count(*)::int from public.trading_signal_dismissals where user_id = '00000000-0000-4000-8000-000000000031'),
  4,
  'four dismissals, four records'
);

select * from finish();
rollback;
