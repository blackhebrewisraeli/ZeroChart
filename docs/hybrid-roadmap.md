# ZeroChart — Hybrid Roadmap (Milestone 1 & 2)

**Inputs:** `docs/engineering-audit.md` (findings F-*), `docs/hybrid-architecture.md` (blockers B*).
**Ground rules for both milestones:** no fabricated market data; deterministic engines only; every task lands behind existing CI gates (`npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build`); small, reviewable PRs; no dependency installs without explicit approval.

## Milestone 1 — P0/P1 Reliability & Security Fixes

Ordering respects dependencies: schema/identity foundations first (M1-1…M1-5), then financial-logic fixes that tests will re-baseline (M1-6…M1-10), then data-honesty (M1-11…M1-13).

| # | Task | Findings | Scope (files) | Acceptance / Tests | Depends on |
| --- | --- | --- | --- | --- | --- |
| M1-1 | **Audit remote schema & RLS** (evidence gathering, no code): `supabase db dump`, export policies for `user_portfolios`, `user_alerts`, `assets_status`; diff vs repo scripts | F-3.1a, F-4.2d, F-3.2a | remote only | Dump + policy inventory committed to `docs/` (secrets redacted); drift documented; ingestion job identified | — |
| M1-2 | **Reconcile migrations with live schema**: authoritative `drizzle/schema.ts`; corrected baseline migration (`ticker`, all 14 columns); supersede 0000/0001; CI drift check | F-3.1a, F-3.1b | `drizzle/**`, `drizzle.config.ts`, `.github/workflows/ci.yml` | Fresh-DB migration → `fetchAssets` select succeeds (contract test); CI job runs `drizzle-kit check` | M1-1 |
| M1-3 | **Type all Supabase tables + consolidate clients** to one canonical module; env-only config | F-3.1b, F-4.2a, F-4.2b | `src/lib/supabase*.ts`, `src/integrations/supabase/*`, `assets.ts`, `auth-attacher.ts` | No GoTrueClient warning in test output; ≤2 `createClient(` sites; no `sb_publishable_` literal in `src/**`; CI build passes | — |
| M1-4 | **Per-user local state + logout hygiene**: user-scoped storage key, clear on `SIGNED_OUT`, distinguish `null` vs `[]` cloud row | F-4.1a | `portfolioStore.tsx`, `authStore.tsx` | Integration test: A→logout→B sees no A data; localStorage key includes `user.id` (guest key unchanged) | — |
| M1-5 | **Hydration barrier**: expose `hydrating` from auth store; gate Save-to-Cloud (and any write) until complete | F-4.1b | `authStore.tsx`, `PortfolioDashboard.tsx` | Slow-load test: save blocked pre-hydration; save after hydration writes correct user's row | M1-4 |
| M1-6 | **Position-sizing budget cap**: `recommendPositionSize` takes allocation budget; notional ≤ allocation; Robo passes `allocatedAmount`; display notional; add non-guarantee disclosure | F-1.2a, F-1.2b, F-1.2c | `risk.ts`, `roboAdvisor.ts`, `RoboAdvisor.tsx`, tests | Invariant tests across ATR/price grid; stop ≥ 0; re-baselined `roboAdvisor*.test.tsx` | M1-7 (scoring output feeds Robo) |
| M1-7 | **Scoring unification**: single scoring service + one missing-data policy (`null` = no signal); Scanner/Portfolio/Robo consume it | F-1.1a, F-1.1b | `assets.ts`, `multiFactor.ts`, `portfolioManager.ts`, `index.tsx`, `PortfolioDashboard.tsx`, `roboAdvisor.ts` | Cross-surface parity test; asset with null risk/reward ⇒ **no** SELL suggestion; thresholds re-baselined | — |
| M1-8 | **State-driven cash balance**: `cashBalance` in portfolio state (seeded), persisted, consumed by suggestions + header; remove `AVAILABLE_CASH` | F-1.3a | `portfolioStore.tsx`, `PortfolioDashboard.tsx`, `portfolioManager.ts`, `db.ts` payload | Suggestions gated by real cash; cash round-trips through cloud save; 0-cash test | M1-4 (storage) |
| M1-9 | **Backtest integrity**: per-ticker coverage status (`covered/flat/failed`), warning banner for silent failures, suppress/label risk metrics on partial coverage, shared `costModel` (fee/slippage bps), rf param | F-2.1b, F-2.1c, F-2.1d | `backtestManager.ts`, `BacktestChart.tsx`, `risk.ts`, `TradeTicket.tsx` constants | Failed-fetch ticker surfaced; Sharpe labeled when coverage <100%; zero-cost output equals golden curve | — |
| M1-10 | **Alert pipeline consolidation**: one module, one evaluator on merged live prices, one notification channel; guest tier clearly session-only; deactivate with retry/`fired_at` suppression; per-class price TTL | F-5.1a, F-5.1b, F-5.1c, F-5.1d | `alertsStore.ts`, `priceAlerts.ts`, `usePriceAlerts.ts`, `useBinanceWebSocket.ts`, `SetAlertModal.tsx`, `PriceAlerts.tsx`, migration for `fired_at` | Exactly-once notification tests; refire-after-failed-deactivate test; stale-price suppression test | M1-1 (RLS/schema evidence), M1-2 |
| M1-11 | **Ticker classification single-source**: `classifyTicker()`; bare-crypto fix; WS/merge gated to crypto only | F-3.2d | `assets.ts`, `binance.ts`, `livePriceStore.ts`, `useBinanceWebSocket.ts` | Bare `BTC` → Crypto class; equities never WS-merged; collision case test | — |
| M1-12 | **Deterministic sparklines**: real candles where available, else deterministic change-derived path with label, else hidden; ban `Math.random` in `src/lib/**` (lint/grep gate) | F-3.3a | `assets.ts`, `Sparkline.tsx`, `index.tsx`, `PortfolioDashboard.tsx`, `eslint.config.js` | Determinism test; grep gate green; `assets.test.ts` re-baselined | M1-11 |
| M1-13 | **Per-asset freshness states** using `updated_at` + live overlay (`Live/Delayed/Stale/Unavailable/Simulated`) | F-3.2b, F-5.1d (partial) | `assets.ts`, Markets/Holdings rows, alerts evaluator | Classifier boundary tests; stale rows visibly badged; alerts respect TTL | M1-1 |
| M1-14 | **Copy & hygiene PRs**: rename "AI Robo-Advisor" (pending PO), README screenshots/license/CONNECTION.md column list | F-6.1c, F-0.1, F-0.2, F-0.3 | `README.md`, `docs/CONNECTION.md`, `LandingPage.tsx` | Docs gates; no broken `link-here` links | PO decision |

