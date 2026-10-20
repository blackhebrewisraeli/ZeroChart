-- Server-side claim for price alerts. The app used to notify first and
-- deactivate the row afterwards (best effort), with only an in-memory set
-- stopping a refire, so a reload or a second tab could notify the same
-- crossing again. Now a tab notifies only after its conditional update
--   update user_alerts set fired_at = ..., is_active = false
--   where id = ... and fired_at is null and is_active
-- returns the row (src/lib/priceAlerts.ts claimAlert). Postgres re-checks the
-- WHERE clause after a concurrent update commits, so exactly one caller wins.
-- The existing "Users can update their own alerts" policy scopes it.
alter table public.user_alerts add column if not exists fired_at timestamptz;
