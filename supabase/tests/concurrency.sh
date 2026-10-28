#!/usr/bin/env bash
# Races two real database sessions, which pgTAP's single transaction can't.
# Usage: supabase/tests/concurrency.sh [postgres URL]  (default: local stack)
set -euo pipefail

DB="${1:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
USER_ID=00000000-0000-4000-8000-0000000000c1
SIGNAL_ID=30000000-0000-4000-8000-0000000000c1
BATCH_ID=30000000-0000-4000-8000-0000000000c2
OTHER_BATCH_ID=30000000-0000-4000-8000-0000000000c3
TOKEN_HASH=cc8321d6375c494d043fdd0260f21bc0ec51fd7454e2501e5fbaa8f135f31299
failures=0

sql() {
  local query=$1
  psql "$DB" -X -q -At -v ON_ERROR_STOP=1 -c "$query"
}
# One authenticated session: runs the statements, then holds its transaction open.
as_user() {
  local statements=$1 hold_seconds=${2:-0}
  psql "$DB" -X -q -At 2>&1 <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$USER_ID', true);
$statements
select pg_sleep($hold_seconds);
commit;
SQL
}
as_service() {
  local statements=$1 hold_seconds=${2:-0}
  psql "$DB" -X -q -At 2>&1 <<SQL
begin;
set local role service_role;
$statements
select pg_sleep($hold_seconds);
commit;
SQL
}
check() {
  local name=$1 got=$2 want=$3
  if [[ "$got" == "$want" ]]; then echo "ok - $name"; else echo "not ok - $name: got '$got', want '$want'"; failures=$((failures + 1)); fi
}
cleanup() { sql "delete from auth.users where id = '$USER_ID'; delete from public.assets_status where ticker = 'RACE';" >/dev/null; }
trap cleanup EXIT

cleanup
sql "
insert into auth.users (id) values ('$USER_ID');
insert into public.signal_webhook_tokens (user_id, token_hash) values ('$USER_ID', '$TOKEN_HASH');
insert into public.assets_status (ticker, current_price, updated_at, atr_14, analytics_updated_at)
values ('RACE', 100, now(), 1, now());
insert into public.trading_signals
  (id, user_id, ticker, action, signal_score, quantity, price, event_id, signal_kind, exchange, timeframe, bar_time, model_version)
values
  ('$SIGNAL_ID', '$USER_ID', 'RACE', 'BUY', 90, 10, 100, 'race', 'strategy', 'TEST', '1D', now(), '1.0.0');
"

# 1. Two clicks on one signal: the second waits for the first, then finds it executed.
execute_signal="select public.execute_tactical_signal('$SIGNAL_ID', '$USER_ID', 100);"
as_user "$execute_signal" 2 >/dev/null &
first=$!
sleep 0.5
second=$(as_user "$execute_signal")
wait "$first"
check "a concurrent second execution is refused" \
  "$(grep -o 'Signal is no longer waiting' <<<"$second")" 'Signal is no longer waiting'
check "one signal books exactly one fill" \
  "$(sql "select count(*) from public.paper_transactions where signal_id = '$SIGNAL_ID'")" 1

# 2. Two deliveries racing for one logical event: one saved signal.
ingest_signal() {
  local event_id=$1
  echo "select public.ingest_tradingview_signal('$TOKEN_HASH', jsonb_build_object('signal_kind','strategy','ticker','RACE','action','SELL','signal_score',10,'price',100,'quantity',1,'event_id','$event_id','exchange','TEST','timeframe','D','bar_time','2026-10-27T00:00:00Z','model_version','1.0.0-pw200'));"
}
as_service "$(ingest_signal delivery-a)" 2 >/dev/null &
first=$!
sleep 0.5
second=$(as_service "$(ingest_signal delivery-b)")
wait "$first"
check "a concurrent logical-event retry is a duplicate" "$(grep -c duplicate <<<"$second")" 1
check "concurrent deliveries save one signal" \
  "$(sql "select count(*) from public.trading_signals where user_id = '$USER_ID' and ticker = 'RACE' and action = 'SELL'")" 1

# 3. A retry racing the original request: one batch of fills, the same receipt twice.
invest() {
  local request_id=$1 budget=$2 amount=$3
  echo "select public.execute_paper_portfolio('$request_id', 'moderate', $budget, '[{\"ticker\": \"RACE\", \"amount\": $amount, \"score\": 70}]')->>'request_id';"
}
as_user "$(invest "$BATCH_ID" 60000 15000)" 2 >/dev/null &
first=$!
sleep 0.5
retry=$(as_user "$(invest "$BATCH_ID" 60000 15000)")
wait "$first"
check "the racing retry gets the original receipt" "$(grep -c "$BATCH_ID" <<<"$retry")" 1
check "the racing retry books no second fill" \
  "$(sql "select count(*) from public.paper_transactions where batch_id = '$BATCH_ID'")" 1

# 4. Two proposals for more than the cash left: the second sees what the first spent.
budget_left=$(sql "select floor(cash) from public.paper_account_book('$USER_ID')")
as_user "$(invest 30000000-0000-4000-8000-0000000000c4 "$budget_left" 100)" 2 >/dev/null &
first=$!
sleep 0.5
second=$(as_user "$(invest "$OTHER_BATCH_ID" "$budget_left" 100)")
wait "$first"
check "a competing proposal cannot spend the same Paper Cash" \
  "$(grep -c 'Paper Cash' <<<"$second")" 1
