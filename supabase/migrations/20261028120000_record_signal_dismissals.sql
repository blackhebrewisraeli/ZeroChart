-- Dismissal evidence (docs/DECISION_JOURNAL.md): when a signal was dismissed,
-- by whom and, optionally, why. One append-only row per dismissed signal,
-- written in the same transaction as the status change. Signals dismissed
-- before this migration get no row and stay "Not recorded": nothing is backfilled.
create table public.trading_signal_dismissals (
  signal_id uuid primary key references public.trading_signals (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The signed-in user who dismissed it. Only the owner can, today.
  actor_id uuid not null,
  dismissed_at timestamptz not null,
  -- Optional and from a fixed list, so no free text is stored.
  reason text check (reason in ('price_moved', 'too_risky', 'stale', 'disagree', 'other'))
);

alter table public.trading_signal_dismissals enable row level security;

-- Owners read their own rows. Clients can't write any: rows come only from
-- dismiss_tactical_signal and the trigger below.
revoke all on table public.trading_signal_dismissals from anon, authenticated;
grant select on table public.trading_signal_dismissals to authenticated;

create policy "Users can read their own signal dismissals"
  on public.trading_signal_dismissals
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Append-only for every role, the service role included. Deleting the account
-- or the signal still cascades.
create function public.refuse_dismissal_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Signal dismissals are append-only' using errcode = '42501';
end;
$$;

create trigger trading_signal_dismissals_append_only
  before update on public.trading_signal_dismissals
  for each row execute function public.refuse_dismissal_update();

-- Every PENDING -> DISMISSED change records its evidence, whichever path made
-- it. dismiss_tactical_signal writes its row (with the reason) first, so this
-- adds nothing then. A direct UPDATE, which frontends released before this
-- migration still send, gets a row with no reason instead of none at all.
create function public.record_signal_dismissal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is distinct from new.user_id then
    raise exception 'Only the signal''s owner can dismiss it' using errcode = '42501';
  end if;
  insert into public.trading_signal_dismissals (signal_id, user_id, actor_id, dismissed_at)
  values (new.id, new.user_id, (select auth.uid()), clock_timestamp())
  on conflict do nothing;
  return null;
end;
$$;

create trigger trading_signals_record_dismissal
  after update of status on public.trading_signals
  for each row
  when (old.status = 'PENDING' and new.status = 'DISMISSED')
  execute function public.record_signal_dismissal();

-- The Action Center's Dismiss. The owner, actor and time come from the server;
-- the caller only names the signal and, optionally, a reason.
create function public.dismiss_tactical_signal(signal_id uuid, reason text default null)
returns public.trading_signal_dismissals
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  tactical_signal public.trading_signals%rowtype;
  recorded public.trading_signal_dismissals%rowtype;
begin
  if caller is null then
    raise exception 'Not authorized to dismiss this signal' using errcode = '42501';
  end if;

  -- The row lock execute_tactical_signal takes: whichever comes second waits,
  -- then sees the first one's outcome.
  select s.*
  into tactical_signal
  from public.trading_signals s
  where s.id = $1 and s.user_id = caller
  for update;

  if not found then
    raise exception 'Signal not found' using errcode = 'P0002';
  end if;

  if tactical_signal.status = 'DISMISSED' then
    select d.* into recorded from public.trading_signal_dismissals d where d.signal_id = $1;
    if not found then
      raise exception 'Signal was dismissed before dismissals were recorded'
        using errcode = 'check_violation';
    end if;
    -- A retry gets the first record back unchanged. A different reason never
    -- replaces it: the caller is told, and the recorded reason stands.
    if recorded.reason is distinct from $2 then
      raise exception 'Signal was already dismissed with another reason' using errcode = 'PT409';
    end if;
    return recorded;
  end if;
  if tactical_signal.status <> 'PENDING' then
    raise exception 'Signal was executed, so it can''t be dismissed' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.paper_transactions p where p.signal_id = $1) then
    raise exception 'Signal has a booked fill, so it can''t be dismissed'
      using errcode = 'check_violation';
  end if;

  insert into public.trading_signal_dismissals (signal_id, user_id, actor_id, dismissed_at, reason)
  values ($1, caller, caller, clock_timestamp(), $2)
  returning * into recorded;

  update public.trading_signals
  set status = 'DISMISSED'
  where id = $1;

  return recorded;
end;
$$;

revoke all on function public.dismiss_tactical_signal(uuid, text) from public, anon;
grant execute on function public.dismiss_tactical_signal(uuid, text) to authenticated;
-- Trigger functions: nothing calls them directly.
revoke all on function public.record_signal_dismissal() from public, anon, authenticated;
revoke all on function public.refuse_dismissal_update() from public, anon, authenticated;
