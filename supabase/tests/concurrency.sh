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

exit "$failures"
