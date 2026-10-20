-- Signal contract v2: signal_score and quantity (units, not dollars) replace
-- conviction_score and suggested_size, plus the alert's price and an
-- idempotency key so a re-delivered TradingView alert can't land twice.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'trading_signals' and column_name = 'conviction_score'
  ) then
    alter table public.trading_signals rename column conviction_score to signal_score;
    alter table public.trading_signals rename column suggested_size to quantity;
    -- v1 sizes were dollars from the template but units from Pine; neither can be
    -- read as units safely, so retire whatever is still waiting.
    update public.trading_signals set status = 'DISMISSED' where status = 'PENDING';
  end if;
end
$$;

alter table public.trading_signals add column if not exists price numeric check (price > 0);
alter table public.trading_signals add column if not exists event_id text;

-- tv-webhook treats a unique violation here as an already-recorded alert. v1 rows
-- have a null event_id, which never conflicts.
create unique index if not exists trading_signals_event_idx
  on public.trading_signals (user_id, ticker, action, event_id);
