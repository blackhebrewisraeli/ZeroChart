# ZeroChart — Milestone 0: Engineering Audit (Current-State Verification)

**Branch:** `chore/milestone-0-engineering-audit` · **Base commit:** `255ae02` (main, 2026-10-16) · **Mode:** Read-only code audit (no `src/**`, test, config, or migration changes; docs only)

> Classification key: **Status** = `Confirmed` | `Partially Resolved` | `Already Fixed` | `Not Reproducible` | `Requires Further Investigation`.
> **Severity** = `P0` critical security / data isolation / schema-breaking / severe financial error · `P1` core usability / market-data integrity / financial reliability · `P2` product quality / UX transparency / tech debt · `P3` future enhancement / commercial readiness.

---

## 1. Baseline Health (Phase 0)

### 1.1 Commands executed and exact results

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | ✅ exit code **0** — no type errors (repo has no `typecheck` script; CI runs the same `npx tsc --noEmit`) |
| `npx eslint .` (= `npm run lint`) | ✅ exit code **0** — no warnings or errors |
| `npx vitest run` (= `npm test`) | ✅ **19 test files passed, 112/112 tests passed**, 2.26s. One stderr warning: `GoTrueClient … Multiple GoTrueClient instances detected in the same browser context` (from `src/test/app-routing.test.tsx`) → see finding **F-4.2a** |
| `npm run build` | ✅ exit code **0** — Vite build + Nitro output (`✓ built in 328ms`, `.output/` generated, `npx nitro deploy --prebuilt` available) |

CI (`.github/workflows/ci.yml`) runs the same four gates (typecheck → build → lint → test) on push/PR to `main`, with dummy `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` env placeholders — no real credentials in CI.

### 1.2 Project map

- **Framework:** TanStack Start (SSR) + React 19 + TypeScript 5.8 (`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`), Vite 8, Tailwind 4, Vitest 4. Both `bun.lock` and `package-lock.json` present (CI uses `npm ci`).
- **State:** React context stores (`src/lib/portfolioStore.tsx`, `src/lib/authStore.tsx`) + module-level external stores via `useSyncExternalStore` (`src/lib/livePriceStore.ts`, `src/lib/alertsStore.ts`) + React Query for `assets_status` (`src/routes/index.tsx:252-257`, 60s refetch, retry 1).
- **Finance core (pure, tested):** `src/lib/{risk,backtestManager,multiFactor,indicators,financeCompute,allocation,dca,portfolioManager,roboAdvisor}.ts` with a Web Worker bridge (`financeClient.ts` / `finance.worker.ts`).
- **DB:** Supabase Postgres. Drizzle migrations in `drizzle/migrations/` (hand-written; `drizzle/schema.ts` is intentionally blank), ad-hoc SQL scripts `supabase_schema.sql` + `supabase_alerts_schema.sql` at repo root, generated client types in `src/integrations/supabase/types.ts`.

### 1.3 `docs/` inventory & repo hygiene

Existing: `docs/AGENTS.md` (Lovable connection rules + architecture notes), `docs/CONNECTION.md` (assets_status contract), `docs/roadmap.md` (3 checked items). **No duplicates** — `engineering-audit.md`, `hybrid-architecture.md`, `hybrid-roadmap.md` are new files.

- ❌ **F-0.1** `README.md` contains 3 broken image placeholders `![…](link-here)` at **lines 18, 43, 44** — `Status: Confirmed`, `Severity: P3`. **Fix:** attach real screenshots or remove. **Risk:** none. **Tests:** n/a (docs).
- ❌ **F-0.2** No `LICENSE` file at repo root — `Status: Confirmed`, `Severity: P3` (commercial-readiness/legal clarity). **Fix:** Product Owner chooses license (MIT/Apache-2.0/proprietary).
- ❌ **F-0.3** `docs/CONNECTION.md:22` required-column list is missing `change_24h` (added by `drizzle/migrations/0001_add_change_24h.sql`) — `Confirmed`, `P3`. **Fix:** update doc; keep column contract in one authoritative place.


---

## 2. Verified Findings Register (Phases 1–6)

