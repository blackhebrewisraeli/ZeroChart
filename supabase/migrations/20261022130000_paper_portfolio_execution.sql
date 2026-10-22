-- Portfolio-builder execution as one server transaction, plus the portfolio
-- risk limits every Paper Trading BUY must pass on the server.
--
-- Which base each limit applies to:
--   * a holding's allocation (fees included) <= its profile's max_position
--     share of the PROPOSAL BUDGET (roboAdvisor.ts maxAllocation);
--   * a holding risks <= risk_per_holding of the PROPOSAL BUDGET at its planned
--     stop (risk.ts recommendPositionSize), which caps its quantity;
--   * Aggregate Open Risk <= max_open_risk of TOTAL PORTFOLIO EQUITY, cash plus
--     positions marked at the server price, on every BUY (risk.ts checkNewEntry);
--   * the proposal spends existing Paper Cash and never deposits more.
-- A planned stop is a sizing assumption recorded on the fill for audit. Paper
-- Trading places no stop orders: nothing sells when the price crosses it.

-- ===== Risk policy: one versioned source for the trigger and the RPC =====
-- src/test/paperRiskPolicy.test.ts keeps these in step with the TypeScript engine.
create or replace function public.paper_risk_policy(
  risk_profile text default null,
  out version text,
  out fee_rate numeric,
  out stop_atr_multiple numeric,
  out risk_per_holding numeric,
  out max_open_risk numeric,
  out max_quote_age interval,
  out max_atr_age interval,
  out high_volatility numeric,
  out max_position numeric,
  out max_holdings integer,
  out min_score integer
)
language sql
immutable
set search_path = ''
as $$
  select
    'paper-risk-v1',
    0.0025,              -- FEE_RATE, TradeTicket.tsx
    2.0,                 -- DEFAULT_ATR_STOP_MULTIPLIER, risk.ts
    0.02,                -- DEFAULT_RISK_PERCENT, risk.ts
    0.06,                -- MAX_PORTFOLIO_RISK_PERCENT, risk.ts
    interval '2 hours',  -- the fill trigger's quote age
    interval '48 hours', -- two daily market-analytics runs, so one missed run still sizes
    0.04,                -- REGIME_HIGH_VOLATILITY (ATR / price), canonicalModel.ts
    case risk_profile when 'conservative' then 0.10 when 'moderate' then 0.25 when 'aggressive' then 0.50 end,
    case risk_profile when 'conservative' then 8 when 'moderate' then 5 when 'aggressive' then 3 end,
    -- 60 is the model's own BUY band (pine HUD: score >= 60 reads BUY).
    case risk_profile when 'conservative' then 60 when 'moderate' then 60 when 'aggressive' then 71 end
$$;

-- Stop risk_per_holding sizes against: stop_atr_multiple ATRs under the entry,
-- floored at 0. No ATR reading means no stop, so the whole entry is at risk.
create or replace function public.paper_planned_stop(entry numeric, atr numeric)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when atr > 0 then greatest(0, entry - (select p.stop_atr_multiple from public.paper_risk_policy() p) * atr)
    else 0
  end
$$;

-- ===== Server ATR =====
-- Written daily by market-analytics with the canonical engine's Wilder ATR(14).
alter table public.assets_status add column if not exists atr_14 numeric;

