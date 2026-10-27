<div align="center">

# ZeroChart

**Quantitative research and paper trading environment.**

Understand, backtest, and simulate multifactor signals.

A TradingView Pine Script HUD that scores every bar, and a React + Supabase command center that turns those scores into sized, audited paper trades.

[![CI](https://img.shields.io/github/actions/workflow/status/blackhebrewisraeli/ZeroChart/ci.yml?branch=main&style=for-the-badge&logo=githubactions&logoColor=white&label=CI)](https://github.com/blackhebrewisraeli/ZeroChart/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)](https://react.dev/)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres_%2B_RLS-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white)](https://supabase.com/)
[![Pine Script](https://img.shields.io/badge/Pine_Script-v6-00E5FF?style=for-the-badge&logo=tradingview&logoColor=white)](https://www.tradingview.com/pine-script-docs/)
[![License: MIT](https://img.shields.io/badge/License-MIT-F5C518?style=for-the-badge)](./LICENSE)

[**Live app**](https://zero-chart.vercel.app) · [Architecture](#the-ecosystem) · [Features](#flagship-features) · [Getting started](#getting-started) · [Docs](#documentation)

</div>

> [!NOTE]
> ZeroChart is research and paper-trading software. Its scores, position sizes, and backtests are informational, not financial advice, and no real orders are ever placed.

## The ecosystem

ZeroChart is two products built on one quant model. The RSI / MACD / ATR model is implemented in TypeScript for the web app and ported to Pine Script. The two agree closely on a long daily chart, but they are not identical: Pine computes on the chart's whole history with TradingView's built-in indicators, while the app re-scores the latest 200 daily candles, so short histories, flat prices, other timeframes and rounding ties can score differently. [docs/PINE_PARITY_ASSESSMENT.md](./docs/PINE_PARITY_ASSESSMENT.md) states the comparison contract and measures the gap.

|                      | **ZeroChart Quant HUD**                                                                                    | **ZeroChart Command Center**                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Runs on**          | TradingView, as a Pine Script v6 overlay                                                                   | The browser: React 19 on TanStack Start, backed by Supabase                                              |
| **Job**              | Live visual signals on any chart                                                                           | Portfolio accounting, strategy backtesting, paper-trade execution                                        |
| **Shows**            | On-chart HUD table: quant score, market regime, factor breakdown, position size, ATR stop, one-line thesis | Research (scanner, charts, signals), Paper Desk (paper trading, simulated portfolio, backtests), Account |
| **Emits / consumes** | Emits alerts: high-conviction bullish, regime shift to high volatility, ATR trailing-stop breach           | Consumes those alerts through a secured webhook, in real time                                            |
| **Source**           | [`pine/zerochart_quant_hud.pine`](./pine/zerochart_quant_hud.pine)                                         | [`src/`](./src) and [`supabase/`](./supabase)                                                            |

```mermaid
flowchart TB
    subgraph TV["TradingView"]
        HUD["ZeroChart Quant HUD<br/>Pine Script v6"]
    end

    subgraph SB["Supabase"]
        FN["tv-webhook<br/>Edge Function"]
        DB[("trading_signals<br/>Postgres + RLS")]
    end

    subgraph APP["ZeroChart Command Center"]
        AC["Action Center"]
        LEDGER["v3 portfolio ledgers"]
        WORKER["Finance Web Worker"]
        UI["Scanner · Charts · Backtests"]
    end

    BIN["Binance WebSocket + REST"]

    HUD -- "alert JSON + secret_token" --> FN
    FN -- "service-role insert" --> DB
    DB -- "Realtime INSERT" --> AC
    AC -- "Execute: tactical fill" --> LEDGER
    BIN -- "live ticks + candles" --> UI
    UI <-- "indicator + backtest jobs" --> WORKER
```

## Flagship features

### Web Worker multi-factor engine

- Scores every asset 0–100 by blending three normalized factors: **RSI** mean reversion (40%), **MACD** momentum (40%), and **ATR** volatility regime (20%).
- Detects the market regime (high volatility, trending, mean-reverting, or neutral) and tilts the weights toward the factor that regime rewards.
- One canonical engine, [`canonicalModel.ts`](./src/lib/canonicalModel.ts), scores every surface (Scanner, Portfolio, Quant Analyzer, Tactical Signals, shared snapshots) from the latest 200 closed daily candles. The Pine HUD shares its factor math, within the bounds in [docs/PINE_PARITY_ASSESSMENT.md](./docs/PINE_PARITY_ASSESSMENT.md). An asset with fewer than 34 daily candles reports `INSUFFICIENT_DATA` and shows "Not Enough Data", never a guessed score.
- Every score is explainable: sub-scores, applied weights, regime, and a one-line rationale.
- Heavy math (SMA, RSI, MACD, ATR, full backtests) runs off the main thread in [`finance.worker.ts`](./src/lib/finance.worker.ts), with results cached and served through the async [`financeClient.ts`](./src/lib/financeClient.ts) API, so charts never freeze the UI.

### v3 atomic accounting

- Three strictly isolated ledgers per user: **Live Tracking**, **Simulation**, and **Paper Trading**, each with its own positions, cash, cash ledger, transactions, and realized P&L. Paper Trading and Simulation live on the Paper Desk; Live Tracking (real holdings, logged by hand) appears only under Account, so real and simulated money never share a screen.
- Every buy, sell, deposit, and withdrawal is a pure, immutable state transition in [`portfolioAccounting.ts`](./src/lib/portfolioAccounting.ts). Positions, cash, and the transaction log move together, or the trade is rejected and nothing changes.
- Multi-lot cost basis, FIFO lot consumption on sells, and fee- and slippage-aware realized P&L. Valuation reports missing prices honestly instead of guessing.
- Older v1 and v2 payloads migrate deterministically into the v3 snapshot on load.

### Dynamic position sizing

- ATR-based sizing in [`risk.ts`](./src/lib/risk.ts): the position is sized `q = min(risk budget / stop distance, capital / price)`, so a stop two ATRs away loses at most your chosen risk (2% of capital by default).
- Hard invariants: notional never exceeds the capital or per-asset budget, the stop price is floored at zero, and shares round to four decimals (down, when needed, to stay within budget). When the budget binds, the position and its risk come in below the target.
- The Quant Analyzer and the asset detail view call `risk.ts` directly. The Pine HUD applies the same budget-capped sizing and the same 2× ATR stop by default; its stop multiplier is configurable.
- The server enforces the same limits. Every Paper Trading BUY must keep Aggregate Open Risk within 6% of total equity ([`check_paper_transaction`](./supabase/migrations/20261022130000_paper_portfolio_execution.sql)). The Quant Analyzer books a whole proposal through `execute_paper_portfolio`: one transaction from existing Paper Cash, priced at the server quote, sized under each holding's ATR risk cap, and idempotent on its request ID. Confirm books the previewed orders or nothing: if any price or size moved more than 0.5% (the paper fill tolerance) since the preview, it shows the repriced plan for a fresh Confirm. A booking whose answer was lost is settled by its request ID, even after the dialog closes or the page reloads. Planned stops are sizing assumptions; Paper Trading places no stop orders.

### Real-time webhook Action Center

- TradingView alerts post to the [`tv-webhook`](./supabase/functions/tv-webhook/index.ts) Edge Function. Each user authenticates with a rotating `secret_token` that is stored only as a SHA-256 hash.
- TradingView cancels a delivery after 3 seconds, so one database call (`ingest_tradingview_signal`) authenticates the token and records the signal, and the function answers only once the row has committed. Validation errors are reported only to an authenticated caller. Payloads carry ticker, BUY/SELL action, 0–100 `signal_score`, `price`, `quantity` in units, an optional stop, and, from the current HUD, exchange, timeframe, bar time and model version. They land in `trading_signals` as `PENDING`. A unique `(user, ticker, action, event_id)` index turns a re-delivered alert into a `200 duplicate`. Each delivery logs one JSON line naming its outcome.
- The [Action Center](./src/components/ActionCenter.tsx) streams new signals over Supabase Realtime. **Execute** books a tactical fill into the Paper Trading ledger at the live price, and only then marks the signal `EXECUTED`; **Dismiss** retires the signal.
- Row-level security lets users read only their own signals and move them out of `PENDING` once. Ticker, size, and stop are writable only by the webhook, so the audit trail can't be rewritten.

### Also included

| Feature                  | What it does                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| **Live market stream**   | Binance all-market ticker over WebSocket, batched into a `useSyncExternalStore` store so only rows whose price changed re-render |
| **Canvas charts**        | `lightweight-charts` candlesticks with SMA 50/200 and a synchronized RSI pane                                                    |
| **Backtesting**          | Replays an allocation over a year of daily candles, with max drawdown and Sharpe ratio                                           |
| **Quant Analyzer**       | Builds a signal-ranked, risk-weighted portfolio from your Paper Cash and risk profile, then books it in one server transaction   |
| **Price alerts**         | Cloud-synced (RLS) for signed-in users, session-only for guests; each alert fires exactly once                                   |
| **Shareable portfolios** | Read-only snapshot links at `/p/:portfolioId` that anyone can open                                                               |

## Tech stack

| Layer           | Technology                                                                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Frontend**    | [React 19](https://react.dev/), [TanStack Start](https://tanstack.com/start) (SSR + file-based routing), [TanStack Query](https://tanstack.com/query) |
| **Build**       | [Vite](https://vite.dev/), [TypeScript](https://www.typescriptlang.org/) (strict)                                                                     |
| **Styling**     | [Tailwind CSS v4](https://tailwindcss.com/), [shadcn/ui](https://ui.shadcn.com/) on Radix primitives, [Framer Motion](https://motion.dev/)            |
| **Charts**      | [lightweight-charts](https://www.tradingview.com/lightweight-charts/) (Canvas), [Recharts](https://recharts.org/)                                     |
| **Compute**     | Web Workers for indicator and backtest math                                                                                                           |
| **Backend**     | [Supabase](https://supabase.com/): Postgres + RLS, Auth, Realtime, Edge Functions (Deno)                                                              |
| **Market data** | Binance WebSocket and REST APIs                                                                                                                       |
| **Indicator**   | [Pine Script v6](https://www.tradingview.com/pine-script-docs/) on TradingView                                                                        |
| **Quality**     | [Vitest](https://vitest.dev/), Testing Library, ESLint, Prettier, GitHub Actions                                                                      |

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) 22+ (or [Bun](https://bun.sh/))
- A [Supabase](https://supabase.com/) project

### 1. Clone and install

```bash
git clone https://github.com/blackhebrewisraeli/ZeroChart.git
cd ZeroChart
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env.local
```

Then fill in the two values from **Supabase → Project Settings → API**:

```env
VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
# Publishable key (sb_publishable_...); a legacy anon key also works
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

> [!WARNING]
> Only the publishable (anon) key belongs in the frontend. Never put a service-role or secret key in `.env.local`.

### 3. Set up the database

`supabase/migrations` is the only source of the schema. Link the Supabase CLI and push every migration:

```bash
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

Finally, make sure **Email** is enabled under **Authentication → Providers**.

### 4. Run the dev server

```bash
npm run dev
```

Open [http://localhost:8080](http://localhost:8080).

### 5. Optional: connect TradingView

1. Deploy the webhook (JWT verification is already turned off for it in [`supabase/config.toml`](./supabase/config.toml)):

   ```bash
   npx supabase functions deploy tv-webhook
   ```

2. In the app, open any asset and click **TradingView Indicator**, then click **Generate webhook token**. Copy the Pine Script after that: your token replaces `USER_SECRET_PLACEHOLDER` in its alert payloads.
3. Add the indicator to a TradingView chart, create an alert with the condition **Any alert() function call**, and paste the webhook URL into it.

### Scripts

| Command              | Purpose                            |
| -------------------- | ---------------------------------- |
| `npm run dev`        | Start the dev server on port 8080  |
| `npm run build`      | Production build                   |
| `npm run preview`    | Serve the production build locally |
| `npm test`           | Run the Vitest suite once          |
| `npm run test:watch` | Run Vitest in watch mode           |
| `npm run lint`       | ESLint                             |
| `npm run format`     | Prettier                           |
| `npx tsc --noEmit`   | Typecheck                          |

## Project structure

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the file tree (app, edge functions, scripts, database tests) and a map of where each feature lives.

## Quality gates

Every pull request to `main` runs [CI](./.github/workflows/ci.yml): typecheck, build, lint, and the full test suite. Run the same checks locally before you push:

```bash
npx tsc --noEmit && npm run build && npm run lint && npm test
```

The finance core (indicators, multi-factor scoring, position sizing, accounting, backtesting, alert evaluation, webhook payload parsing) is pure and unit-tested.

Vercel production builds also check that the production database has every migration and RPC the frontend needs, and fail before going live if it doesn't. See [Releasing database changes](./docs/RELEASE.md).

## Documentation

| Document                                                 | What's inside                                                                                                  |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [Architecture](./ARCHITECTURE.md)                        | File tree and where each feature lives                                                                         |
| [Hybrid architecture](./docs/hybrid-architecture.md)     | Target architecture, reusable engine inventory, and the path from JSONB snapshots to a normalized domain model |
| [Hybrid roadmap](./docs/hybrid-roadmap.md)               | Milestone 1 and 2 plans, execution checkpoints, and open questions                                             |
| [Roadmap](./docs/roadmap.md)                             | Completed launch milestones                                                                                    |
| [Engineering audit](./docs/engineering-audit.md)         | Milestone 0 findings register and remediation log                                                              |
| [Strategy validation lab](./docs/STRATEGY_VALIDATION.md) | Private, browser-independent decision replay and observation contract                                          |
| [Supabase connection](./docs/CONNECTION.md)              | Data contract for the `assets_status` market table                                                             |
| [Releasing database changes](./docs/RELEASE.md)          | Release order for migrations, the production build's database gate, rollback                                   |
| [Agent conventions](./docs/AGENTS.md)                    | Architecture rules for coding agents working in this repo                                                      |
| [Contributing](./CONTRIBUTING.md)                        | Dev setup, coding standards, and the pull request process                                                      |

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) first; the short version is to keep engines pure and tested, keep heavy math in the Web Worker, and put RLS on every table.

## License

Released under the [MIT License](./LICENSE).

<div align="center">

**ZeroChart: signal over noise.**

[Back to top](#zerochart)

</div>
