-- Confirm books the orders the preview showed, or nothing.
--
-- The Quant Analyzer previews a proposal with a dry run, then Confirm prices it
-- again at the server quote. Until now Confirm booked whatever that second
-- pricing produced, however far it had moved since the preview. A Confirm now
-- sends the previewed orders as `expected`, and the booking is refused unless
-- every order is still there with its price and units within 0.5% of the
-- preview: check_paper_transaction's existing fill tolerance, not a new limit.
-- The client then shows the refreshed plan for a fresh Confirm.
--
-- `expected` defaults to null, which skips the check, so a frontend released
-- before this migration keeps working. PT409 makes PostgREST answer 409.

-- A new argument needs a fresh function, not create or replace (which would
-- add an overload that a five-argument call could no longer resolve).
drop function public.execute_paper_portfolio(uuid, text, numeric, jsonb, boolean);

create function public.execute_paper_portfolio(
  request_id uuid,
  risk_profile text,
  budget numeric,
  holdings jsonb,
  dry_run boolean default false,
  expected jsonb default null
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
  invalid constant text := 'invalid_parameter_value';
  -- check_paper_transaction's fill tolerance.
  preview_tolerance constant numeric := 0.005;
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
    raise exception 'A request ID is required' using errcode = invalid;
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
    raise exception 'Unknown risk profile %', coalesce(risk_profile, 'null') using errcode = invalid;
  end if;
  if budget is null or budget <= 0 then
    raise exception 'Enter an investment amount greater than $0' using errcode = invalid;
  end if;
  if jsonb_typeof(holdings) is distinct from 'array' or jsonb_array_length(holdings) = 0 then
    raise exception 'The proposal has no holdings' using errcode = invalid;
  end if;
  if jsonb_array_length(holdings) > policy.max_holdings then
    raise exception 'A % portfolio holds at most % assets', risk_profile, policy.max_holdings
      using errcode = rejected;
  end if;
  if (select count(distinct upper(h ->> 'ticker')) from jsonb_array_elements(holdings) h)
    <> jsonb_array_length(holdings) then
    raise exception 'Each asset can appear only once in a proposal' using errcode = invalid;
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
      raise exception 'Every holding needs a ticker' using errcode = invalid;
    end if;
    if allocation is null or allocation <= 0 then
      raise exception '% needs an allocation greater than $0', symbol using errcode = invalid;
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

  -- The same assets as the preview, each still within the tolerance on price
  -- and units. A missing or malformed field counts as moved.
  if not dry_run and expected is not null and (
    jsonb_typeof(expected) is distinct from 'array'
    or jsonb_array_length(expected) <> jsonb_array_length(orders)
    or exists (
      select 1
      from jsonb_array_elements(orders) o
      left join jsonb_array_elements(expected) e on upper(e ->> 'ticker') = o ->> 'ticker'
      where not coalesce(
        abs((o ->> 'price')::numeric - (e ->> 'price')::numeric)
          <= (o ->> 'price')::numeric * preview_tolerance
        and abs((o ->> 'quantity')::numeric - (e ->> 'quantity')::numeric)
          <= (o ->> 'quantity')::numeric * preview_tolerance,
        false
      )
    )
  ) then
    raise exception 'Prices or sizes moved more than % since the preview. Review the updated orders and confirm again.',
      trim_scale(preview_tolerance * 100) || '%'
      using errcode = 'PT409';
  end if;

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

revoke all on function public.execute_paper_portfolio(uuid, text, numeric, jsonb, boolean, jsonb) from public, anon;
grant execute on function public.execute_paper_portfolio(uuid, text, numeric, jsonb, boolean, jsonb) to authenticated;
