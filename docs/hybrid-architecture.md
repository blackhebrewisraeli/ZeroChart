# ZeroChart — Hybrid Architecture Gap Analysis

**Companion to:** `docs/engineering-audit.md` (Milestone 0) · **Status:** M2-T1 client domain bridge complete; normalized cloud tables pending

## 1. Target Architecture (restated)

Two product domains over one financial/technical substrate, governed by: _Deterministic Engines Calculate · AI Agents Research/Summarize/Explain · Humans Retain Control_ — and strict separation of **(1) Real-World Holdings Tracking**, **(2) Long-Term Portfolio Simulation** (incl. the upcoming Monthly Investment Planner), **(3) Active Paper Trading & Strategy Backtesting**.

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

| Module                                                                                                          | What it gives both domains                                             | Reuse notes                                                                          |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `src/lib/indicators.ts` + `financeCompute.ts` + `financeClient.ts` + `finance.worker.ts`                        | SMA/RSI/MACD/ATR, cached worker execution                              | Fully reusable as-is; extend request union for new metrics                           |
| `src/lib/multiFactor.ts`                                                                                        | Deterministic 0–100 scoring with weight redistribution on missing data | Reuse for Scanner _and_ Robo once F-1.1 unification lands                            |
| `src/lib/risk.ts`                                                                                               | `maxDrawdown`, `sharpeRatio`, ATR position sizing                      | Reusable after F-1.2 budget-cap fix; add rf/cost params                              |
| `src/lib/backtestManager.ts`                                                                                    | Weight math, forward-fill timeline, equity metrics                     | Core of Lab backtesting; needs Strategy layer (M2)                                   |
| `src/lib/dca.ts`                                                                                                | `projectWealth` + `ANNUAL_RETURN_BY_RISK`                              | Direct primitive for the **Monthly Investment Planner**                              |
| `src/lib/allocation.ts`                                                                                         | `computeAllocation` donut model                                        | Reusable for drift/target-allocation views in Core Portfolio                         |
| `src/lib/portfolioManager.ts`                                                                                   | Stats/suggestions/share text                                           | Split into `portfolioService` (stats) + strategy hints (Lab-only)                    |
| `src/lib/roboAdvisor.ts`                                                                                        | `QuantDeps` dependency-injection pattern                               | Model for testable service boundaries                                                |
| `src/lib/livePriceStore.ts` + `useBinanceWebSocket.ts` + `binance.ts`                                           | Batched live prices, symbol mapping, REST candles                      | Shared market-data layer; gate by `classifyTicker` (F-3.2d)                          |
| `src/lib/{alertsStore,priceAlerts}` + hooks                                                                     | Alert model + evaluation predicates (`hasCrossed`/`hasTriggered`)      | Consolidate to one pipeline (F-5.1a) before M2                                       |
| UI: `Sparkline`, `LightweightChart`, `AllocationChart`, `BacktestChart`, `Segmented`, `TradeTicket`, Robo modal | Charting/interaction vocabulary                                        | `BacktestChart` becomes Lab surface; `TradeTicket` evolves into Paper Trading ticket |
| Supabase RLS scripts + `client.server.ts`                                                                       | Ownership policy patterns, server-admin client                         | Template for all new domain tables; verify remote (F-4.2d)                           |
| Test harness                                                                                                    | 19 files / 112 tests, pure-function orientation                        | Extend; keep engines pure & DI-friendly                                              |

## 3. JSONB Position Storage vs. Normalized Domain Model

### 3.1 Current state after M2-T1

Cloud compatibility remains one row per user in `user_portfolios(user_id UNIQUE, positions jsonb)` for the Core ledgers. The JSONB value may be either a legacy `Position[]` or the v3 snapshot envelope `{ version: 3, activePortfolioType, portfolios }`; `db.ts` preserves the legacy array API and adds explicit v3 save/load helpers.

