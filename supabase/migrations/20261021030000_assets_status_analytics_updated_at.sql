-- When market-analytics last refreshed a row's analytics columns. updated_at
-- belongs to the price feeds, so without this a ticker whose candles keep
-- failing shows weeks-old signals next to a fresh quote and nothing says so.
-- The function stamps it on every row it writes and reports the oldest one as
-- oldest_data_age_mins. Existing rows stay null until the next run.
alter table public.assets_status add column if not exists analytics_updated_at timestamptz;
