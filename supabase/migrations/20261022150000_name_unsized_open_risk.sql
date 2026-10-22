-- Name the missing input when the open-risk cap refuses a BUY.
--
-- A position with no current ATR(14) counts its whole entry as at risk. That
-- is the safe assumption, but the refusal only said "Portfolio max risk
-- reached", so a stale analytics run (2026-10-22, 15:18-15:20 UTC) read as real
-- risk. paper_account_book now lists those positions, and the cap lives in one
-- function, paper_assert_open_risk, that the fill trigger and
-- execute_paper_portfolio both call. Limits and arithmetic are unchanged.

-- Raises when open risk plus a new order's would pass max_open_risk of
-- `equity`, naming any position counted at its whole entry for want of an ATR.
create or replace function public.paper_assert_open_risk(
  open_risk numeric,
  added_risk numeric,
  equity numeric,
  unsized text,
  advice text default null
)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  cap constant numeric := (select p.max_open_risk from public.paper_risk_policy() p);
begin
  if open_risk + added_risk <= equity * cap then
    return;
  end if;
  raise exception '%', concat_ws(
    ' ',
    format(
      'Portfolio max risk reached: %s open + %s new would pass the %s limit.',
      to_char(100 * open_risk / equity, 'FM990.0') || '%',
      to_char(100 * added_risk / equity, 'FM990.0') || '%',
      trim_scale(cap * 100) || '%'
    ),
    case when unsized is not null then format(
      'No current ATR(14) reading for %s, so %s whole entry counts as at risk until the next daily market analytics run.',
      unsized,
      case when strpos(unsized, ',') > 0 then 'their' else 'its' end
    ) end,
    advice
  ) using errcode = 'check_violation';
end;
$$;

-- A new OUT column needs a fresh function, not create or replace.
drop function public.paper_account_book(uuid);

create function public.paper_account_book(
  account uuid,
  out cash numeric,
  out equity numeric,
  out open_risk numeric,
  out unsized text
)
language sql
stable
set search_path = ''
as $$
  with ledger as (
    select pt.action, upper(pt.ticker) as ticker, pt.quantity, pt.price, pt.fees, pt.created_at
    from public.paper_transactions pt
    where pt.user_id = account
      and pt.created_at > coalesce(
        (
          select max(r.created_at)
          from public.paper_transactions r
          where r.user_id = account and r.action = 'RESET'
        ),
        '-infinity'
      )
  ),
  fills as (
    select
      l.*,
      sum(case l.action when 'BUY' then l.quantity else -l.quantity end)
        over (partition by l.ticker order by l.created_at) as held_after
    from ledger l
    where l.action in ('BUY', 'SELL')
  ),
  since_flat as (
    select
      f.*,
      coalesce(
        max(f.created_at) filter (where f.held_after <= 1e-9) over (partition by f.ticker),
        '-infinity'
      ) as flat_at
    from fills f
  ),
  positions as (
    select
      s.ticker,
      sum(case s.action when 'BUY' then s.quantity else -s.quantity end) as shares,
      sum(s.quantity * s.price) filter (where s.action = 'BUY' and s.created_at > s.flat_at)
        / nullif(sum(s.quantity) filter (where s.action = 'BUY' and s.created_at > s.flat_at), 0)
        as entry
    from since_flat s
    group by s.ticker
    having sum(case s.action when 'BUY' then s.quantity else -s.quantity end) > 1e-9
  ),
  marked as (
    select p.ticker, p.shares, coalesce(p.entry, q.current_price) as entry, q.current_price as mark, q.atr
    from positions p
    cross join public.paper_risk_policy() policy
    left join lateral (
      select
        a.current_price,
        case
          when a.analytics_updated_at > clock_timestamp() - policy.max_atr_age and a.atr_14 > 0
            then a.atr_14
        end as atr
      from public.assets_status a
      where upper(a.ticker) = p.ticker and a.current_price > 0
      order by a.updated_at desc
      limit 1
    ) q on true
  ),
  balance as (
    select 100000 + coalesce(sum(
      case l.action
        when 'DEPOSIT' then l.quantity
        when 'BUY' then -(l.quantity * l.price + l.fees)
        when 'SELL' then l.quantity * l.price - l.fees
        else 0
      end
    ), 0) as cash
    from ledger l
  )
  select
    b.cash,
    b.cash + coalesce((select sum(m.shares * coalesce(m.mark, m.entry)) from marked m), 0),
    coalesce(
      (select sum(m.shares * (m.entry - public.paper_planned_stop(m.entry, m.atr))) from marked m),
      0
    ),
    (select string_agg(m.ticker, ', ' order by m.ticker) from marked m where m.atr is null)
  from balance b
$$;


create or replace function public.check_paper_transaction()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  tolerance constant numeric := 0.005;
  max_quote_age_hours constant int := 2;
  rejected constant text := 'check_violation';
  policy record;
  cash numeric;
  held numeric;
  quote numeric;
  quoted_at timestamptz;
  atr numeric;
  analysed_at timestamptz;
  book record;
  added_risk numeric;