Paper Trading has left the snapshot: every fill, top-up and reset is an append-only `paper_transactions` row (RLS: read/insert own rows; no update/delete). A `BEFORE INSERT` trigger replays the account's cash and open shares since its last `RESET` under a per-user advisory lock and rejects fills it can't cover, or whose price is more than 5% from the scanner's `assets_status` quote (a missing quote, or one over 2 hours old, is rejected too). The client rebuilds the account with `replayPaperLedger` (FIFO lots, cash, realized P&L) on hydration and after each booking. Pro entitlement likewise lives server-side in `user_subscriptions`, readable by its owner and written only by the service role.

Locally, `portfolioStore.tsx` now owns three strictly isolated containers keyed by `real_tracking`, `long_term_sim`, and `paper_trading`. Each container has independent positions, cash, cash ledger, unified transactions, realized P&L, and optional target allocations. Bare v1 arrays and v2 cash-ledger payloads migrate deterministically on hydration; legacy UI consumers continue to receive the combined Core position view.

`portfolioAccounting.ts` is the pure financial boundary for lot normalization, multi-lot weighted-average basis, FIFO sells, fee/slippage-aware realized P&L, and missing-price-honest valuation.

**What the JSONB bridge still cannot provide:**

| Requirement                                            | JSONB reality                                                                                        |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Multiple portfolio modes per user                      | Represented in v3, but still last-writer-wins as one JSONB snapshot                                  |
| Lots / avg cost basis / transaction history (F-1.3c)   | Represented and calculated client-side, but not independently queryable or append-only in PostgreSQL |
| Cash ledger & contribution plans (Monthly Planner)     | Per-container cash is represented; durable contribution plans still need normalized storage          |
| Portfolio metadata/type (`PortfolioType`)              | Represented in v3; database constraints cannot enforce the JSONB discriminator                       |
| Strategies / BacktestRun / PaperTrade persistence      | No tables; runs are ephemeral client state                                                           |
| Server-side drift analysis, goal progress, audit trail | Cannot query JSONB at scale; last-writer-wins race (F-4.1b)                                          |
| Referential integrity vs `assets_status`               | Free-text `ticker`, no FK                                                                            |

### 3.2 Recommended target schema (relational, RLS on every table)