| ID | Finding | Status | Sev |
| --- | --- | --- | --- |
| F-1.1a | Two divergent scoring models consumed by different views | **Partially Fixed (M1-T2)**¹ | P1 |
| F-1.1b | Missing `risk_pct`/`reward_pct` ⇒ guaranteed SELL suggestion | **Fixed (M1-T2)** | P1 |
| F-1.2a | ATR suggested-size notional can exceed allocated capital / total capital | **Fixed (M1-T2)** | P0 |
| F-1.2b | `stopPrice` not floored at 0 when ATR ≥ price | **Fixed (M1-T2)** | P2 |
| F-1.2c | "Guaranteed max loss" UI claim | Not Reproducible (no such copy found) | — |
| F-1.3a | Hardcoded `AVAILABLE_CASH = 2500` drives suggestions + UI | Confirmed | P1 |
| F-1.3b | Missing live price silently valued at buy price (no staleness cue) | Confirmed | P2 |
| F-1.3c | No lot/transaction model; edit permits 0-share rows | Confirmed | P2 |
| F-1.3d | Sim-vs-live flag exists but one shared storage/cash/suggestions blob | Partially Resolved | P1 |
| F-2.1a | Backtester = static-weight buy&hold replay, no strategy signals | Confirmed | P1 |
| F-2.1b | Non-crypto **and silently failed** fetches held flat ⇒ Sharpe/MDD distortion | Confirmed | P1 |
| F-2.1c | No fees/slippage/transaction costs in backtest | Confirmed | P1 |
| F-2.1d | Risk-free rate fixed at 0 (disclosed in UI) | Confirmed | P2 |
| F-2.1e | Weights from *today's* portfolio applied retroactively (retrodictive) | Confirmed | P2 |
| F-2.1f | Look-ahead risk when strategy signals arrive (same-bar close) | Requires Further Investigation (future) | P2 |
| F-3.1a | Drizzle migrations drift: `symbol` vs `ticker`, 5 missing columns | **Fixed (M1-T1)** | P0 |
| F-3.1b | Generated types cover only `assets_status`; portfolio/alert tables untyped | **Fixed (M1-T1)** | P2 |
| F-3.2a | No `assets_status` ingestion in repo; external writer unverifiable | Requires Further Investigation | P1 |
| F-3.2b | No per-asset freshness states (Live/Delayed/Stale/Unavailable/Simulated) | Confirmed | P1 |
| F-3.2c | Global stale-snapshot banner + sample labeling **do exist** | Already Fixed | — |
| F-3.2d | Symbol-handling inconsistencies (bare-crypto class, ungated merge) | Confirmed | P2 |
| F-3.3a | `generateTrendData()` uses `Math.random()` for displayed price history | **Fixed (M1-T2)** | P1 |
| F-4.1a | Positions survive logout / leak to next account on shared device | **Fixed (M1-T1)** | P0 |
| F-4.1b | Hydration race: cloud load vs Save-to-Cloud can cross-write rows | **Fixed (M1-T1)** | P0 |
| F-4.2a | Three Supabase client modules; duplicate GoTrueClient instances | **Fixed (M1-T1)** | P2 |
| F-4.2b | Hardcoded URL + publishable key in `src/lib/supabase.ts` | **Fixed (M1-T1)** | P2 |
| F-4.2c | Service-role key server-only, not imported client-side | Already Fixed (verified) | — |
| F-4.2d | RLS: repo scripts complete; **remote enforcement unverified** | Requires Further Investigation | P0 |
| F-5.1a | Duplicate local vs cloud alert pipelines (dual UIs, dual firing) | Confirmed | P1 |
| F-5.1b | Local alerts are memory-only (lost on refresh); dead when WS down | Confirmed | P1 |
| F-5.1c | Cloud `deactivateAlert` failure ⇒ alert can refire after refetch | Confirmed | P2 |
| F-5.1d | Equity alerts evaluate against ≤60s-old DB prices | Confirmed | P2 |
| F-6.1a | Risk "profiling" = 3 static buttons, no questionnaire | Confirmed | P2 |
| F-6.1b | Diversification heuristic = holdings count only (8/5/3) | Confirmed | P2 |
| F-6.1c | "AI" terminology on marketing surfaces vs deterministic engine | Confirmed | P2 |
| F-6.1d | Hardcoded 5%/8%/12% return assumptions (disclosed as "assumed") | Confirmed | P3 |


### Phase 1.1 — Signal Scoring Unification

**F-1.1a — Two divergent scoring models shown as the same "Signal score" · Confirmed · P1**
- **Evidence:** `calculateSignalScore()` (`src/lib/assets.ts:132-153`, ratio model: `20·(reward/risk) + 20 + volume/SMA bonuses`) is consumed by Scanner/Hero (`src/routes/index.tsx:94,181,199,265`), Portfolio health & suggestions (`src/lib/portfolioManager.ts:67,98,114`), Holdings detail (`src/components/PortfolioDashboard.tsx:255,350`). `calculateMultiFactorScore()` (`src/lib/multiFactor.ts:101-120`, RSI 40% / momentum 40% / vol 20%) is consumed only by the Robo-Advisor (`src/lib/roboAdvisor.ts:123,158`).
- **Root cause:** Two models built for different surfaces, never unified. Units differ (unbounded reward/risk ratio vs. normalized 0–100 factor curves); missing-data semantics differ — ratio model floors at **20** (`assets.ts:141`), multi-factor returns **0** (`multiFactor.ts:118`). Same asset can read 85+ ("BUY opportunity") in Portfolio while Robo ranks it low (or excludes it), with no reconciliation.
- **Fix:** One scoring service (single function, documented contract) consumed by Scanner/Portfolio/Robo; keep model-specific sub-scores as labelled details; one missing-data policy (recommend `null` → "No signal", excluded from thresholds).
- **Regression risk:** BUY ≥85 / SELL <50 thresholds and Robo rankings shift → re-baseline `portfolioManager.test.ts` / `roboAdvisor.test.ts`. **Tests:** cross-surface parity (same asset ⇒ same score everywhere), missing-data contract test.

**F-1.1b — Assets missing `risk_pct`/`reward_pct` are always flagged SELL · Confirmed · P1**
- **Evidence:** `assets.ts:141` → ratio `0` ⇒ base 20; max with bonuses 20+15+10 = **45**. `portfolioManager.ts:99` flags `score < 50` as SELL ("Cut losses / take profit"). Any held asset lacking risk/reward data *cannot* reach 50 → permanent SELL suggestion regardless of trend.
- **Root cause:** Threshold logic treats "insufficient data" as "low-conviction sell" because the score floors at 20 instead of returning no-signal.
- **Fix:** Return `null` for insufficient data; skip suggestions for `null` (same policy as F-1.1a).
- **Regression risk:** low — existing suggestion tests use fully-populated assets. **Tests:** held asset with `risk_pct: null` produces no SELL; threshold boundary tests.

### Phase 1.2 — ATR Position Sizing (`risk.ts` & Robo-Advisor)