begin
  -- One writer per account at a time, so two tabs can't spend the same cash.
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));
  -- Stamp after the lock: now() is the transaction start, which would sort a
  -- row that waited on the lock before the row it waited for.
  new.created_at := clock_timestamp();
  if new.action not in ('BUY', 'SELL') then
    return new;
  end if;

  select a.current_price, a.updated_at, a.atr_14, a.analytics_updated_at
  into quote, quoted_at, atr, analysed_at
  from public.assets_status a
  where upper(a.ticker) = new.ticker and a.current_price > 0
  order by a.updated_at desc
  limit 1;

  if quote is null then
    raise exception '% has no server price, so Paper Trading can''t fill it', new.ticker
      using errcode = rejected;
  end if;
  if quoted_at is null
    or quoted_at < new.created_at - make_interval(hours => max_quote_age_hours) then
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

  -- Sells only shrink exposure. A BUY's planned stop is the one its RPC
  -- recorded, else the ATR stop usePaperRisk assumes.
  if new.action = 'BUY' then
    select * into policy from public.paper_risk_policy();
    if analysed_at is null or analysed_at < new.created_at - policy.max_atr_age then
      atr := null;
    end if;
    select * into book from public.paper_account_book(new.user_id);
    added_risk := new.quantity
      * greatest(0, new.price - coalesce(new.stop_price, public.paper_planned_stop(new.price, atr)));
    perform public.paper_assert_open_risk(
      book.open_risk,
      added_risk,
      book.equity,
      -- The order is unsized too when it has neither a recorded stop nor an ATR.
      nullif(concat_ws(', ', book.unsized, case
        when new.stop_price is null and coalesce(atr, 0) <= 0
          and new.ticker <> all (coalesce(string_to_array(book.unsized, ', '), '{}'))
          then new.ticker
      end), '')
    );
  end if;
  return new;
end;
$$;


