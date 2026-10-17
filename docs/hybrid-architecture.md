# ZeroChart — Hybrid Architecture Gap Analysis

**Companion to:** `docs/engineering-audit.md` (Milestone 0) · **Status:** for Product Owner review before Milestone 2

## 1. Target Architecture (restated)

Two product domains over one financial/technical substrate, governed by: *Deterministic Engines Calculate · AI Agents Research/Summarize/Explain · Humans Retain Control* — and strict separation of **(1) Real-World Holdings Tracking**, **(2) Long-Term Portfolio Simulation** (incl. the upcoming Monthly Investment Planner), **(3) Active Paper Trading & Strategy Backtesting**.

```
                ┌─────────────────────────────────────────────┐
   UI layer     │ Core Portfolio          │ Active Research Lab│
                │ (Holdings | Simulation) │ (Scan · Score ·     │
                │  + Monthly Planner      │  Backtest · Paper)  │
                ├─────────────────────────────────────────────┤
   Services     │ portfolioService · scoringService ·          │
                │ alertService · plannerService · strategySvc  │
                ├─────────────────────────────────────────────┤
   Engines      │ indicators · multiFactor · risk · backtest   │
   (pure)       │ dca/projectWealth · allocation · financeWorker│
                ├─────────────────────────────────────────────┤
   Data         │ assets_status (market ref) · prices (WS+REST)│
                │ portfolios/positions/lots/transactions/      │
                │ cashflows/contribution_plans/strategies/     │
                │ backtest_runs/paper_trades (domain, RLS)     │
                └─────────────────────────────────────────────┘
```

## 2. Reusable Infrastructure Inventory (keep & build on)

| Module | What it gives both domains | Reuse notes |
| --- | --- | --- |
| `src/lib/indicators.ts` + `financeCompute.ts` + `financeClient.ts` + `finance.worker.ts` | SMA/RSI/MACD/ATR, cached worker execution | Fully reusable as-is; extend request union for new metrics |
| `src/lib/multiFactor.ts` | Deterministic 0–100 scoring with weight redistribution on missing data | Reuse for Scanner *and* Robo once F-1.1 unification lands |
| `src/lib/risk.ts` | `maxDrawdown`, `sharpeRatio`, ATR position sizing | Reusable after F-1.2 budget-cap fix; add rf/cost params |
| `src/lib/backtestManager.ts` | Weight math, forward-fill timeline, equity metrics | Core of Lab backtesting; needs Strategy layer (M2) |
| `src/lib/dca.ts` | `projectWealth` + `ANNUAL_RETURN_BY_RISK` | Direct primitive for the **Monthly Investment Planner** |
| `src/lib/allocation.ts` | `computeAllocation` donut model | Reusable for drift/target-allocation views in Core Portfolio |
| `src/lib/portfolioManager.ts` | Stats/suggestions/share text | Split into `portfolioService` (stats) + strategy hints (Lab-only) |
| `src/lib/roboAdvisor.ts` | `QuantDeps` dependency-injection pattern | Model for testable service boundaries |
| `src/lib/livePriceStore.ts` + `useBinanceWebSocket.ts` + `binance.ts` | Batched live prices, symbol mapping, REST candles | Shared market-data layer; gate by `classifyTicker` (F-3.2d) |
| `src/lib/{alertsStore,priceAlerts}` + hooks | Alert model + evaluation predicates (`hasCrossed`/`hasTriggered`) | Consolidate to one pipeline (F-5.1a) before M2 |
| UI: `Sparkline`, `LightweightChart`, `AllocationChart`, `BacktestChart`, `Segmented`, `TradeTicket`, Robo modal | Charting/interaction vocabulary | `BacktestChart` becomes Lab surface; `TradeTicket` evolves into Paper Trading ticket |
| Supabase RLS scripts + `client.server.ts` | Ownership policy patterns, server-admin client | Template for all new domain tables; verify remote (F-4.2d) |
| Test harness | 19 files / 112 tests, pure-function orientation | Extend; keep engines pure & DI-friendly |

## 3. JSONB Position Storage vs. Normalized Domain Model

### 3.1 Current state

One row per user: `user_portfolios(user_id UNIQUE, positions jsonb[])` (`supabase_schema.sql:13-20`), written whole-array via upsert (`db.ts:8-17`). Elements: `{id, ticker, buyPrice, shares, isSimulation, dateAdded}` (`portfolioManager.ts:3-10`).

**Works today:** simple reads/writes; trivially RLS-ownable (row = owner); zero migration cost; offline-friendly.

**Why it blocks the Hybrid Architecture:**

| Requirement | JSONB reality |
| --- | --- |
| Multiple portfolios per user (live, N simulations, paper ledger) | Impossible: exactly one array per user |
| Lots / avg cost basis / transaction history (F-1.3c) | Not modelable; only latest flattened row survives |
| Cash ledger & contribution plans (Monthly Planner) | No place for cash flows — `AVAILABLE_CASH` stayed hardcoded (F-1.3a) as a symptom |
| Portfolio metadata/type (`PortfolioType`) | Only in-row boolean `isSimulation` |
| Strategies / BacktestRun / PaperTrade persistence | No tables; runs are ephemeral client state |
| Server-side drift analysis, goal progress, audit trail | Cannot query JSONB at scale; last-writer-wins race (F-4.1b) |
| Referential integrity vs `assets_status` | Free-text `ticker`, no FK |