**F-1.2a — Suggested-size notional can exceed allocated capital (and total capital) · Confirmed · P0**
- **Evidence:** `recommendPositionSize()` (`src/lib/risk.ts:102-121`): `shares = (capital × 2%) / ATR` with **no cap against capital or per-asset allocation**; `notional = shares × price` (`risk.ts:119`). `notional = 0.02 × capital × price/ATR`, so any asset with `ATR/price < 2%` (typical ~1% ⇒ **notional = 2× capital**) exceeds capital. Robo amplifies: `roboAdvisor.ts:197-201` computes `allocatedAmount = capital × weight` but sizes with the **full** `capital` for **every** asset; UI shows "Suggested size" beside each allocation (`RoboAdvisor.tsx:492-500`, note `457-460`). Mitigating: `Confirm & Invest` executes `allocatedAmount / price` shares (`RoboAdvisor.tsx:210`), **not** the suggested shares — today the bad number is display-only.
- **Root cause:** Sizing model has no budget constraint; caller passes total capital instead of allocation budget; copy frames risk-per-trade without stating notional.
- **Fix:** take `allocatedCapital` per asset; `shares = min(riskShares, floor(allocatedCapital / price))`; display notional alongside shares with "≤ allocation" invariant; Robo passes `allocatedAmount`.
- **Regression risk:** `roboAdvisorModal.test.tsx:57-59` and `roboAdvisor.test.ts:48-61` encode 2%-of-total-capital sizing → re-baseline. **Tests:** notional ≤ allocation for ATR/price ∈ {0.1%, 1%, 5%}; sizing-to-zero (existing: `risk.test.ts:72-80`).

**F-1.2b — `stopPrice` not floored at 0 · Confirmed · P2**
- **Evidence:** `risk.ts:118` — `price - atr`, no clamp; proxy ATR (`roboAdvisor.ts:90-95`) = `price × |risk_pct|`, safe only while `|risk_pct| < 1`.
- **Fix:** clamp stop ≥ 0 (or treat as invalid). **Risk:** display-only. **Tests:** `atr > price` edge case.

**F-1.2c — "Guaranteed max loss" UI claim · Not Reproducible** — Repo-wide search for `guarantee|max loss` finds **no such copy**; closest is `RoboAdvisor.tsx:458,494` ("risks 2% of total capital at a 1×ATR stop") + `portfolioBuilder.ts:14-18`. Stop-based sizing cannot guarantee bounds (gaps) — add non-guarantee disclosure with F-1.2a fix. Zero/missing ATR → size 0 is correct (`risk.ts:111-114`); 4dp quantity precision (`risk.ts:114`, `formatShares` `124-130`) — verified sound.

### Phase 1.3 — Portfolio Accounting

**F-1.3a — Hardcoded cash · Confirmed · P1** — `const AVAILABLE_CASH = 2500` (`src/components/PortfolioDashboard.tsx:45`) drives `generateSuggestions(visible, assets, AVAILABLE_CASH)` (`:349`) and renders as real money: "$2,500.00 available" (`:483-485`). **Root cause:** no cash-balance domain concept; a constant stood in. **Fix:** state-driven `cashBalance` per portfolio (seeded, mutated by buys/sells), persisted. **Risk:** suggestion gating + copy change together; `generateShareText` unaffected. **Tests:** suggestions suppressed at 0 cash (exists `portfolioManager.test.ts:152`) extended with cash-flow-driven balance.

**F-1.3b — Missing price silently valued at buy price · Confirmed · P2** — `portfolioManager.ts:57-59` and `HoldingRow` (`PortfolioDashboard.tsx:163-170`): absent/invalid live price ⇒ `currentPrice = buyPrice` ⇒ P&L exactly 0 with **no staleness cue** in the row (documented only in a code comment). Avoids phantom P&L (good) but implies "price unchanged". **Fix:** per-row freshness state (`Live/Stale/Unavailable`) from `assets_status.updated_at` + live-price presence; show "—" for P&L when unavailable. **Risk:** KPI/row formatting snapshots. **Tests:** missing-price row shows unavailable state; stats still avoid phantom P&L (partially exists: `portfolioManager.test.ts` fallback assertions).

**F-1.3c — No lot/transaction model; permissive edits · Confirmed · P2** — Single-lot position records (`portfolioManager.ts:3-10`); repeated buys create independent rows (`AddPositionModal.tsx:90-97`, `RoboAdvisor.tsx:206-213`); stats correctly aggregate multi-lot by ticker (verified `portfolioManager.ts:56-71`; `deriveWeights` `backtestManager.ts:64-69`; `computeAllocation` `allocation.ts:42-49`). Edit allows `shares >= 0` ⇒ zero-share rows persist (`PortfolioDashboard.tsx:183`). No cost-basis averaging or transaction history. **Fix:** `PositionLot` + `Transaction` (Milestone 2); reject 0-share edits or auto-close. **Risk:** storage migration. **Tests:** lot aggregation equals current math; zero-share edit rejected.

**F-1.3d — Sim vs live: flag only, one shared blob · Partially Resolved · P1** — Distinction **exists**: `Position.isSimulation` (`portfolioManager.ts:8`), mode toggle filters rows (`PortfolioDashboard.tsx:43,337,345-347`); Backtest receives mode-filtered `visible` (`:477`). **Gaps:** "Save to Cloud" persists **both** modes in one JSONB array (`PortfolioDashboard.tsx:396` → `db.ts:8-17`); one hardcoded cash figure; one suggestion engine; no third domain (paper trading) — `TradeTicket` is a labelled mock (`TradeTicket.tsx:80-87,232-235`). **Fix:** `PortfolioType`-keyed stores + normalized schema (Milestone 2).

### Phase 2 — Historical Data & Backtesting Integrity

**F-2.1a — Backtester replays static buy-and-hold weights; no strategy signals · Confirmed · P1**
- **Evidence:** `computeBacktest()` (`src/lib/backtestManager.ts:86-177`) multiplies each weight by a fixed `price(t)/price(first)` growth factor — there are no entry/exit signals, no rebalancing, no position changes; `BacktestChart.tsx:66-70` feeds `deriveWeights(positions, assets)` (current portfolio) and the UI honestly calls it "Replay the past year with your current allocation" (`BacktestChart.tsx:86-88`). Tests codify buy-and-hold (`backtestManager.test.ts`).
- **Root cause:** V1 feature scope; the Active Research Lab requirement (signal-driven strategy execution) was never built.
- **Fix (Milestone 2):** extend the engine with a `Strategy` interface producing actions on a bar timeline (signal → fill at next bar open, with costs), while keeping buy-and-hold as the `BuyAndHoldStrategy` baseline for comparison.
- **Regression risk:** equity curves of existing backtests change if execution semantics change; keep buy&hold path bit-identical and covered by current 8 tests. **Tests:** golden-curve regression for buy&hold; signal-strategy fill-timing tests (no same-bar close fills).

