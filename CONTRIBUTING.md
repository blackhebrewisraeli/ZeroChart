# Contributing to ZeroChart

Thanks for helping out. This guide covers local setup, the standards every change is held to, and how to get a pull request merged.

## Development setup

1. Follow [Getting started](./README.md#getting-started) to clone the repo, install dependencies, create `.env.local`, and apply the database migrations.
2. Start the dev server with `npm run dev` and open [http://localhost:8080](http://localhost:8080).
3. Before you push, run the same checks as CI:

   ```bash
   npx tsc --noEmit && npm run build && npm run lint && npm test
   ```

## Coding standards

### Performance: keep the main thread free

- **Heavy math goes to the Web Worker.** Indicators, backtests, and any loop over a price series run in [`finance.worker.ts`](./src/lib/finance.worker.ts). Add a new request kind to the `FinanceRequest` union in [`financeCompute.ts`](./src/lib/financeCompute.ts) and expose it through an async helper in [`financeClient.ts`](./src/lib/financeClient.ts). Components never call that math synchronously.
- Only O(1) helpers over already-computed values, like `scoreFactors` or `recommendPositionSize`, may run on the main thread.
- Live prices flow through [`livePriceStore.ts`](./src/lib/livePriceStore.ts). Subscribe per symbol with `useLivePrice` so a tick re-renders only the rows that changed.

### Financial correctness

- **Engines are pure.** Code in `src/lib` that computes money, risk, or signals takes plain inputs, returns plain outputs, and has no React or network dependencies. Inject anything external, following the `QuantDeps` pattern in [`roboAdvisor.ts`](./src/lib/roboAdvisor.ts).
- **Every engine change ships with a test** in `src/test/`. Money and security paths need a test that fails if the logic breaks.
- **Ledger updates are atomic.** Change a portfolio only through the pure transitions in [`portfolioAccounting.ts`](./src/lib/portfolioAccounting.ts) (`applyBuyTransaction`, `applySellTransaction`, `applyCashTransaction`). Never mutate positions, cash, or transactions separately.
- **Keep the three ledgers isolated.** Live Tracking, Simulation, and Paper Trading never share positions or cash.
- **Never present sample or simulated data as live market data.** Label previews explicitly.
- **Keep the Pine HUD in step.** [`pine/zerochart_quant_hud.pine`](./pine/zerochart_quant_hud.pine) ports `indicators.ts`, `canonicalModel.ts`, and `risk.ts` (its sizing adds a configurable ATR stop multiplier that defaults to `risk.ts`'s 1×). A change to the model in one place lands in both. It recomputes RSI, MACD and ATR on the app's 200-bar window (model `1.0.0-pw200`); [docs/PINE_PARITY_ASSESSMENT.md](./docs/PINE_PARITY_ASSESSMENT.md) defines when the two are comparable. A Pine change that can move a score needs a new `MODEL_VERSION`, a migration that lets `execute_tactical_signal` accept it, and a fresh run of the in-Pine self-check. Don't call it parity-verified without that runtime evidence.

### Supabase and security

- Use the single browser client from [`@/lib/supabaseClient`](./src/lib/supabaseClient.ts). Don't add another `createClient` call to browser code.
- Every new table enables row-level security with owner-scoped policies. Add schema changes as a new file in [`supabase/migrations/`](./supabase/migrations).
- Only publishable keys belong in frontend code. Service-role keys stay in Edge Functions.
- Validate untrusted input at the boundary, as [`tv-webhook/payload.ts`](./supabase/functions/tv-webhook/payload.ts) does for TradingView alerts.

### UI

- Colors come from the semantic CSS tokens in [`styles.css`](./src/styles.css). Define each new token in both `:root` (light) and `.dark`. Signal greens, ambers, and reds must look the same in every view.
- Check every UI change in both light and dark mode, and at phone width.
- Keep Radix accessibility intact: keyboard navigation, focus management, and labels.
- Don't hand-edit generated files: `src/routeTree.gen.ts` and `src/integrations/supabase/types.ts`.

### Style

- Prettier and ESLint are the source of truth: `npm run format` and `npm run lint`.
- TypeScript runs in strict mode. Avoid `any` and non-null assertions; narrow types instead.
- Comments explain _why_, not _what_.

## Pull requests

1. Branch from `main` with a descriptive prefix: `feat/`, `fix/`, `test/`, `docs/`, or `refactor/`.
2. Write commit subjects in the imperative and describe the behavior change, for example `Keep resolved signals out of an in-flight backlog snapshot`.
3. Open the PR against `main` and complete the checklist in the [pull request template](./.github/pull_request_template.md).
4. CI must pass before merge.
5. A PR with migrations: apply them to production before you merge, as [docs/RELEASE.md](./docs/RELEASE.md) describes. Otherwise the production build refuses to go live.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](./LICENSE).