**M1 exit criteria:** all P0/P1 findings closed or explicitly waived with evidence; four CI gates green; remote schema/RLS evidence archived; 0 fabricated-data paths remain in `src/lib/**`.

## Milestone 2 — Hybrid Domain Architecture

Foundation first (schema/ports), then domain surfaces (Core Portfolio, then Lab). Each task is independently shippable behind flags.

| # | Task | Findings/Blockers | Scope | Acceptance / Tests | Depends on |
| --- | --- | --- | --- | --- | --- |
| M2-1 | **Domain tables + RLS**: `portfolios`, `positions`, `position_lots`, `transactions` with `portfolio_type`; pgTAP ownership tests | B1, F-4.2d | `drizzle/schema.ts`, new migration, `supabase/tests` | Cross-user access denied for all 4 ops; enum enforced | M1-1, M1-2 |
| M2-2 | **Cash ledger**: `portfolios.cash_balance` + `transactions.cash_delta`; wire buys/sells/contributions; remove remaining hardcoded cash | B2, F-1.3a | portfolio service, `PortfolioDashboard`, Robo invest | Ledger-sum invariant; suggestions use ledger | M1-8, M2-1 |
| M2-3 | **Lots & transactions service**: position CRUD emits transactions; cost-basis aggregation replaces single-lot math; zero-share edits rejected | B3, F-1.3c | `portfolioManager` → `portfolioService`, `AddPositionModal`, `HoldingRow` | Lot aggregation equals legacy math (golden tests); 0-share edit rejected | M2-1 |
| M2-4 | **Advisor split**: `driftRebalancer(targetWeights)` (Core) vs `signalAdvisor` (Lab); target-allocation editor | B4, F-1.1b | split `portfolioManager.ts`, new `src/lib/rebalance.ts` | Drift math tests (sum, bands); advisor uses unified scorer | M1-7 |
| M2-5 | **Strategy engine + persisted runs**: `Strategy` interface, `BuyAndHoldStrategy` baseline (golden-identical to today), next-bar-open fills, cost model, `backtest_runs` table, coverage metadata | B5, F-2.1a/e/f | `backtestManager.ts`, new `src/lib/strategy.ts`, Lab UI | Buy&hold curve unchanged; look-ahead unit test; run round-trip | M1-9, M2-1 |
| M2-6 | **Active Paper Trading**: `paper_trades` + paper portfolio; `TradeTicket` fills paper ledger with fees | B6 | new `src/lib/paperTrading.ts`, `TradeTicket.tsx`, Lab UI | Fill/fee/cash invariants; RLS cross-user test; P&L from fills | M2-1, M2-2 |
| M2-7 | **Mode surfaces**: three-way switcher (Live Holdings / Simulation / Lab) replacing binary Segmented; stores keyed by `portfolio_type` | B1, F-1.3d | `PortfolioDashboard`, nav, stores | No cross-mode leakage; per-mode cash/suggestions/backtest isolation | M2-1…M2-4 |
| M2-8 | **Monthly Investment Planner**: `contribution_plans` persistence, planner UI (goals, horizon) on `projectWealth`, seeding target allocation for simulation | B8 | `dca.ts` reuse, planner component | Plan CRUD + RLS tests; projection matches `dca.test.ts`; plan → sim seeding | M2-1, M2-2 |
| M2-9 | **JSONB backfill & dual-read** per `hybrid-architecture.md` §3.3 (steps 3–5), feature-flagged, then cut-over | §3.3 | backfill script (server), `db.ts` adapter, flags | Idempotent backfill; dual-read parity diff = 0; rollback drill | M2-1…M2-3 |
| M2-10 | **Walk-forward / OOS evaluation** in Lab over `Strategy`, benchmarked vs buy&hold | Lab vision | backtest extensions, Lab UI | Window boundary tests; baseline comparison report | M2-5 |
| M2-11 | **AI explanation layer (PO-gated)**: LLM summaries of *engine outputs only*, citing inputs; never writes ledgers | Vision principle | new `src/lib/explain/*` server fns | Explanations reproduce input values; no AI writes to domain tables | M2-7 |