**F-2.1b — Missing series held flat (incl. silent fetch failures) ⇒ Sharpe/MDD distortion · Confirmed · P1**
- **Evidence:** ticker without points keeps `factors[i] = 1` for the whole timeline (`backtestManager.ts:122-125`); `BacktestChart` only fetches crypto (`:28-29,45-53`) and **discloses** non-crypto being held flat (`:105-110`), but `Promise.allSettled` rejections are silently dropped (`:56-58`) — an *errored* crypto fetch has the same flat effect **with no disclosure**, and the run only fails if *all* crypto series fail (`:60-64`). Flat assets contribute zero variance, systematically deflating portfolio volatility ⇒ **inflated Sharpe** (`risk.ts:39-71`) and **understated max drawdown** — while the full weight still counts in return. Test codifies flat-holding (`backtestManager.test.ts:130-146`).
- **Root cause:** partial-coverage policy is "flat" with disclosure only in one branch; metrics computed over diluted curve.
- **Fix:** (a) surface per-ticker coverage status in results (`covered | flat | failed`) and show a warning banner listing them; (b) refuse to compute Sharpe/MDD when coverage < 100% of weight (or compute over covered subset and label); (c) consider real equity history later (P3 vendor decision). **Regression risk:** UI copy/tests in `backtestChart.test.tsx`. **Tests:** mixed crypto/equity portfolio reports coverage warning; failed-fetch ticker marked `failed`; Sharpe suppressed (or labeled) on partial coverage.

**F-2.1c — No fees/slippage/transaction costs in backtest · Confirmed · P1** — `computeBacktest` has no cost model (`backtestManager.ts:86-177`); the only fee constant in the app is the mock ticket's `FEE_RATE = 0.0025` (`TradeTicket.tsx:11`), and its footnote defers slippage to a future broker integration (`:232-235`). **Fix:** `costModel: { feeBps, slippageBps }` in `computeBacktest` options with defaults from a single constants module shared with `TradeTicket`. **Risk:** all return figures shift slightly → update expected values in `backtestManager.test.ts`. **Tests:** fee-inclusive vs fee-free curves; zero-cost equals today's output.

**F-2.1d — Risk-free rate fixed at 0 · Confirmed · P2** — Documented (`risk.ts:36-37`) and disclosed in UI ("Annualized, risk-free = 0", `BacktestChart.tsx:144`). **Fix:** configurable `riskFreeAnnual` (default 0 or a sourced T-bill constant) passed to `sharpeRatio` (`risk.ts:39-42` already accepts `periodsPerYear`; add rf param). **Risk:** displayed Sharpe values shift when rf > 0. **Tests:** rf=0 reproduces current values.

