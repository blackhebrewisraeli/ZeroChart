-- equity-forex-price-feed (20261021010000) stamps each quote with its market
-- time, so from 2 hours after the close until the open (all weekend for forex)
-- the 2-hour quote age check refuses equity and forex fills. That is the
-- intended rule: a closed market has no price to fill at. Only the message
-- changes, since "try again after the next price refresh" sent users retrying
-- every 15 minutes into a closed market. Otherwise identical to 20261020210000.
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
    raise exception '%''s server price is over % hours old: its market is closed or the price feed is behind.',
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
