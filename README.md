<div align="center">

# ⚡ ZeroChart

**Algorithmic Portfolio Management & Robo-Advisor — zero knowledge required.**

ZeroChart turns raw market data into one high-signal trading terminal: deterministic signal scores, a live Binance price stream, Canvas candlestick charts with technical indicators, a 1-year backtesting engine, and real-time price alerts — wrapped in an Electric-Cyan terminal UI.

[![React](https://img.shields.io/badge/React-19-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres_%2B_RLS-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white)](https://supabase.com/)
[![Vercel](https://img.shields.io/badge/Vercel-Deploy-000000?style=for-the-badge&logo=vercel&logoColor=white)](https://vercel.com/)
[![TanStack Start](https://img.shields.io/badge/TanStack_Start-SSR-FFC831?style=for-the-badge)](https://tanstack.com/start)
[![Vitest](https://img.shields.io/badge/Vitest-tested-6E9F18?style=for-the-badge&logo=vitest&logoColor=white)](https://vitest.dev/)

[Quick start](#quick-start) · [Key features](#key-features) · [Architecture](#architecture--performance) · [Documentation](#documentation)

![Dashboard Screenshot](link-here)

</div>

## Overview

ZeroChart is a premium cyber-finance terminal that combines a real-time market scanner, a Quantitative Multi-Factor Robo-Advisor, and portfolio analytics into a single high-signal workspace — built for people who want algorithmic-grade tooling without a quant background.

- **Research** — scan crypto, stocks, and forex, sorted by signal score, top gainers, or top losers.
- **Build** — let the Robo-Advisor construct a signal-ranked portfolio from your capital and risk profile.
- **Simulate** — replay any allocation over the past year with the backtesting engine.
- **Monitor** — stream live Binance prices and get notified the instant a price crosses your target.

## Key features

| Feature | Description |
| --- | --- |
| 🔴 **Live Binance WebSockets** | Real-time crypto prices via the Binance all-market mini-ticker stream, with neon green/red price flashes on every tick. |
| 🕯️ **Canvas Candlestick Charts** | Hardware-accelerated `lightweight-charts` candlesticks with **SMA 50/200** and **RSI (14)** overlays, a synchronized RSI sub-chart, and pan/zoom — all toggleable without re-rendering the base chart. |
| 🧪 **1-Year Backtesting engine** | A pure, unit-tested engine that replays your current allocation against 365 days of daily Binance candles and reports the total return. |
| 🔔 **Real-time Price Alerts** | One unified pipeline: cloud-synced alerts for signed-in users (auto-deactivated in Supabase, RLS-protected), session-only alerts for guests; fires exactly once, never on stale or simulated prices. |
| 🔐 **Supabase Auth + RLS** | Email/password authentication with row-level security — portfolios and alerts are persisted per user. |
| 🤖 **Quant Robo-Advisor** | Deterministic multi-factor engine (RSI · MACD · ATR): signal-ranked, risk-weighted portfolio construction from user capital and a risk profile. |
| 📊 **Portfolio dashboard** | KPI cards, per-holding sparklines, allocation donut, and smart buy/sell suggestions. |

![Candlestick Chart Screenshot](link-here)
![Portfolio Dashboard Screenshot](link-here)

## Architecture & performance

ZeroChart is engineered for high-frequency market data without the usual React re-render churn:

- **`useSyncExternalStore` live-price store** — the Binance WebSocket writes batched ticks into a module-level store, and components subscribe per-symbol via `useLivePrice`. Unchanged symbols keep object identity, so **only the rows whose price actually changed re-render** — never the whole tree.
- **`React.memo` render isolation** — market rows and the portfolio dashboard are memoized, so a 600ms price tick never re-renders the page shell or sibling components.
- **`lightweight-charts` (Canvas)** — candlestick and backtest charts render on Canvas for smooth 60fps pan, zoom, and resize.
- **Pure, testable finance core** — backtesting (`computeBacktest`), allocation (`computeAllocation`), and indicators (`sma`, `rsi`) live in dependency-free modules with unit tests proving accuracy.

```
Binance WebSocket → setLivePrices (batched) → useSyncExternalStore → useLivePrice(symbol) → memoized <MarketRow/>
```

## Tech stack

TanStack Start (React 19 + Vite) · TypeScript · Supabase (Postgres + Auth + RLS) · lightweight-charts · Recharts (donut & sparklines) · Framer Motion · TanStack Query · Tailwind CSS v4 · lucide-react · next-themes · sonner · Vitest

## Project structure

```
src/
  components/     # UI: terminal shell, charts, dashboard, alerts, modals
  hooks/          # useBinanceWebSocket, usePriceAlerts, usePriceFlash
  lib/            # pure logic: backtestManager, indicators, allocation, livePriceStore
  integrations/   # Supabase client + auth middleware
  routes/         # TanStack Start file-based routes
  test/           # Vitest unit tests
supabase_alerts_schema.sql   # RLS-protected user_alerts table
```

## Quick start

**Prerequisites:** [Bun](https://bun.sh/) (recommended) or npm, and a [Supabase](https://supabase.com/) project.

```bash
git clone https://github.com/blackhebrewisraeli/ZeroChart.git
cd ZeroChart

# install dependencies
bun install        # or: npm install
```

Create `.env.local` with your Supabase project values:

```env
VITE_SUPABASE_URL=https://<your-project>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<sb_publishable_...>
# a legacy anon key is also accepted:
# VITE_SUPABASE_ANON_KEY=<your-anon-key>
```

Start the development server:

```bash
bun run dev        # or: npm run dev
```

Open the URL printed in the terminal (default `http://localhost:5173`).

### Database setup

1. Create the public `assets_status` table (see [docs/CONNECTION.md](./docs/CONNECTION.md)).
2. Run [`supabase_alerts_schema.sql`](./supabase_alerts_schema.sql) in the **Supabase SQL Editor** to create the RLS-protected `user_alerts` table.
3. Enable the email/password provider under **Authentication → Providers**.

## Scripts

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start the local development server |
| `bun run build` | Build the production bundle |
| `bun run test` | Run the Vitest test suite |
| `bun run lint` | Run ESLint |

## Testing

The finance core is covered by unit tests: backtesting math, SMA/RSI indicators, allocation percentages, price-alert thresholds, and live-price merging.

```bash
bun run test
```

## Documentation

- [Architecture & conventions](./docs/AGENTS.md)
- [Supabase connection setup](./docs/CONNECTION.md)
- [Roadmap](./docs/roadmap.md)

## License

Released under the MIT License.

<div align="center">

**ZeroChart — signal over noise.**

[Back to top](#zerochart)

</div>