create or replace function public.execute_paper_portfolio(
  request_id uuid,
  risk_profile text,
  budget numeric,
  holdings jsonb,
  dry_run boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  account uuid := (select auth.uid());
  rejected constant text := 'check_violation';
  policy record;
  book record;
  prior public.paper_order_batches%rowtype;
  holding jsonb;
  symbol text;
  allocation numeric;
  attested_score numeric;
  server_price numeric;
  priced_at timestamptz;
  server_atr numeric;
  analysed_at timestamptz;
  planned_stop numeric;
  units numeric;
  fee numeric;
  spent numeric := 0;
  fees numeric := 0;
  planned_risk numeric := 0;
  orders jsonb := '[]';
  receipt jsonb;
  usd constant text := 'FM$999,999,999,990.00';
begin
  if account is null then
    raise exception 'Sign in to invest from Paper Cash' using errcode = '42501';
  end if;
  if request_id is null then
    raise exception 'A request ID is required' using errcode = '22023';
  end if;
  -- check_paper_transaction's lock: competing proposals and fills on one
  -- account run one at a time and each sees the cash the last one left.
  perform pg_advisory_xact_lock(hashtextextended(account::text, 0));

  select * into prior from public.paper_order_batches b where b.id = request_id;
  if found then
    if prior.user_id <> account then
      raise exception 'This request ID belongs to another account' using errcode = '42501';
    end if;
    return prior.receipt || jsonb_build_object('replayed', true);
  end if;

  select * into policy from public.paper_risk_policy(risk_profile);
  if policy.max_holdings is null then
    raise exception 'Unknown risk profile %', coalesce(risk_profile, 'null') using errcode = '22023';
  end if;
  if budget is null or budget <= 0 then
    raise exception 'Enter an investment amount greater than $0' using errcode = '22023';
  end if;
  if jsonb_typeof(holdings) is distinct from 'array' or jsonb_array_length(holdings) = 0 then
    raise exception 'The proposal has no holdings' using errcode = '22023';
  end if;
  if jsonb_array_length(holdings) > policy.max_holdings then
    raise exception 'A % portfolio holds at most % assets', risk_profile, policy.max_holdings
      using errcode = rejected;
  end if;
  if (select count(distinct upper(h ->> 'ticker')) from jsonb_array_elements(holdings) h)
    <> jsonb_array_length(holdings) then
    raise exception 'Each asset can appear only once in a proposal' using errcode = '22023';
  end if;

  select * into book from public.paper_account_book(account);
  -- Paper Cash funds the proposal. Nothing here deposits more.
  if budget > book.cash then
    raise exception 'The % budget is more than your % Paper Cash',
      to_char(budget, usd), to_char(book.cash, usd)
      using errcode = rejected;
  end if;

  for holding in select h from jsonb_array_elements(holdings) h loop
    symbol := upper(trim(holding ->> 'ticker'));
    allocation := case when jsonb_typeof(holding -> 'amount') = 'number' then (holding ->> 'amount')::numeric end;
    attested_score := case when jsonb_typeof(holding -> 'score') = 'number' then (holding ->> 'score')::numeric end;

    if symbol is null or symbol = '' then
      raise exception 'Every holding needs a ticker' using errcode = '22023';
    end if;
    if allocation is null or allocation <= 0 then
      raise exception '% needs an allocation greater than $0', symbol using errcode = '22023';
    end if;
    -- A cent of slack for the client rounding each allocation to cents.
    if allocation > budget * policy.max_position + 0.01 then
      raise exception '%''s % allocation is over the % a % portfolio allows per holding',
        symbol, to_char(allocation, usd), trim_scale(policy.max_position * 100) || '%', risk_profile
        using errcode = rejected;
    end if;
    if attested_score is null or attested_score < policy.min_score then
      raise exception '%''s Signal Score % is below the % a % portfolio requires',
        symbol, coalesce(attested_score::text, 'is missing and'), policy.min_score, risk_profile
        using errcode = rejected;
    end if;

    server_price := null;
    select a.current_price, a.updated_at, a.atr_14, a.analytics_updated_at
    into server_price, priced_at, server_atr, analysed_at
    from public.assets_status a
    where upper(a.ticker) = symbol and a.current_price > 0
    order by a.updated_at desc
    limit 1;

    if server_price is null then
      raise exception '% has no server price, so Paper Trading can''t fill it', symbol
        using errcode = rejected;
    end if;
    if priced_at is null or priced_at < clock_timestamp() - policy.max_quote_age then
      raise exception '%''s server price is over 2 hours old: its market is closed or the price feed is behind.',
        symbol using errcode = rejected;
    end if;
    if server_atr is null or server_atr <= 0
      or analysed_at is null or analysed_at < clock_timestamp() - policy.max_atr_age then
      raise exception '% has no current ATR(14) reading, so its risk can''t be sized. Try again after the daily market analytics run.',
        symbol using errcode = rejected;
    end if;
    if risk_profile = 'conservative' and server_atr / server_price >= policy.high_volatility then
      raise exception '% is in a high-volatility regime (ATR is % of its price), which a conservative portfolio excludes',
        symbol, to_char(100 * server_atr / server_price, 'FM990.0') || '%'
        using errcode = rejected;
    end if;

    planned_stop := public.paper_planned_stop(server_price, server_atr);
    units := floor(least(
      policy.risk_per_holding * budget / (server_price - planned_stop),
      allocation / (server_price * (1 + policy.fee_rate)),
      (budget - spent) / (server_price * (1 + policy.fee_rate))
    ) * 1e8) / 1e8;
    if units <= 0 then
      raise exception '%''s allocation is too small to buy any units', symbol using errcode = rejected;
    end if;
    fee := units * server_price * policy.fee_rate;
    spent := spent + units * server_price + fee;
    fees := fees + fee;
    planned_risk := planned_risk + units * (server_price - planned_stop);
    orders := orders || jsonb_build_object(
      'ticker', symbol,
      'quantity', units,
      'price', server_price,
      'fees', fee,
      'cost', units * server_price + fee,
      'stop_price', planned_stop,
      'atr', server_atr,
      'planned_risk', units * (server_price - planned_stop)
    );
  end loop;

  -- Fees leave equity as they are paid, so test against what it will be.
  perform public.paper_assert_open_risk(
    book.open_risk, planned_risk, book.equity - fees, book.unsized, 'Lower the amount.'
  );

  receipt := jsonb_build_object(
    'request_id', request_id,
    'status', case when dry_run then 'planned' else 'executed' end,
    'replayed', false,
    'policy_version', policy.version,
    'risk_profile', risk_profile,
    'budget', budget,
    'cash_before', book.cash,
    'spent', spent,
    'fees', fees,
    'cash_after', book.cash - spent,
    'equity', book.equity,
    'open_risk_before', book.open_risk,
    'planned_risk', planned_risk,
    'max_open_risk', book.equity * policy.max_open_risk,
    'orders', orders,
    'executed_at', case when dry_run then null else clock_timestamp() end
  );
  if dry_run then
    return receipt;
  end if;

  insert into public.paper_order_batches (id, user_id, risk_profile, policy_version, budget, receipt)
  values (request_id, account, risk_profile, policy.version, budget, receipt);

  -- One statement per fill, in proposal order: check_paper_transaction
  -- re-checks cash and open risk with every earlier fill of the batch counted.
  for holding in select o from jsonb_array_elements(orders) o loop
    insert into public.paper_transactions (
      user_id, action, ticker, quantity, price, fees, batch_id, stop_price, atr
    ) values (
      account,
      'BUY',
      holding ->> 'ticker',
      (holding ->> 'quantity')::numeric,
      (holding ->> 'price')::numeric,
      (holding ->> 'fees')::numeric,
      request_id,
      (holding ->> 'stop_price')::numeric,
      (holding ->> 'atr')::numeric
    );
  end loop;

  return receipt;
end;
$$;


revoke all on function public.paper_assert_open_risk(numeric, numeric, numeric, text, text) from public, anon;
revoke all on function public.paper_account_book(uuid) from public, anon;
-- The fill trigger runs as the inserting user.
grant execute on function public.paper_assert_open_risk(numeric, numeric, numeric, text, text) to authenticated, service_role;
grant execute on function public.paper_account_book(uuid) to authenticated, service_role;