**M2 exit criteria:** three domains isolated at DB + store + UI levels; JSONB legacy read-only; strategy backtests reproducible and persisted; paper-trading ledger balanced; Monthly Planner live on `contribution_plans`.

## Open Questions & Risks Requiring Human Decision

1. **Remote schema & RLS truth (blocks M1-1):** repo scripts vs live DB unverified — needs `supabase db dump` + policy export. If RLS is missing on `user_portfolios`/`user_alerts`, that is an active P0 exposure to remediate first. *(Missing evidence: remote state.)*
2. **`assets_status` ingestion ownership (blocks freshness SLOs):** who writes it, how often, with what failure alerting? No writer exists in the repo. *(Missing evidence: external job.)*
3. **Scoring unification target (M1-7):** promote multi-factor to canonical, or adapt the ratio model? Every BUY/SELL threshold and Robo ranking shifts — PO must accept ranking changes.
4. **Sparkline policy (M1-12):** buy real equity history (vendor cost ⇒ approval required), crypto-only sparklines, or deterministic derived paths with labels?
5. **"AI" branding (M1-14):** rename to "Quant/Multi-Factor" now, or reserve "AI" for the future explanation layer? (README/Landing copy + legal wording.)
6. **Backtest metrics on partial coverage (M1-9):** suppress Sharpe/MDD vs display with "partial data" label — analytic-honesty trade-off.
7. **Migration authority (M1-2):** adopt drizzle as long-term migration tool (recommended; enables CI drift check) or keep platform-managed schema?
8. **Guest alerts (M1-10):** allow session-only alerts for logged-out users, or require auth for all alerts?
9. **Fee/slippage defaults (M1-9):** what default cost model represents "typical" execution (0.25% network fee exists; slippage TBD).
10. **Backfill consent (M2-9):** auto-splitting existing mixed JSONB rows into `live_holdings` vs `simulation` portfolios may need a one-time user chooser.
11. **LICENSE (F-0.2):** none exists — legal decision before public/commercial distribution.
12. **Branch handling:** all work is docs-only on `chore/milestone-0-engineering-audit`; nothing pushed, `main` untouched — merge/PR timing is the owner's call.