```
portfolios(id uuid pk, user_id uuid -> auth.users, name text,
           portfolio_type text check in ('real_tracking','long_term_sim','paper_trading'),
           base_currency text default 'USD', cash_balance numeric,
           created_at, updated_at)
positions(id, portfolio_id -> portfolios on delete cascade,
          ticker text not null, asset_class text, target_weight numeric null)
position_lots(id, position_id -> positions cascade,
              quantity numeric check(quantity>0), cost_price numeric,
              fees numeric, traded_at timestamptz, source text)
portfolio_transactions(id, position_id, portfolio_id, type check in
                       ('buy','sell','dividend','fee','deposit','withdrawal','contribution'),
                       quantity, price, fees, slippage, realized_pnl,
                       cash_delta numeric, executed_at)
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

1. ✅ **Freeze/bridge contract (M2-T1):** preserve legacy `Position`/`portfolioStore` APIs while adding isolated v3 containers and v1/v2 migration.
2. **Create new tables + RLS** (additive; nothing reads them yet) → verify with pgTAP/Supabase CLI tests (closes F-4.2d verification gap).
3. **Backfill:** one-off service-role script reads each legacy/v3 `user_portfolios.positions` JSONB → emits typed `portfolios` + `positions` + synthetic opening `position_lots` (`traded_at = dateAdded`, `source='backfill'`). Idempotent via `(user_id, backfill_version)`.
4. **Dual-read:** app reads new tables; falls back to JSONB when absent (per-user feature flag).
5. **Dual-write:** app writes both (JSONB as snapshot cache) with nightly diff; `db.ts` remains the JSONB adapter.
6. **Cut over:** JSONB becomes read-only legacy; remove adapter later; (the F-3.1 migration-tooling gap is closed: `user_portfolios`/`user_alerts` are in the `supabase/migrations` baseline).

**Rollback:** steps 1–5 are purely additive; disable the flag to return to JSONB (dual-write keeps data warm).

## 4. Separation Blockers for the Three Portfolio Modes

| #   | Blocker (evidence)                                                                                                                                                                                                   | Why it blocks                                                                                                 | Bridge task                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| B1  | **Single position array, one wallet:** `portfolioStore` mixes `isSimulation` rows (`portfolioStore.tsx:62`); mode toggle is a client filter (`PortfolioDashboard.tsx:345-347`); Save-to-Cloud persists both (`:396`) | Lab paper buys could surface in real holdings with one filter bug; no per-domain cash                         | `portfolios.portfolio_type`; stores keyed by `portfolio_id` (M2-1)              |
| B2  | **Hardcoded shared cash** `AVAILABLE_CASH = 2500` (`PortfolioDashboard.tsx:45`)                                                                                                                                      | Real contributions vs Lab paper cash must be independent ledgers                                              | `cash_balance` per portfolio + `transactions.cash_delta` (M2-2, fixes F-1.3a)   |
| B3  | **No transaction/lot layer** (F-1.3c)                                                                                                                                                                                | Live tracking needs lots/fees/dividends; simulation needs contributions; paper needs fills — all transactions | `position_lots` + `transactions` (M2-3)                                         |
| B4  | **Suggestions engine domain-agnostic** (`generateSuggestions` score thresholds, `portfolioManager.ts:85-128`) applied to whatever rows are visible                                                                   | Rebalancing-vs-target (Core) and signal trades (Lab) are different products sharing one function              | Split `driftRebalancer(targetWeights)` (Core) from `signalAdvisor` (Lab) (M2-4) |
| B5  | **Backtester bound to live positions** (`BacktestChart.tsx:26`)                                                                                                                                                      | Lab must backtest strategies/paper portfolios, not the user's real holdings                                   | `Strategy` + `BacktestRun`; engine takes `(weights                              | strategy, series)` (M2-5; fixes F-2.1a/e) |
| B6  | **No Paper Trading domain** — `TradeTicket` is a mock toast (`TradeTicket.tsx:80-87`)                                                                                                                                | Third mode has nowhere to record state                                                                        | `paper_trades` + wire TradeTicket into a paper portfolio (M2-6)                 |
| B7  | **Scoring split** (F-1.1a): Portfolio/Scanner `calculateSignalScore` vs Robo `calculateMultiFactorScore`                                                                                                             | Domain separation needs one canonical scoring contract so Core and Lab compare consistently                   | Unify scoring service in M1; both domains consume it (M2-7)                     |
| B8  | **Monthly Planner has no persistence** — `projectWealth` is pure math used only in the Robo modal (`RoboAdvisor.tsx:408-455`)                                                                                        | A recurring contribution plan is a durable Core-Portfolio entity                                              | `contribution_plans` + planner UI on `dca.ts` (M2-8)                            |

**Sequencing:** B7 (scoring) and B1/B2 (portfolio typing + cash) are foundations — strategy/paper features must not be built on the current single-array store.

## 5. M2-T1 Completion Checkpoint

- Pure accounting engine: `src/lib/portfolioAccounting.ts`.
- Store snapshot version: v3 with `real_tracking`, `long_term_sim`, and `paper_trading` containers.
- Fresh seeds: Core real tracking receives the demo holdings and $2,500 opening cash; long-term simulation starts empty; paper trading starts empty with $10,000 virtual cash.
- Migration: v1/v2 real and simulated positions are split, normalized into lots, and retained through scope changes; legacy cash remains with `real_tracking`.
- Persistence bridge: `savePortfolio`/`loadPortfolio` remain array-compatible; `savePortfolioStateV3`/`loadPortfolioState` support the complete envelope in the existing JSONB column.
- Remaining boundary: UI workspace separation and relational tables/RLS are subsequent tasks; M2-T1 does not wire `TradeTicket` or redesign portfolio screens.