**F-2.1e — Retrodictive weights (today's portfolio applied to last year) · Confirmed · P2** — `BacktestChart.tsx:26` derives weights from *current* holdings/prices; the past year's curve therefore assumes an allocation the user may not have held (survivorship + look-ahead of allocation itself). UI says "with your current allocation" (accurate framing). **Fix:** when transactions/lots exist (Milestone 2), replay from actual history; until then label results "hypothetical". **Tests:** transaction-driven backtest differs from current-weight backtest.

**F-2.1f — Look-ahead risk for future strategy signals · Requires Further Investigation (future guard)** — Today's engine has no signals (N/A). The forward-fill loop uses same-timestamp closes (`backtestManager.ts:128-143`); when signal execution lands, filling at the *same* bar's close that produced the signal would be look-ahead. **Fix requirement in M2 spec:** signals computed on close of bar `t` execute at open of `t+1`. **Tests:** explicit look-ahead unit test (signal at `t` cannot trade at `t`).

**Alignment note (verified sound):** mixed calendars (crypto 24/7 vs equities) are handled by union-timestamp timeline + forward-fill (`backtestManager.ts:111-115,128-143`); equity/crypto daily-close time-zone approximation is a known P3 refinement.

### Phase 3 — Market Data Infrastructure & Synthetic Charts

**F-3.1a — Drizzle migrations drift from the live schema (`symbol` vs `ticker`) · Confirmed · P0**
- **Evidence:** `drizzle/migrations/0000_create_assets_status.sql:3` creates column **`symbol` (UNIQUE)**; migration 0001 only adds `change_24h`. But the app queries **`ticker`** and 14 columns (`assets.ts:28-31`), generated types declare `ticker` + `reward_pct, volume_spike, rsi_14, sma_50, sma_200` (`src/integrations/supabase/types.ts:11-61`), and `docs/CONNECTION.md:22` documents `ticker`. Missing from migrations: `reward_pct, volume_spike, rsi_14, sma_50, sma_200` (+ the `symbol`→`ticker` rename). `drizzle/schema.ts` is a blank stub ("auto-generated and intentionally left blank"), so Drizzle has no source of truth to regenerate from.
- **Root cause:** migrations hand-written once; live table evolved out-of-band (SQL editor/platform); types regenerated from the *remote* DB; migrations never reconciled. **Running these migrations on a fresh database would produce a table the app cannot query (schema-breaking).**
- **Fix:** rewrite migration history to match generated types (authoritative `drizzle/schema.ts`), supersede 0000/0001 with a corrected baseline, add a CI drift check (`drizzle-kit check` / `push --dry-run` against a shadow DB). **Regression risk:** remote apply ordering; any environment created from old migrations. **Tests:** schema-contract test asserting `fetchAssets` select-columns ⊆ migration columns.
- **Remote state:** live table presumed to match `types.ts` (generated from it) — **Requires Further Investigation** via `supabase db dump` (unavailable in this read-only audit).

**F-3.1b — Generated types cover only `assets_status` · Confirmed · P2** — `types.ts` declares a single table; `user_portfolios` (`db.ts`) and `user_alerts` (`priceAlerts.ts`) are queried through an **untyped** client (`supabaseClient.ts:50` — `createClient` without `<Database>`) with manual row casts (`priceAlerts.ts:35-45`, `db.ts:32-34`). **Fix:** regenerate types for all tables; type the client with `Database`. **Risk:** surfaces real type errors at call sites (desirable; gated by existing CI `tsc`). **Tests:** compile-time coverage; keep `db.test.ts` mocks aligned.

**F-3.2a — No `assets_status` ingestion in repo · Requires Further Investigation · P1** — The only reference is the read at `assets.ts:28`; **no writer exists anywhere** (`from('assets_status')` = 1 hit; single `upsert(` is `db.ts:11`). Population lives outside the repo (external provider/platform per `docs/CONNECTION.md:24`). **Missing evidence:** ingestion job existence, schedule, and failure behavior — needed before freshness SLOs (F-3.2b) can be defined. Ownership/observability gap, not a proven defect.

**F-3.2b — No per-asset freshness states · Confirmed · P1** — `updated_at` is selected (`assets.ts:30`) but **never consumed** in `src/**` (zero UI reads). No `Live / Delayed / Stale / Unavailable / Simulated` states exist; a row updated yesterday renders exactly like a fresh one (crypto prices are the exception — overlaid by the Binance WS). **Fix:** freshness classifier (age × asset class × live-overlay) producing per-row state + badge; reuse `Simulated` for sample rows. **Regression risk:** Markets/holdings row layout. **Tests:** classifier boundaries; sample rows always `Simulated`.

**F-3.2c — Global freshness signals already exist · Already Fixed** — Header status chip `Live / Sample data / Connecting / Offline / Reconnecting` (`index.tsx:319-335`), stale-snapshot banner "Refresh failed. Showing the last available snapshot." + Retry (`index.tsx:393-404`), sample banner "Illustrative prices and signals, not live market data" (`index.tsx:377-392`), 60s refetch + manual refresh (`index.tsx:255,344`). These satisfy `docs/CONNECTION.md:26` at the **global** level; per-asset states remain F-3.2b.

**F-3.2d — Symbol-handling inconsistencies · Confirmed · P2**
- `getAssetClass()` (`assets.ts:86-91`) classifies by suffix only → bare crypto tickers (`BTC`, used by `sampleAssets` `assets.ts:172+`, documented in `binance.ts:7-21`) classify as **"Stocks"**, contradicting `isBinanceCrypto()` (which knows `BARE_CRYPTO`); in preview mode the Crypto filter shows nothing.
- `mergeLivePrices()` (`livePriceStore.ts:88-95`) and the WS symbol set (`useBinanceWebSocket.ts:42-49`) map via `toBinanceSymbol` **without** the `isBinanceCrypto` gate → equities map to bogus pairs (`AAPL→AAPLUSDT`, documented footgun `binance.ts:26-28`). Harmless while no such market exists, but a Binance-listed token sharing an equity's bare ticker would silently stream "live" crypto prices onto a stock row (latent collision).
- **Fix:** one `classifyTicker()` (`crypto | equity | forex`) used by class filter, WS subscription, merge, and broker routing; only crypto gets WS overlay. **Tests:** bare `BTC` → Crypto; `AAPL` never WS-merged; collision-ticker case.

### Phase 3.3 — Synthetic Charts

**F-3.3a — `Math.random()` fabricates displayed price history · Confirmed · P1**
- **Evidence:** `generateTrendData()` (`assets.ts:99-130`) injects `jitter = (Math.random() - 0.5) * 0.02 * base` (`assets.ts:125`); rendered as sparklines in the Markets table (`index.tsx:223`) and every Holdings row (`PortfolioDashboard.tsx:219-225`). Invalid price returns an all-zero series (`assets.ts:105-107`). Since `assets_status` stores no history, every sparkline ("price history") is synthetic — and re-randomizes per render (unseeded), so rows flicker. `Math.random` audit: only other uses are `ui/sidebar.tsx:643` (shimmer width), `previewAuthStorage.ts:44` (request id), `alertsStore.ts:37` (alert id) — none financial.
- **Root cause:** no historical store; random jitter stood in for a series. Violates "No fabricated market data".
- **Fix:** (a) derive sparklines from real candles where available (`fetchHistoricalKlines` already exists for Binance), else (b) deterministic start→end path from `change_24h` labelled "derived from 24h change", else (c) hide; remove `Math.random` from finance-adjacent display code. **Regression risk:** `assets.test.ts:143-163` asserts trend shape → re-baseline; visual diffs. **Tests:** determinism (same inputs ⇒ identical output); a lint/grep gate forbidding `Math.random` under `src/lib/**`.

### Phase 4 — Authentication, Persistence & Supabase Security

**F-4.1a — Local positions persist across logout and leak to the next account · Confirmed · P0**
- **Evidence:** `portfolioStore.tsx:51,66` persists the single array under `zerochart:portfolio-positions`; `AuthProvider.signOut` (`authStore.tsx:71-73`) only calls `supabase.auth.signOut()` — **it never clears `positions` or the localStorage key**. Hydration replaces local state **only when the new user has a non-empty cloud row** (`authStore.tsx:62-68`: `if (saved && saved.length > 0)`), so a user with no cloud save (or a failed/`null` load) sees the previous account's positions — and the store immediately re-persists them under the same key. Local alerts (`alertsStore.ts`) are memory-only, so they don't leak. No hydration-race guard exists between `loadPortfolio` and UI writes.
- **Root cause:** browser-scoped store keyed by nothing (no user id); logout lacks a data-clearing hook; cloud hydration treats "empty" as "keep whatever is here".
- **Fix:** key storage per user (`zerochart:portfolio:{userId}`), clear in-memory + persisted positions on `SIGNED_OUT`/user change before hydration, and distinguish `saved === null` vs `saved === []` (empty cloud ⇒ reset to seed/empty, not previous user's data). **Regression risk:** first-run seeding (`MOCK_POSITIONS`) and offline mode must keep working; `app-routing.test.tsx` renders providers. **Tests:** login A → add position → logout → login B (no cloud row) ⇒ B sees no A positions; localStorage key isolation per user.

**F-4.1b — Hydration race: Save-to-Cloud can overwrite the wrong user's row · Confirmed · P0**
- **Evidence:** `loadPortfolio` is fire-and-forget async (`authStore.tsx:62-68`) while `handleSaveToCloud` (`PortfolioDashboard.tsx:390-401`) upserts `positions` for the *current* `user.id`. Sequence: A logs out, B logs in; before B's `loadPortfolio` resolves (or when it fails silently), B clicks "Save to Cloud" → **A's local positions are upserted into B's row** (`db.ts:8-17`, last-writer-wins on `user_id`). No ownership/version guard exists in the JSONB row.
- **Root cause:** no hydration barrier exposed to UI, no write guard, last-writer-wins single-row design.
- **Fix:** expose `hydrating` flag from auth store; disable/queue Save until hydration for that `user.id` completes; optionally add `updated_at` precondition on upsert. **Regression risk:** save-button UX in header. **Tests:** slow `loadPortfolio` + save attempt ⇒ save blocked until hydration completes.

**F-4.2a — Three Supabase client modules / duplicate GoTrueClient instances · Confirmed · P2**
- **Evidence:** (1) `src/lib/supabaseClient.ts` — env-based, `persistSession: true` (authStore, db, priceAlerts, AuthModal); (2) `src/lib/supabase.ts` — **hardcoded** URL + publishable key, `persistSession: false` (`assets.ts`); (3) `src/integrations/supabase/client.ts` — env-based lazy proxy, `persistSession: true` (`auth-attacher.ts:3`, used for serverFn bearer headers via `start.ts:29`). Two auth-capable clients instantiate in one browser; the vitest run emitted `GoTrueClient … Multiple GoTrueClient instances detected … undefined behavior when used concurrently under the same storage key`.
- **Root cause:** organic accretion (generated Lovable client vs hand-written helpers) without consolidation.
- **Fix:** one canonical module (keep `supabaseClient.ts` API surface); re-point `assets.ts` and `auth-attacher` to it; delete/quarantine the rest. **Regression risk:** serverFn auth headers and CI env (`ci.yml:18-19` dummy vars must still satisfy the single client). **Tests:** `app-routing.test.tsx` passes with **no** GoTrueClient warning; grep gate: `createClient(` ≤ 2 call sites (browser + server-admin).

**F-4.2b — Hardcoded URL + publishable key in `src/lib/supabase.ts` · Confirmed · P2** — `supabase.ts:4-5` embeds project URL + `sb_publishable_…` key. Publishable keys are *designed* for browsers (RLS is the boundary) → **no secret exposure**, but env-independent config forks credentials across environments (CI placeholders vs prod) and invites drift. **Fix:** remove module (F-4.2a); env-only config. **Tests:** build with CI dummy env succeeds; secret-scan gate: no `sb_publishable_` literal in `src/**`.

**F-4.2c — Service-role key exposure · Already Fixed (verified)** — `SUPABASE_SERVICE_ROLE_KEY` appears only in `client.server.ts:37-51` behind a lazy proxy, from `process.env`; **zero importers** of `client.server`/`supabaseAdmin` exist (grep), so it is server-only dead code and absent from the client bundle (build output contains no service-role literal). **P3 recommendation:** wire it only into future trusted server routes or remove until needed.

**F-4.2d — RLS: repo scripts complete; remote enforcement unverified · Requires Further Investigation · P0-if-missing**
- **Repo evidence (scripts look correct):** `user_portfolios` — SELECT/INSERT/UPDATE/DELETE all `auth.uid() = user_id` (`supabase_schema.sql:26-52`), RLS enabled `:23`, `updated_at` trigger `:65-69`. `user_alerts` — all four ops owner-scoped (`supabase_alerts_schema.sql:20-45`), FK → `auth.users`. `assets_status` — SELECT-only for `anon, authenticated` (`drizzle/migrations/0000…sql:13-16`); no client write policies (ingestion must be service-role).
- **Missing evidence:** whether these SQL-editor scripts were applied remotely and unmodified — they are untracked by drizzle history; `user_portfolios`/`user_alerts` appear in **no** migration. **Required:** `supabase db dump` + policy export before Milestone 1 closes. **Tests once verified:** Supabase CLI / pgTAP assertions that cross-user SELECT/INSERT/UPDATE/DELETE are denied.

### Phase 5 — Price Alert Reliability

**F-5.1a — Duplicate local vs cloud alert pipelines · Confirmed · P1**
- **Evidence:** Pipeline A (local): bell in Markets rows → `addAlert()` (`SetAlertModal.tsx:88`) → in-memory `alertsStore.ts` → evaluated **only** inside the Binance WS handler (`useBinanceWebSocket.ts:18-28,88`) → `sonner` toast + removal. Pipeline B (cloud): `PriceAlerts` panel → `usePriceAlerts(assets, user)` (`PriceAlerts.tsx:12-14`) → Supabase `user_alerts` (`priceAlerts.ts`) → evaluated on `assets` changes (`usePriceAlerts.ts:113-134`) → in-app notification + `deactivateAlert`. Two UIs can hold the *same* threshold → duplicate notifications for one crossing; semantics diverge (local: crypto-only, dies on refresh; cloud: any ticker, persists, 60s-stale for equities).
- **Root cause:** cloud pipeline added alongside, not instead of, the local one.
- **Fix:** consolidate on the cloud pipeline evaluated against the merged live stream; keep a clearly-labelled guest (in-memory) tier in **one** module with one evaluation loop + one notification channel. **Regression risk:** `priceAlerts.test.ts` (3 tests), bell UX, toast copy; `useBinanceWebSocket` drops its alert dependency. **Tests:** exactly one notification per crossing; guest vs signed-in routing; legacy-both-stores migration case.

**F-5.1b — Local alerts memory-only; silent while WS down · Confirmed · P1** — `alertsStore.ts:13` is a module array with **no persistence**; refresh/logout loses alerts silently, and while the WS reconnects (`livePriceStore.ts:59`) they never evaluate (no fallback poll). Cloud alerts survive reloads but lose sub-second latency for crypto. **Fix:** folded into F-5.1a (persist or explicitly label "session-only"). **Tests:** alert survival across simulated remount with documented guest semantics.

**F-5.1c — Failed `deactivateAlert` ⇒ refire after next refetch · Confirmed · P2** — `triggerAlert` removes locally, then `deactivateAlert(...).catch(() => {})` swallows failure (`usePriceAlerts.ts:105-107`); the next `fetchActiveAlerts` re-fetches the still-active row and, price still crossed, fires again (`:113-134`). **Fix:** retry with backoff; keep local `fired` marker until server ack; add `fired_at` column so re-fetched fired alerts stay suppressed. **Regression risk:** alert lifecycle tests. **Tests:** deactivate-fails ⇒ no refire on refetch; eventual consistency after retry.

**F-5.1d — Stale evaluation for non-crypto alerts · Confirmed · P2** — Equity/forex alerts compare against `assets_status.current_price` refreshed ≤60s (`index.tsx:255`) — indefinitely if ingestion stalls (F-3.2a), with no staleness guard (`usePriceAlerts.ts:116-133` checks only `> 0`); `updated_at` unused (F-3.2b). **Fix:** evaluator skips/flags prices older than a per-class TTL; "evaluated on delayed price" note. **Tests:** stale-price suppression; TTL boundaries.

### Phase 6 — Robo-Advisor Transparency & Wealth Projections

**F-6.1a — Risk "profiling" = 3 static buttons · Confirmed · P2** — No questionnaire, goals, horizon, or loss-capacity questions; the user picks `conservative|moderate|aggressive` (`RoboAdvisor.tsx:25-53,71`) and the profile only selects holdings count + return assumption. **Fix (M2):** short risk questionnaire (horizon, tolerance, drawdown reaction) mapping to the existing enum; engine stays deterministic. **Tests:** questionnaire → profile mapping tests.

**F-6.1b — Diversification = holdings count only · Confirmed · P2** — `ASSET_COUNT_BY_RISK = { conservative: 8, moderate: 5, aggressive: 3 }` (`portfolioBuilder.ts:22-26`); fewer holdings = "aggressive" purely by concentration ("Concentrated upside", `RoboAdvisor.tsx:47-52`) with no volatility/correlation/asset-class exposure considered, and score-weighted allocation can pile most capital into one asset (`roboAdvisor.ts:192-197`). **Fix:** single-asset weight cap, class diversification constraints, realized-volatility targeting (reuse indicator stack). **Regression risk:** distribution asserts (`roboAdvisor.test.ts:55-63`). **Tests:** max-weight cap; conservative spread constraint.

**F-6.1c — "AI" terminology vs deterministic heuristic · Confirmed · P2** — Marketing says "AI Robo-Advisor" / "AI portfolios" (`README.md:24,40`; `LandingPage.tsx:22,109`; disclaimer `:185`, `index.tsx:510`), while the engine is a deterministic multi-factor scorer — the modal is honest ("Multi-Factor Score (RSI · MACD · ATR)", `RoboAdvisor.tsx:457-460,478`). Conflicts with "Deterministic Engines Calculate. AI Agents Research, Summarize and Explain." **Fix:** rename copy ("Quant Robo-Advisor"), reserve "AI" for future LLM explanation layers. **Tests:** optional copy gate; PO decision required.

**F-6.1d — Hardcoded 5%/8%/12% return assumptions · Confirmed · P3** — `ANNUAL_RETURN_BY_RISK` (`dca.ts:4-8`) feeds Wealth Projection (`RoboAdvisor.tsx:408-455`); **disclosure present**: "5% assumed return" chip + "compounding at the profile's assumed rate" (`:411-414,450-453`). `projectWealth` math verified correct (principal compounding + end-of-month annuity, `dca.ts:22-46`). **Fix (P3):** configurable rates in one constants file, optional benchmark link / inflation toggle. **Tests:** extend `dca.test.ts` for config input.

---

## 3. Items Verified Sound (no defect found)

- **Unrealized P&L math:** `totalValue − totalInvested` with per-position `(live − buy) × shares`; multi-lot aggregation correct (`portfolioManager.ts:51-77`; `HoldingRow` `PortfolioDashboard.tsx:167-170`).
- **Position CRUD consistency:** add/remove/update all flow through `portfolioStore` and persist atomically; Robo "Confirm & Invest" writes `allocatedAmount/price` shares, skipping unpriced assets (`RoboAdvisor.tsx:201-214`).
- **Backtest Sharpe/MDD edge cases:** flat/short curves → 0, no divide-by-zero (`risk.ts:39-71`); drawdown clamped 0–1 (`risk.ts:19-31`); 9 dedicated `risk.test.ts` cases pass.
- **WS lifecycle:** auto-reconnect with capped exponential backoff, cleanup of socket/timers on unmount, throttled batched store writes (`useBinanceWebSocket.ts:51-120`); `alerts` notification timers cleared on unmount (`usePriceAlerts.ts:137-143`).
- **Session security:** 15-minute inactivity sign-out with toast (`useSessionTimeout.ts:18-52`), active only when signed in.
- **Sample-data honesty:** preview banner, "Sample data" chip, samples never substituted for failed live fetches (`index.tsx:377-392`, `assets.test.ts:50-57`).
- **CI hygiene:** four required gates on `main`, dummy Supabase env, no secrets committed (`.github/workflows/ci.yml:13-19`).








---

## 4. Remediation Log

### M1-T1 — Account isolation, hydration barrier, client consolidation, schema alignment (branch `fix/m1-t1-isolation-and-schema`)

| Finding | Fix | Key files |
| --- | --- | --- |
| F-4.1a (P0) | Per-user localStorage scoping (`zerochart:portfolio-positions:{userId}`) with atomic `switchScope`; `signOut` clears memory + re-scopes to guest **before** the network call resolves; explicit empty cloud row (`[]`) replaces seeds | `src/lib/portfolioStore.tsx`, `src/lib/authStore.tsx` |
| F-4.1b (P0) | `hydrationStore` state machine (`idle/hydrating/ready/error` per user); `authStore` drives transitions with stale-response guards; `db.savePortfolio` throws `PortfolioNotHydratedError` while in-flight; Save button disabled + toast until settled; failed hydration counts as settled (offline saves not bricked) | `src/lib/hydrationStore.ts` (new), `src/lib/authStore.tsx`, `src/lib/db.ts`, `src/components/PortfolioDashboard.tsx` |
| F-4.2a/b (P2) | One canonical browser client (`src/lib/supabaseClient.ts`, typed `<Database>`); `src/lib/supabase.ts` + `src/integrations/supabase/client.ts` are re-exports; env resolution centralized in `src/lib/supabaseConfig.ts`; hardcoded URL/key removed; server-only `client.server.ts` untouched | `src/lib/supabaseClient.ts`, `src/lib/supabaseConfig.ts` (new), `src/lib/supabase.ts`, `src/integrations/supabase/client.ts` |
| F-3.1a (P0) | `drizzle/schema.ts` populated (3 tables, uniques, checks); idempotent non-destructive `0002_reconcile_schema_baseline.sql` (ticker backfill from legacy `symbol`, missing columns, `user_portfolios`/`user_alerts` baselines + RLS) + journal entry; legacy `symbol` column retained | `drizzle/schema.ts`, `drizzle/migrations/0002_reconcile_schema_baseline.sql` (new), `drizzle/migrations/meta/_journal.json` |
| F-3.1b (P2) | `user_portfolios` + `user_alerts` added to `Database` types; typed client; `db.ts` and `priceAlerts.ts` row casts replaced with schema-derived types | `src/integrations/supabase/types.ts`, `src/lib/db.ts`, `src/lib/priceAlerts.ts` |

**Verification (2026-10-17):** `npx tsc --noEmit` ✅ · `npx eslint .` ✅ · `npx vitest run` ✅ **23 files / 128 tests** (16 new: hydration barrier + account isolation + singleton + save gate), **zero** "Multiple GoTrueClient instances detected" warnings · `npm run build` ✅.

**Residual notes:** remote DB state still requires the M1-1 dump/policy export before applying 0002 (repo-side migration is untracked-remote by design); `assets_status` ingestion ownership (F-3.2a) remains open.

¹ F-1.1a: both models still exist, but they now share one missing-data contract (neutral 50 / weight re-normalization) so they cannot contradict each other on absent data; full single-model unification remains roadmap M1-7.

### M1-T2 — Financial engine reliability (branch `fix/m1-t2-financial-engines`)

| Finding | Fix | Key files |
| --- | --- | --- |
| F-1.2a (P0) | `recommendPositionSize` gains `allocatedCapital`; notional is hard-bounded by `min(capital, allocation)` with a round-down guard so 4dp rounding can never breach the budget; new `isCapped` flag; `buildQuantPortfolio` passes each asset's `allocatedAmount` (previously sized every asset with the FULL capital — $30k notional on a $10k allocation in tests); Robo UI copy updated to "risks **up to** 2% … capped at the allocation" | `src/lib/risk.ts`, `src/lib/roboAdvisor.ts`, `src/lib/portfolioBuilder.ts`, `src/components/RoboAdvisor.tsx` |
| F-1.1b (P1) | `calculateSignalScore` returns a **neutral 50** when the provider omits `risk_pct`/`reward_pct` (was penalized base 20 ⇒ max 45 ⇒ permanent false SELL). Aligns the ratio model with `multiFactor.ts`'s re-normalization principle; real bonuses (volume +15, trend +10) still apply on top | `src/lib/assets.ts` |
| F-1.2b (P2) | Stop price floored at 0 (`Math.max(0, price − atr)`) | `src/lib/risk.ts` |
| F-3.3a (P1) | `generateTrendData` is now a deterministic linear interpolation between the 24h-change-derived start and the current price — zero `Math.random()`; docstring states it is a derived visualization, not market history | `src/lib/assets.ts` |

**Test re-baselines (deliberate, bug-encoding assertions):** `assets.test.ts` "missing data" 20→50; `roboAdvisor.test.ts` suggested shares 300→100 (the old expectation WAS the P0: $30k notional on a $10k allocation). Everything else passed unchanged.

**Verification (2026-10-17):** `npx tsc --noEmit` ✅ · `npx eslint .` ✅ · `npx vitest run` ✅ **23 files / 136 tests** (+8: budget caps, stop floor, scoring resilience, no-false-SELL, sparkline determinism) · `npm run build` ✅ · zero `Math.random()` in any price/sparkline path (only remaining use: alert-ID generation, `alertsStore.ts:37`).