check "the refused proposal books nothing" \
  "$(sql "select count(*) from public.paper_transactions where batch_id = '$OTHER_BATCH_ID'")" 0

# 5. Dismissals. SELL signals of the RACE held since section 1, so executing one needs no cash.
race_signal() { echo "30000000-0000-4000-8000-0000000000d$1"; }
sql "
insert into public.trading_signals
  (id, user_id, ticker, action, signal_score, quantity, price, event_id, signal_kind, exchange, timeframe, bar_time, model_version)
select ('30000000-0000-4000-8000-0000000000d' || n)::uuid, '$USER_ID', 'RACE', 'SELL', 20, 1, 100,
  'race-dismiss-' || n, 'strategy', 'TEST', '1D', ('2026-10-0' || n || 'T00:00:00Z')::timestamptz, '1.0.0'
from generate_series(1, 5) n;
"
dismiss_signal() {
  local id=$1 reason=${2:-}
  echo "select 'dismissed_at=' || dismissed_at from public.dismiss_tactical_signal('$id'${reason:+, '$reason'});"
}
execute_race_signal() { echo "select public.execute_tactical_signal('$1', '$USER_ID', 100);"; }
# status/linked fills/dismissal records
outcome() {
  sql "select s.status || '/' || (select count(*) from public.paper_transactions p where p.signal_id = s.id)
    || '/' || (select count(*) from public.trading_signal_dismissals d where d.signal_id = s.id)
    from public.trading_signals s where s.id = '$1'"
}

# 5a. Two clicks on Dismiss: the second waits, then gets the first one's record.
as_user "$(dismiss_signal "$(race_signal 1)")" 2 >/dev/null &
first=$!
sleep 0.5
second=$(as_user "$(dismiss_signal "$(race_signal 1)")")
wait "$first"
check "a concurrent second dismissal gets the original record" \
  "$(grep -o 'dismissed_at=.*' <<<"$second")" \
  "$(sql "select 'dismissed_at=' || dismissed_at from public.trading_signal_dismissals where signal_id = '$(race_signal 1)'")"
check "concurrent dismissals record once" "$(outcome "$(race_signal 1)")" 'DISMISSED/0/1'

# 5b. Dismissal first, execution second: the execution finds it dismissed.
as_user "$(dismiss_signal "$(race_signal 2)")" 2 >/dev/null &
first=$!
sleep 0.5
second=$(as_user "$(execute_race_signal "$(race_signal 2)")")
wait "$first"
check "an execution racing a dismissal is refused" \
  "$(grep -o 'Signal is no longer waiting' <<<"$second")" 'Signal is no longer waiting'
check "the dismissed signal has its record and no fill" "$(outcome "$(race_signal 2)")" 'DISMISSED/0/1'

# 5c. Execution first, dismissal second: the dismissal finds it executed.
as_user "$(execute_race_signal "$(race_signal 3)")" 2 >/dev/null &
first=$!
sleep 0.5
second=$(as_user "$(dismiss_signal "$(race_signal 3)")")
wait "$first"
check "a dismissal racing an execution is refused" \
  "$(grep -o "Signal was executed, so it can't be dismissed" <<<"$second")" \
  "Signal was executed, so it can't be dismissed"
check "the executed signal has one fill and no dismissal record" "$(outcome "$(race_signal 3)")" 'EXECUTED/1/0'

# 5d. A pre-20261028120000 frontend's direct UPDATE racing an execution: it re-reads
# the row after the lock, finds it no longer PENDING, and changes nothing.
as_user "$(execute_race_signal "$(race_signal 4)")" 2 >/dev/null &
first=$!
sleep 0.5
second=$(as_user "with changed as (update public.trading_signals set status = 'DISMISSED' where id = '$(race_signal 4)' and status = 'PENDING' returning 1) select 'updated=' || count(*) from changed;")
wait "$first"
check "an old client's racing direct dismissal updates no row" "$(grep -o 'updated=.*' <<<"$second")" updated=0
check "the executed signal stays executed with no dismissal record" "$(outcome "$(race_signal 4)")" 'EXECUTED/1/0'

# 5e. Two tabs dismissing with different reasons: the first reason stands.
as_user "$(dismiss_signal "$(race_signal 5)" too_risky)" 2 >/dev/null &
first=$!
sleep 0.5
second=$(as_user "$(dismiss_signal "$(race_signal 5)" stale)")
wait "$first"
check "a racing dismissal with another reason is refused" \
  "$(grep -o 'Signal was already dismissed with another reason' <<<"$second")" \
  'Signal was already dismissed with another reason'
check "the first reason is the recorded one" \
  "$(sql "select reason from public.trading_signal_dismissals where signal_id = '$(race_signal 5)'")" too_risky
check "no dismissed signal carries a booked fill" \
  "$(sql "select count(*) from public.trading_signal_dismissals d join public.paper_transactions p using (signal_id)")" 0

exit "$failures"
