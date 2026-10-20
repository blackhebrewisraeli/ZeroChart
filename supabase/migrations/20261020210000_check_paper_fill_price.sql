-- Paper fills must be priced near the scanner's server quote
-- (assets_status.current_price), not wherever the client says.
--
-- Tolerance: Paper Trading fills crypto at the live Binance tick (1 s
-- mini-ticker, USDT pairs) and everything else at the assets_status row the
-- client polls every 60 s. The quote can be up to 2 hours old, which is the
-- point where the UI labels it Stale (FRESHNESS_MAX_AGE_MS in freshness.ts).
-- Over 2 hours, crypto moves with a standard deviation of roughly 0.75% (BTC)
-- to 1.5% (alts), plus about 0.1% of USDT/USD basis. 5% is 3 to 6 of those
-- deviations, so normal fills pass.
--
-- Missing or stale quote: reject. If unverifiable fills were allowed and
-- flagged, the check could be skipped by picking a ticker the scanner doesn't
-- cover, and every stale quote would open a cheating window. Nothing reads such
-- a flag yet. A rejected fill books nothing, and the toast says why.
create or replace function public.check_paper_transaction()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  -- ponytail: a 5% band still lets a deliberate trader skim up to 5% a fill.
  -- Tighten it once the scanner's refresh schedule is known, or fill at the quote.
  tolerance constant numeric := 0.05;
  max_quote_age_hours constant int := 2;
  rejected constant text := 'check_violation';
  cash numeric;
  held numeric;
  quote numeric;
  quoted_at timestamptz;
begin
  -- One writer per account at a time, so two tabs can't spend the same cash.
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));
  -- Stamp after the lock: now() is the transaction start, which would sort a
  -- row that waited on the lock before the row it waited for.
  new.created_at := clock_timestamp();
  if new.action not in ('BUY', 'SELL') then
    return new;
  end if;

  -- Paper rows carry the upper-cased scanner ticker (executePaperTrade).
  select a.current_price, a.updated_at
  into quote, quoted_at
  from public.assets_status a
  where upper(a.ticker) = new.ticker and a.current_price > 0
  order by a.updated_at desc
  limit 1;

  if quote is null then
    raise exception '% has no server price, so Paper Trading can''t fill it', new.ticker
      using errcode = rejected;
  end if;
  if quoted_at < new.created_at - make_interval(hours => max_quote_age_hours) then
    raise exception '%''s server price is over % hours old. Try again after the next price refresh.',
      new.ticker, max_quote_age_hours
      using errcode = rejected;
  end if;
  if abs(new.price - quote) > quote * tolerance then
    raise exception '% has moved more than % from its server price. Try again after the next price refresh.',
      new.ticker, trim_scale(tolerance * 100) || '%'
      using errcode = rejected;
  end if;

  select
    100000 + coalesce(sum(
      case pt.action
        when 'DEPOSIT' then pt.quantity
        when 'BUY' then -(pt.quantity * pt.price + pt.fees)
        when 'SELL' then pt.quantity * pt.price - pt.fees
        else 0
      end
    ), 0),
    coalesce(sum(
      case
        when pt.ticker = new.ticker and pt.action = 'BUY' then pt.quantity
        when pt.ticker = new.ticker and pt.action = 'SELL' then -pt.quantity
        else 0
      end
    ), 0)
  into cash, held
  from public.paper_transactions pt
  where pt.user_id = new.user_id
    and pt.created_at > coalesce(
      (
        select max(r.created_at)
        from public.paper_transactions r
        where r.user_id = new.user_id and r.action = 'RESET'
      ),
      '-infinity'
    );

  if new.action = 'BUY' and new.quantity * new.price + new.fees > cash then
    raise exception 'Insufficient cash' using errcode = rejected;
  end if;
  -- 1e-9 matches the engine's ZERO_SHARE_EPSILON, so "sell all" of a
  -- float-summed position still clears.
  if new.action = 'SELL' and new.quantity > held + 1e-9 then
    raise exception 'Insufficient shares' using errcode = rejected;
  end if;
  return new;
end;
$$;