### 3.2 Recommended target schema (relational, RLS on every table)

```
portfolios(id uuid pk, user_id uuid -> auth.users, name text,
           portfolio_type text check in ('live_holdings','simulation','paper_lab'),
           base_currency text default 'USD', cash_balance numeric,
           created_at, updated_at)
positions(id, portfolio_id -> portfolios on delete cascade,
          ticker text not null, asset_class text, target_weight numeric null)
position_lots(id, position_id -> positions cascade,
              quantity numeric check(quantity>0), cost_price numeric,
              fees numeric, traded_at timestamptz, source text)
transactions(id, position_id, portfolio_id, type check in
             ('buy','sell','dividend','fee','deposit','withdrawal','contribution'),
             quantity, price, fees, cash_delta numeric, executed_at)
contribution_plans(id, portfolio_id, monthly_amount numeric,
                   day_of_month int, start_date, assumed_return numeric,
                   auto_invest bool)
strategies(id, user_id, name, kind check in ('buyhold','multifactor','custom'),
           params jsonb, created_at)
backtest_runs(id, user_id, strategy_id, params jsonb, coverage jsonb,
              metrics jsonb, status, created_at)
paper_trades(id, user_id, strategy_id null, ticker, side, quantity,
             price, fees, status check in ('open','filled','closed'),
             opened_at, closed_at)
```
Plus indexes `(portfolio_id, ticker)`, `(user_id, portfolio_type)`; **RLS owner policies copied from the `supabase_schema.sql` pattern** on every table; `assets_status` stays the shared public market reference (read-only to clients).

### 3.3 Safe incremental migration path (no flag-day)

1. **Freeze contract:** keep `Position`/`portfolioStore` API untouched while new tables land behind it.
2. **Create new tables + RLS** (additive; nothing reads them yet) → verify with pgTAP/Supabase CLI tests (closes F-4.2d verification gap).
3. **Backfill:** one-off service-role script reads each `user_portfolios.positions` JSONB → emits `portfolios('live_holdings'|'simulation')` + `positions` + synthetic opening `position_lots` (`traded_at = dateAdded`, `source='backfill'`). Idempotent via `(user_id, backfill_version)`.
4. **Dual-read:** app reads new tables; falls back to JSONB when absent (per-user feature flag).
5. **Dual-write:** app writes both (JSONB as snapshot cache) with nightly diff; `db.ts` remains the JSONB adapter.
6. **Cut over:** JSONB becomes read-only legacy; remove adapter later; pull `user_portfolios`/`user_alerts` ad-hoc SQL into drizzle history in the same window (closes the F-3.1 migration-tooling gap).

**Rollback:** steps 1–5 are purely additive; disable the flag to return to JSONB (dual-write keeps data warm).

## 4. Separation Blockers for the Three Portfolio Modes

| # | Blocker (evidence) | Why it blocks | Bridge task |
| --- | --- | --- | --- |
| B1 | **Single position array, one wallet:** `portfolioStore` mixes `isSimulation` rows (`portfolioStore.tsx:62`); mode toggle is a client filter (`PortfolioDashboard.tsx:345-347`); Save-to-Cloud persists both (`:396`) | Lab paper buys could surface in real holdings with one filter bug; no per-domain cash | `portfolios.portfolio_type`; stores keyed by `portfolio_id` (M2-1) |
| B2 | **Hardcoded shared cash** `AVAILABLE_CASH = 2500` (`PortfolioDashboard.tsx:45`) | Real contributions vs Lab paper cash must be independent ledgers | `cash_balance` per portfolio + `transactions.cash_delta` (M2-2, fixes F-1.3a) |
| B3 | **No transaction/lot layer** (F-1.3c) | Live tracking needs lots/fees/dividends; simulation needs contributions; paper needs fills — all transactions | `position_lots` + `transactions` (M2-3) |
| B4 | **Suggestions engine domain-agnostic** (`generateSuggestions` score thresholds, `portfolioManager.ts:85-128`) applied to whatever rows are visible | Rebalancing-vs-target (Core) and signal trades (Lab) are different products sharing one function | Split `driftRebalancer(targetWeights)` (Core) from `signalAdvisor` (Lab) (M2-4) |
| B5 | **Backtester bound to live positions** (`BacktestChart.tsx:26`) | Lab must backtest strategies/paper portfolios, not the user's real holdings | `Strategy` + `BacktestRun`; engine takes `(weights | strategy, series)` (M2-5; fixes F-2.1a/e) |
| B6 | **No Paper Trading domain** — `TradeTicket` is a mock toast (`TradeTicket.tsx:80-87`) | Third mode has nowhere to record state | `paper_trades` + wire TradeTicket into a paper portfolio (M2-6) |
| B7 | **Scoring split** (F-1.1a): Portfolio/Scanner `calculateSignalScore` vs Robo `calculateMultiFactorScore` | Domain separation needs one canonical scoring contract so Core and Lab compare consistently | Unify scoring service in M1; both domains consume it (M2-7) |
| B8 | **Monthly Planner has no persistence** — `projectWealth` is pure math used only in the Robo modal (`RoboAdvisor.tsx:408-455`) | A recurring contribution plan is a durable Core-Portfolio entity | `contribution_plans` + planner UI on `dca.ts` (M2-8) |

**Sequencing:** B7 (scoring) and B1/B2 (portfolio typing + cash) are foundations — strategy/paper features must not be built on the current single-array store.