-- ===== Proposal receipts =====
-- One row per executed proposal, keyed by the client's request ID: a retry
-- after a lost response finds it and gets the original receipt back.
create table if not exists public.paper_order_batches (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  risk_profile text not null,
  policy_version text not null,
  budget numeric not null check (budget > 0),
  receipt jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.paper_order_batches enable row level security;
revoke all on table public.paper_order_batches from anon, authenticated;
grant select on table public.paper_order_batches to authenticated;

create policy "Users can read their own paper order batches"
  on public.paper_order_batches for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Clients still insert only (action, ticker, quantity, price, fees): these
-- columns are written by the RPCs alone, so the audit trail can't be forged.
alter table public.paper_transactions
  add column if not exists batch_id uuid references public.paper_order_batches (id) on delete cascade,
  add column if not exists stop_price numeric,
  add column if not exists atr numeric;

create index if not exists paper_transactions_batch_id_idx
  on public.paper_transactions (batch_id)
  where batch_id is not null;

-- ===== Account book =====
-- Paper Cash, equity and Aggregate Open Risk since the last RESET. Positions
-- mark at the latest server price (else their entry) and are stopped at
-- paper_planned_stop() of their entry: the same assumption usePaperRisk makes.
-- ponytail: entry is the average cost of the buys since the position was last
-- flat; the client's FIFO lots can differ after partial sells, which only moves
-- the risk of a position with no ATR reading.
create or replace function public.paper_account_book(
  account uuid,
  out cash numeric,
  out equity numeric,
  out open_risk numeric
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
    select p.shares, coalesce(p.entry, q.current_price) as entry, q.current_price as mark, q.atr
    from positions p
    cross join public.paper_risk_policy() policy
    left join lateral (
      select
        a.current_price,
        case
          when a.analytics_updated_at > clock_timestamp() - policy.max_atr_age then a.atr_14
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
    )
  from balance b
$$;

-- ===== Fill trigger: adds the open-risk cap to every BUY =====
-- Same checks as 20261022090000 otherwise; the stale-price message goes back to
-- naming a closed market, which 20261022090000 dropped by accident.
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
    if book.open_risk + added_risk > book.equity * policy.max_open_risk then
      raise exception 'Portfolio max risk reached: % open + % new would pass the % limit.',
        to_char(100 * book.open_risk / book.equity, 'FM990.0') || '%',
        to_char(100 * added_risk / book.equity, 'FM990.0') || '%',
        trim_scale(policy.max_open_risk * 100) || '%'
        using errcode = rejected;
    end if;
  end if;
  return new;
end;
$$;

-- ===== Tactical signals record the alert's stop as the fill's planned stop =====
-- Unchanged from 20261022090000 apart from stop_price, so the open-risk cap
-- sees the stop ActionCenter showed (its client check uses signal.stop_loss).
create or replace function public.execute_tactical_signal(
  signal_id uuid,
  user_id uuid,
  execution_price numeric
)
returns public.paper_transactions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  tactical_signal public.trading_signals%rowtype;
  canonical_ticker text;
  server_price numeric;
  quote_time timestamptz;
  inserted public.paper_transactions%rowtype;
begin
  if (select auth.uid()) is null or (select auth.uid()) <> $2 then
    raise exception 'Not authorized to execute this signal' using errcode = '42501';
  end if;
  if execution_price is null or execution_price <= 0 then
    raise exception 'Execution price must be greater than zero' using errcode = '22003';
  end if;

  select s.*
  into tactical_signal
  from public.trading_signals s
  where s.id = $1 and s.user_id = $2
  for update;

  if not found then
    raise exception 'Signal not found' using errcode = 'P0002';
  end if;
  -- PENDING is the existing database value for a signal waiting for action.
  if tactical_signal.status <> 'PENDING' then
    raise exception 'Signal is no longer waiting' using errcode = 'check_violation';
  end if;

  select upper(a.ticker), a.current_price, a.updated_at
  into canonical_ticker, server_price, quote_time
  from public.assets_status a
  where a.current_price > 0
    and (
      regexp_replace(upper(a.ticker), '[^A-Z0-9]', '', 'g') =
        regexp_replace(upper(tactical_signal.ticker), '[^A-Z0-9]', '', 'g')
      or regexp_replace(
        regexp_replace(upper(tactical_signal.ticker), '[^A-Z0-9]', '', 'g'),
        'USDT$',
        'USD'
      ) = regexp_replace(upper(a.ticker), '[^A-Z0-9]', '', 'g')
    )
  order by
    (upper(a.ticker) = upper(tactical_signal.ticker)) desc,
    a.updated_at desc
  limit 1;

  if server_price is null then
    raise exception '% has no server price, so Paper Trading can''t fill it', tactical_signal.ticker
      using errcode = 'check_violation';
  end if;
  if quote_time is null or quote_time < clock_timestamp() - interval '2 hours' then
    raise exception '%''s server price is over 2 hours old: its market is closed or the price feed is behind.',
      canonical_ticker using errcode = 'check_violation';
  end if;
  if abs(execution_price - server_price) > server_price * 0.005 then
    raise exception '% has moved more than 0.5%% from its server price. Try again after the next price refresh.',
      canonical_ticker using errcode = 'check_violation';
  end if;

  insert into public.paper_transactions (
    user_id,
    action,
    ticker,
    quantity,
    price,
    fees,
    signal_id,
    stop_price
  ) values (
    $2,
    tactical_signal.action,
    canonical_ticker,
    tactical_signal.quantity,
    execution_price,
    tactical_signal.quantity * execution_price * 0.0025,
    $1,
    case when tactical_signal.action = 'BUY' then tactical_signal.stop_loss end
  )
  returning * into inserted;

  update public.trading_signals s
  set status = 'EXECUTED'
  where s.id = $1;

  return inserted;
end;
$$;

-- ===== Portfolio-builder execution =====
-- holdings: [{ "ticker", "amount" (dollars incl. fees), "score" (Signal Score) }].
-- The server picks each price (the latest assets_status quote) and quantity
-- (floored to 1e-8 under the allocation, the remaining budget and the ATR risk
-- cap). One failed check raises and the whole proposal books nothing.
-- dry_run returns the plan without writing; for a request ID that already
-- executed it returns the stored receipt, which is how a client reconciles a
-- response it never received. The Signal Score is the client engine's:
-- the server can't recompute it, so that one check is attested, not verified.
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
  if book.open_risk + planned_risk > (book.equity - fees) * policy.max_open_risk then
    raise exception 'Portfolio max risk reached: % open + % new would pass the % limit. Lower the amount.',
      to_char(100 * book.open_risk / book.equity, 'FM990.0') || '%',
      to_char(100 * planned_risk / book.equity, 'FM990.0') || '%',
      trim_scale(policy.max_open_risk * 100) || '%'
      using errcode = rejected;
  end if;

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

-- Supabase grants EXECUTE on new functions to anon as well as PUBLIC.
revoke all on function public.paper_risk_policy(text) from public, anon;
revoke all on function public.paper_planned_stop(numeric, numeric) from public, anon;
revoke all on function public.paper_account_book(uuid) from public, anon;
revoke all on function public.execute_paper_portfolio(uuid, text, numeric, jsonb, boolean) from public, anon;
-- The fill trigger runs as the inserting user, so it needs the helpers.
-- paper_account_book is SECURITY INVOKER: RLS limits it to the caller's own rows.
grant execute on function public.paper_risk_policy(text) to authenticated, service_role;
grant execute on function public.paper_planned_stop(numeric, numeric) to authenticated, service_role;
grant execute on function public.paper_account_book(uuid) to authenticated, service_role;
grant execute on function public.execute_paper_portfolio(uuid, text, numeric, jsonb, boolean) to authenticated;
