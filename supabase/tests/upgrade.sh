#!/usr/bin/env bash
# Upgrade check: builds the database as the base commit left it, fills it with
# rows shaped like production's, applies this branch's new migrations on top,
# then proves the old rows survived and still work with the new code.
# Usage: supabase/tests/upgrade.sh <base git ref> [postgres URL]
# Set SUPABASE_WORKDIR to run against a stack started with --workdir.
set -euo pipefail

BASE_REF="${1:?base git ref, e.g. origin/main}"
DB="${2:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
WORKDIR=(${SUPABASE_WORKDIR:+--workdir "$SUPABASE_WORKDIR"})
USER_ID=00000000-0000-4000-8000-0000000000e1
failures=0

base=$(git ls-tree --name-only "$BASE_REF" supabase/migrations/ | sed -En 's#.*/([0-9]{14})_.*#\1#p' | tail -1)
echo "# base $BASE_REF is at migration $base"
supabase db reset "${WORKDIR[@]}" --local --version "$base" >/dev/null

sql() { psql "$DB" -X -q -At -v ON_ERROR_STOP=1 -c "$1"; }
check() {
  if [[ "$2" == "$3" ]]; then echo "ok - $1"; else echo "not ok - $1: got '$2', want '$3'"; failures=$((failures + 1)); fi
}

# Only columns every released schema has: the seed must load on the base.
sql "
insert into auth.users (id) values ('$USER_ID');
insert into public.signal_webhook_tokens (user_id, token_hash)
values ('$USER_ID', encode(sha256(convert_to('tok-upgrade', 'UTF8')), 'hex'));
insert into public.assets_status (ticker, current_price, updated_at) values ('UPGRADECOIN', 200, now());
insert into public.paper_transactions (user_id, action, ticker, quantity, price, fees) values
  ('$USER_ID', 'DEPOSIT', null, 5000, null, 0),
  ('$USER_ID', 'BUY', 'UPGRADECOIN', 10, 200, 5),
  ('$USER_ID', 'SELL', 'UPGRADECOIN', 4, 200, 2);
insert into public.trading_signals (user_id, ticker, action, signal_score, quantity, price, event_id, status) values
  ('$USER_ID', 'UPGRADECOIN', 'SELL', 20, 6, 200, 'upgrade-pending', 'PENDING'),
  ('$USER_ID', 'UPGRADECOIN', 'BUY', 90, 10, 200, 'upgrade-done', 'EXECUTED');
"

supabase migration up "${WORKDIR[@]}" --local >/dev/null

check "every fill survived" \
  "$(sql "select count(*) from public.paper_transactions where user_id = '$USER_ID'")" 3
check "every signal survived with its status" \
  "$(sql "select string_agg(status, ',' order by event_id) from public.trading_signals where user_id = '$USER_ID'")" \
  'EXECUTED,PENDING'
# 100,000 + 5,000 - (2,000 + 5) + (800 - 2): the book replays the old ledger unchanged.
check "the new account book replays the old ledger" \
  "$(sql "select cash from public.paper_account_book('$USER_ID')")" 103793
check "an existing token still authenticates the webhook" \
  "$(sql "select public.ingest_tradingview_signal(encode(sha256(convert_to('tok-upgrade', 'UTF8')), 'hex'), null)")" \
  authorized
executed=$(psql "$DB" -X -q -At 2>&1 <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$USER_ID', true);
select action || ' ' || quantity from public.execute_tactical_signal(
  (select id from public.trading_signals where event_id = 'upgrade-pending'), '$USER_ID', 200
);
commit;
SQL
)
check "a signal left pending by the old release still executes" "$(tail -1 <<<"$executed")" 'SELL 6'

sql "delete from auth.users where id = '$USER_ID'; delete from public.assets_status where ticker = 'UPGRADECOIN';" >/dev/null
exit "$failures"
