# Paper-trading acceptance pass — 2026-10-27

A local end-to-end pass of the paper-trading workflow (tactical signal, Portfolio Builder, failure and recovery), run while production waits for its first natural daily `1.0.0-pw200` signal. Every number below comes from a local Supabase stack, a local app instance, a local test account and labeled synthetic data. No production user data, token or credential was used, and nothing was written to production.

Release under test: `main` at `8d5e0d5`, plus the two fixes in this PR.

## What this pass does and does not verify

| Kind                                               | What it covers                                                                                                                                                                                                                             | Status                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| **Local end-to-end**                               | Real local Supabase session (GoTrue issuer `http://127.0.0.1:55621/auth/v1`, role `authenticated`, no `?devAuth` stub), the local `tv-webhook` edge function, realtime, the booking RPCs and triggers, and the UI in the built-in browser. | Run. Results in the matrix.                           |
| **Production configuration** (read-only)           | The anon `release_contract()` call the build gate makes: the production database has all 27 migrations and every RPC this frontend calls. The production alias serves `dpl_6eRbehJvhDLKJoqjZCgzZaLuGaJD` = `8d5e0d5`.                      | Verified 2026-10-27. Nothing was written.             |
| **Production workflows awaiting a natural signal** | A real TradingView daily alert reaching production, its Action Center card, and the first production pw200 paper execution.                                                                                                                | Not exercised. No production signal was manufactured. |

## Setup

The repo is linked to production, so every `supabase` command runs from a scratch workdir with its own project id and ports. This keeps it away from the production link and from other local stacks.

```bash
W=<scratch dir>; R=<repo>
mkdir -p $W/supabase && cd $W
ln -s $R/supabase/migrations supabase/migrations
ln -s $R/supabase/functions supabase/functions
ln -s $R/supabase/tests supabase/tests
cat > supabase/config.toml <<'EOF'
project_id = "zcaccept"

[api]
enabled = true
port = 55621
schemas = ["public", "graphql_public"]
extra_search_path = ["public", "extensions"]
max_rows = 1000

[db]
port = 55622
shadow_port = 55620
major_version = 17

[db.pooler]
enabled = false

[db.seed]
enabled = false

[realtime]
enabled = true

[studio]
enabled = false

[inbucket]
enabled = false

[storage]
enabled = false

[analytics]
enabled = false

[auth]
enabled = true
site_url = "http://localhost:8082"
additional_redirect_urls = ["http://localhost:8082"]
jwt_expiry = 3600
enable_signup = true

[auth.email]
enable_signup = true
enable_confirmations = false

[edge_runtime]
enabled = true
policy = "per_worker"
inspector_port = 55623

[functions.tv-webhook]
verify_jwt = false
EOF
supabase start --workdir $W            # applies all 27 migrations
supabase test db --workdir $W          # 105 pgTAP tests
bash $R/supabase/tests/concurrency.sh postgresql://postgres:postgres@127.0.0.1:55622/postgres   # 8 races
curl -s -X POST http://127.0.0.1:55621/functions/v1/tv-webhook -d '{}'   # 401 auth_missing
```

The local vault has no `project_url`, so the scheduled price and analytics jobs cannot reach any remote project, and they never overwrite the synthetic rows.

Run the app against the local stack. **Override `VITE_SUPABASE_ANON_KEY` too.** `resolveSupabaseKey()` prefers it over the publishable key, and `.env` holds production's, so overriding only the URL and the publishable key sends production's anon key to the local stack:

```bash
KEY=$(supabase status -o env --workdir $W | sed -n 's/^PUBLISHABLE_KEY="\(.*\)"/\1/p')
VITE_SUPABASE_URL=http://127.0.0.1:55621 VITE_SUPABASE_ANON_KEY=$KEY VITE_SUPABASE_PUBLISHABLE_KEY=$KEY \
  VITE_SUPABASE_PROJECT_ID=zcaccept npx vite dev --port 8082 --strictPort
```

Before any mutation, confirm in the page that `import.meta.env.VITE_SUPABASE_URL` is `http://127.0.0.1:55621` and that every API request goes to that origin. Then sign up a throwaway `@example.test` account in the app, and take a webhook token from **Account → Manage webhook keys** (the Webhook URL field shows the local function URL). Keep the token and password in the scratch dir only.

### Synthetic data

Three synthetic crypto rows with `ZCT` tickers. They have no Binance market and no live WebSocket ticks, so the price on screen is the server's price:

```sql
insert into public.assets_status (ticker, current_price, change_24h, updated_at, atr_14, analytics_updated_at, stable_explanation)
values ('ZCTA-USD', 100, 0.01, now(), 1.4453, now(), 'SYNTHETIC acceptance fixture'),
       ('ZCTB-USD',  50, 0.01, now(), 0.7227, now(), 'SYNTHETIC acceptance fixture'),
       ('ZCTC-USD',  20, 0.01, now(), 0.2891, now(), 'SYNTHETIC acceptance fixture');
-- Quotes expire after 2 hours; bump them before each scenario.
update public.assets_status set updated_at = now(), analytics_updated_at = now() where ticker like 'ZCT%';
```

Signals are delivered the way TradingView posts them (`text/plain`), shaped like the Pine `webhookJson()`:

```bash
curl -s -X POST http://127.0.0.1:55621/functions/v1/tv-webhook -H 'Content-Type: text/plain' -d '{
  "signal_kind":"strategy","ticker":"ZCTAUSDT","action":"BUY","signal_score":81,"price":100,
  "quantity":20,"stop_loss":97.1094,"secret_token":"<local token>","event_id":"2026-10-27T07:20:00Z",
  "exchange":"ZC_SYNTHETIC","timeframe":"1D","bar_time":"2026-10-27T00:00:00Z","model_version":"1.0.0-pw200"}'
```

Since #97 a bar carries one logical event per action, so further same-ticker, same-action signals need another `bar_time`. Otherwise the webhook answers 409 `identity_conflict`, as designed.

**Eligible Portfolio Builder fixture.** The Quant Analyzer scores Binance daily klines in the browser, and Binance has no `ZCT` markets. A page-level `fetch` override, pasted into the browser console and labeled `SYNTHETIC FIXTURE`, serves 200 Binance-shaped daily candles for `ZCTAUSDT`, `ZCTBUSDT` and `ZCTCUSDT`. In the _eligible_ mode, a long 0.5%/day decline followed by a 6-day 1%/day bounce scores **81** (TRENDING) in the canonical engine. In the _ineligible_ mode, a steady 0.5%/day rise scores **33**. Both were scored with `evaluateCandles` before use, and no threshold was changed.

```js
function zcFixtureKlines(symbol, nowMs, limit, mode) {
  const DAY = 86400000,
    base = { ZCTAUSDT: 100, ZCTBUSDT: 50, ZCTCUSDT: 20 }[symbol];
  if (!base) return null;
  const step = (k) => (mode === 'ineligible' ? 1.005 : k < 6 ? 1.01 : 0.995);
  const today = Math.floor(nowMs / DAY) * DAY;
  let close = base;
  for (let k = 0; k < limit - 1; k++) close /= step(k);
  return Array.from({ length: limit }, (_, i) => {
    const k = limit - 1 - i,
      open = close;
    if (i > 0) close = open * step(k);
    const t = today - k * DAY;
    return [
      t,
      open.toFixed(8),
      (Math.max(open, close) * 1.004).toFixed(8),
      (Math.min(open, close) * 0.996).toFixed(8),
      close.toFixed(8),
      '1000',
      t + DAY - 1,
    ];
  });
}
const real = window.fetch;
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://api.binance.com/api/v3/klines')) {
    const q = new URL(url).searchParams;
    const rows = zcFixtureKlines(
      q.get('symbol'),
      Date.now(),
      Number(q.get('limit')),
      window.zcMode,
    );
    if (rows) return new Response(JSON.stringify(rows), { status: 200 });
  }
  return real(input, init);
};
```

**Lost responses** were simulated the same way. The override sends the request, waits until the server has committed and answered, and then throws `TypeError('Failed to fetch')` in place of the response.

## Acceptance matrix

"Existing" names the automated coverage that was already in the repo, and "Local evidence" is what this pass observed.

| #   | Scenario                                                 | Existing coverage                                                              | Local evidence                                                                                                                                                                                                                                       | Result                 |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| A1  | Deliver a daily pw200 strategy signal                    | `tvWebhookHandler`, `tvWebhookPayload`, `ingest_tradingview_signal.test.sql`   | 201 accepted; a redelivery returns 200 `duplicate`; one PENDING row with exchange, timeframe `1D`, bar time and `1.0.0-pw200`                                                                                                                        | PASS                   |
| A2  | Metadata and display in the Action Center                | `actionCenter.test.tsx` (provenance, realtime card)                            | Arrived over realtime with no reload: score 81/100, 20 units, $2,000.00 notional, stop $97.11, "Source: ZC_SYNTHETIC · 1D · model 1.0.0-pw200", the no-automatic-stops note                                                                          | PASS                   |
| A3  | Execute an eligible BUY through the UI                   | `actionCenter.test.tsx`, `execute_tactical_signal.test.sql`                    | One fill: BUY 20 @ $100, fee $5.00, linked to the signal, stop recorded; signal EXECUTED; cash $100,000.00 → $97,995.00                                                                                                                              | PASS                   |
| A4  | Refresh and verify persistence                           | `portfolioCash`, `paperLedger`                                                 | After a reload: same cash, position and ledger; the executed card stays gone                                                                                                                                                                         | PASS                   |
| A5  | SELL against a two-lot position                          | `paperLedger` (FIFO replay), SQL holdings check                                | SELL 25 ZCTA @ $103 crossed both FIFO lots: realized +$47.28; 19.21131636 units left at $103.00; cash +$2,568.56                                                                                                                                     | PASS                   |
| B1  | Proposal from the eligible fixture                       | `roboAdvisorModal`, `roboAdvisorExecution`, `execute_paper_portfolio.test.sql` | Moderate, $10,000: three holdings at 25.0% / $2,500.00; server plan = independent calculation (see below)                                                                                                                                            | PASS                   |
| B2  | Review allocation, retained cash, fees, risk             | as B1                                                                          | Units 24.45 / 49.88 / 124.7, $6.23 fee each, $7,500.00 spent, $2,500.00 of the budget stays in Paper Cash, risk at stops $301.58 of a $6,001.95 cap                                                                                                  | PASS                   |
| B3  | Confirm in the UI; receipt against the ledger            | `roboAdvisorExecution`                                                         | One batch, three fills, 0 receipt/ledger mismatches; cash rebuilt from the rows = receipt `cash_after`                                                                                                                                               | PASS                   |
| B4  | No qualifying assets                                     | `roboAdvisorModal` ("legitimate no-eligibility")                               | Ineligible fixture: "No qualifying assets", profile Moderate, minimum 60/100, "Nothing was booked. Your Paper Cash is unchanged.", with Review configuration / Retry analysis / Open Paper Desk                                                      | PASS                   |
| C1  | Double-click Execute                                     | `actionCenter` (repeated clicks), `concurrency.sh`                             | One RPC, one fill; re-checked after the D3 fix                                                                                                                                                                                                       | PASS                   |
| C2  | Double-click Confirm                                     | `roboAdvisorModal`, `concurrency.sh`                                           | One booking request, one batch                                                                                                                                                                                                                       | PASS                   |
| C3  | Retry the same request                                   | SQL replay tests                                                               | Tactical: refused as "Signal is no longer waiting", no fill. Portfolio: the same request ID returns the original receipt with `replayed: true` and no fills                                                                                          | PASS                   |
| C4  | Tactical: server commits, response lost                  | none before this PR                                                            | **D1**: the UI showed "TypeError: Failed to fetch" although the fill was booked. Fixed; after the fix the UI shows the booked fill and the right cash                                                                                                | FAIL → fixed           |
| C5  | Portfolio: server commits, response lost                 | `roboAdvisorExecution` (reconcile by request ID)                               | Reconciled under the same request ID and showed the receipt; nothing left in local storage                                                                                                                                                           | PASS                   |
| C6  | Close the dialog and reload while a booking is unsettled | `roboAdvisorExecution` (reload, reopen)                                        | Booking committed while the answer and the check were both lost ("Couldn't reach the server…", Check again). After close and reload: "Your earlier Quant Analyzer request booked 3 orders · Receipt 6b639946"; one batch                             | PASS                   |
| C7  | Stale quote                                              | SQL (stale price, stale ATR)                                                   | Tactical, UI: the server's message ("…over 2 hours old…"), card stays. Portfolio, UI: "Can't book this proposal: …", Confirm disabled, Adjust available. API: a 49-hour-old ATR is refused                                                           | PASS                   |
| C8  | Price moved: new preview required                        | `roboAdvisorExecution` (PT409), SQL                                            | Portfolio: ZCTA 102 → 103 after the preview → "Not booked: Prices or sizes moved more than 0.5%…", refreshed plan (24.21 @ $103), fresh Confirm booked. Tactical: the 0.5% band message, then the retry after the next 60 s refresh filled at $20.20 | PASS                   |
| C9  | Insufficient cash                                        | `actionCenter` (unaffordable), SQL                                             | Tactical: Execute disabled with "Not enough cash: this order needs $100,250.00, $91,558.56 available." Portfolio: the build refused with "Available Paper Cash is $92,061.06."; API messages for both                                                | PASS                   |
| C10 | Insufficient holdings                                    | SQL                                                                            | UI: "Only 19.21 ZCTA-USD units are available to sell", no RPC. API: "Insufficient shares"                                                                                                                                                            | PASS                   |
| C11 | Unauthorized requests                                    | SQL access tests                                                               | anon → 401 (both RPCs); another `user_id` → 403; flipping an executed signal back → 0 rows; bad webhook token → 401; bad `signal_kind` → 400                                                                                                         | PASS                   |
| C12 | Rejections leave no partial mutation                     | SQL rollback tests                                                             | Before and after each rejection batch: same fill count, cash and PENDING signals                                                                                                                                                                     | PASS                   |
| U1  | Desktop and phone (375 px) layouts, light and dark       | —                                                                              | No page-level horizontal scroll; the ledger table scrolls in `.ledger-scroll`; the analyzer is a full-width sheet with a sticky Adjust / Simulate footer                                                                                             | PASS                   |
| U2  | Keyboard navigation                                      | `dialogFocus`                                                                  | Analyzer: Tab wraps inside the native `<dialog>`, Escape returns focus to the trigger. Action Center: **D3**, focus fell to `<body>` after Dismiss or Execute with signals still queued. Fixed                                                       | FAIL → fixed           |
| U3  | Pending states, error text, recovery actions             | as above                                                                       | Booking states, server reasons, Check again, Adjust, Retry analysis; D2 below is the exception                                                                                                                                                       | PASS; D2 fixed in #100 |
| R1  | Client risk preview agrees with the server               | `paperRiskPolicy` (constants only)                                             | **D2**: Action Center and Trade Ticket can block BUYs the server accepts                                                                                                                                                                             | FAIL → fixed in #100   |

## Financial invariants

The expected values were computed separately with Python `Decimal` from the policy constants (0.25% fee, 2×ATR stop, 2% per-holding risk, 25% / 10% caps, units floored to 1e-8). They match the UI, the receipts and the ledger:

| Step                                                                             | Independent expectation                                                                                                                              | Booked                                                                                      |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Tactical BUY 20 ZCTA @ 100                                                       | fee 5.00, cash 97,995.00                                                                                                                             | fee 5.0000, cash 97,995.00                                                                  |
| Moderate $10,000 after PT409                                                     | ZCTA `floor(2500 / (103 × 1.0025))` = 24.21131636; ZCTB 49.87531172; ZCTC 124.6882793; fees 6.234414 each; spent 7,499.999999                        | identical in the receipt and the three fills                                                |
| SELL 25 ZCTA @ 103 (lots: 20 @ 100 + 5.00 fee; 24.21131636 @ 103 + 6.234414 fee) | sell fee 6.4375; basis sold 2,000 + 5 + 5 × 103 + 6.234414 × 5 / 24.21131636 = 2,521.2875; realized 47.275; 19.21131636 left at a 1,983.712499 basis | realized +$47.28; 19.21 left at an average $103.00; unrealized −$4.95 (the unrecovered fee) |
| Whole ledger (13 rows)                                                           | cash = 100,000 − Σ BUY (qty × price + fee) + Σ SELL (qty × price − fee)                                                                              | 84,841.807502 = `paper_account_book().cash`                                                 |

Final cross-checks: every EXECUTED signal has exactly one linked fill (0 violations), no fill is linked to a non-executed signal (0), every batch receipt's `spent` equals its fills (0 mismatches), and every rejected operation left the ledger unchanged.

**Planned versus booked size.** The analyzer weights by score and caps each weight at the profile's `maxAllocation`, without redistributing the capped excess. With three equal scores and Moderate's 25% cap, $2,500.00 of the $10,000 budget (25%) stays in Paper Cash; under Conservative, 70% stays. The server then sizes each order at the smallest of three limits: the allocation after fees, 2% of the budget at a 2×ATR stop, and the budget left. It floors units to 1e-8, so a holding books $2,499.999999 rather than $2,500.00. Here the allocation bound every order, so the client's "suggested size" equals the booked units. Once a plan is priced, the row shows the server's units. The ATR stop is a sizing assumption stored on the fill (`stop_price`). **Paper Trading places no stop orders, and nothing sells when the price crosses it.**

## Defects

### D1 — a lost tactical response hides a booked fill (fixed)

- **Trigger:** Execute on a tactical signal; `execute_tactical_signal` commits, and the response never arrives.
- **Expected:** the UI shows the fill and the new Paper Cash, and books nothing twice.
- **Observed:** a "TypeError: Failed to fetch" toast. Realtime removed the card (the signal was EXECUTED), but the Paper Desk kept showing the old cash and positions until a reload, so the user was told a booked trade had failed. A retry is refused as "no longer waiting", with the same stale view. Nothing was booked twice.
- **Fix:** when the RPC errors, `ActionCenter` looks up the fill linked to the signal (`paper_transactions.signal_id`, exactly one per executed signal). If it exists, the signal is treated as booked: the ledger is reloaded, and the success toast reports the booked price. Otherwise the error is shown as before.
- **Regression test:** `shows a fill the server committed when its response was lost, without booking it again` (fails without the fix).
- **Re-run:** ZCTC BUY with the response dropped → "Bought $500.00 of ZCTC-USD", cash $96,992.50, one fill.

### D3 — keyboard focus lost after an Action Center action (fixed)

- **Trigger:** with two or more signals queued, press Enter on Dismiss (or Execute).
- **Expected:** focus stays in the card, which now shows the next signal.
- **Observed:** focus fell to `<body>`, because the pressed button became `disabled` while the request was out.
- **Fix:** while busy, the buttons are `aria-disabled` and their handlers return early. `disabled` is kept only for an Execute that the risk manager or provenance blocks. The busy style covers `[aria-disabled='true']`.
- **Regression test:** `keeps the pressed button focusable while a request is out, so focus stays on the queue`.
- **Re-run:** after Enter on Dismiss, focus moved to the next card's Dismiss. A double-click on Execute still sent one RPC.

### D2 — the client risk preview can block BUYs the server accepts (fixed in #100)

- **Trigger:** a Paper Trading position whose ATR the browser can't load. This is every stock and forex position (the browser has no candle source for them), and any crypto position whose Binance klines fetch failed. `scoreTicker` turns that failure into a non-throwing result, which react-query keeps for 5 minutes.
- **Expected:** the Aggregate Open Risk shown, and the Action Center and Trade Ticket gate, agree with `paper_account_book()`, which uses the server's `atr_14` for every asset class.
- **Observed:** `usePaperRisk` counts that position's whole entry as risk. With a $6,500 synthetic stock position the UI showed **6.7%** and disabled Execute ("Portfolio max risk reached: 6.7% open + 0% new would pass the 6% limit."). The server's book was **0.44%** and would have accepted the BUY. Earlier, with the crypto candles failing, it showed 8.0% against the server's 0.30%.
- **Why it wasn't fixed in #99:** closing it meant choosing where the client gets its risk book: the server's `atr_14` (not in the assets select then), the `stop_price` stored on fills, or a server-side risk preview. Every option changes all three callers. The client erred on the side of blocking, and the server stayed authoritative, so no unsafe fill could result.
- **Decision and fix ([#100](https://github.com/blackhebrewisraeli/ZeroChart/pull/100), merged as `c82e19e`):** the owner chose the server's `atr_14`. `fetchAssets` now selects `atr_14` and `analytics_updated_at`. When the browser has no ATR, `usePaperRisk` uses the row's `atr_14` while it is under 48 hours old (`MAX_SERVER_ATR_AGE_MS`, the server's `max_atr_age`). A ticker with neither still risks its whole entry, as on the server. This covers the open book and `checkBuy`, so the Action Center, Trade Ticket and Paper Desk all changed. No server check, migration or limit changed.
- **Regression test:** `paperTradingTerminal.test.tsx`: a $1,000 ETH position with no browser ATR and a 1-hour-old server `atr_14` of 50 shows `$52.63 to stops`; at 49 hours old it shows the whole `$1,000.00`, like the server. It failed before the fix. `paperRiskPolicy.test.ts`pins the 48-hour constant to`paper_risk_policy()`.
- **Re-run (local, #100):** a synthetic `ZCTS` stock row (price 100, fresh `atr_14` 1.5) and a $6,500 BUY on a throwaway `@example.test` account. `paper_account_book()` = 0.195% / $195.00. The Paper Desk showed **0.2%, "$195.00 to stops · 6% cap"**, and "Add 25% to ZCTS" was enabled. Before the fix the same position counted as 6.5%.

## Other observations

Recorded with no change in this pass. Their outcomes are in [Follow-up: pre-trade review](#follow-up-pre-trade-review--2026-10-27).

- **O1.** `formatShares` shows 2 decimals for 1–100 units, so 1.99501247 ZCTB reads "2" next to a $100.00 cost. The ledger and the costs are exact. **Fixed in the follow-up.**
- **O2.** A tactical SELL larger than the holding shows its reason only after Execute is pressed (a toast), while BUY rejections disable Execute with the reason inline. It works, but it is inconsistent. **Fixed in the follow-up.**
- **O3.** A Portfolio Builder plan that failed to price (a stale quote) doesn't re-price on its own once the quote is fresh. Adjust → Build re-prices it. **Fixed in the follow-up** with an explicit Reprice action, not an automatic one.

## Test results

- `supabase test db`: 105/105. `concurrency.sh`: 8/8 (local stack, main `8d5e0d5`).
- `npx tsc --noEmit`, `npm run lint`, `npm run build`: clean. `npm test`: 603/603 in 74 files, with the two new regression tests.

## Follow-up: pre-trade review — 2026-10-27

Closes O1–O3, so that before confirming a paper trade the owner can see the quantity, the cost or proceeds, what blocks it, and how to recover. Branch `fix/pre-trade-review` on `main` at `c82e19e` (#99 and #100 merged). The evidence above is unchanged and still dates from `8d5e0d5`.

| Kind                 | What it covers                                                                                                                                                                                                                                                  | Status                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Local end-to-end** | A separate local stack (`project_id = "zcreview"`, ports 55720–55723, app on 8083, otherwise the setup above), a real local session (issuer `http://127.0.0.1:55721/auth/v1`, role `authenticated`, no `?devAuth`), the local `tv-webhook` and the booking RPCs | Run. Results below.                                           |
| **Production**       | None of this                                                                                                                                                                                                                                                    | Not exercised. Nothing was deployed or written to production. |

Synthetic data: the three `ZCT*-USD` rows from [Synthetic data](#synthetic-data), labeled `SYNTHETIC review fixture`, the same eligible klines fixture, and a throwaway `@example.test` account. Lost answers were simulated in the page: the request reached the server and committed, and only its response was replaced with `TypeError('Failed to fetch')`.

### What changed

- **O1, quantities.** `formatShares` writes a quantity at the ledger's 1e-8 precision with trailing zeros trimmed, so a planned or booked quantity reads as booked. A browser-side value finer than 1e-8 reads `≈`, and `<Shares>` puts its stored value in the tooltip and gives it to screen readers. (Trade Ticket and Paper Desk ±25% sizes are not floored; that is unchanged.) Positive dust reads `<0.00000001`, never 0. Portfolio Builder sizes read "Suggested size" (browser estimate), then "Planned" (server-priced), then "Booked" (receipt), and the orders table's header reads "Planned units" or "Booked units". Success toasts name the units the server booked. No calculation, floor or stored value changed.
- **O2, SELL eligibility.** One rule, `checkSell`, uses the `exceedsHolding` test that `applySellTransaction` now shares, with `check_paper_transaction`'s 1e-9 tolerance. It disables the Action Center's Execute and the Paper Trading ticket's Sell, with the reason inline, before anything is sent, and it re-evaluates whenever the paper ledger changes. It never shortens the order and adds no short selling. The server check is unchanged and has the final say.
- **O3, repricing.** Signed in, the Orders panel has a **Reprice** button. It prices the same proposal again (same budget, risk profile, holdings and request ID) as a dry run, so it books nothing, and Confirm stays disabled until that plan arrives. After a reprice, the panel says whether the plan changed since the owner last saw it and marks each changed row with its previous units and price. Reprice is unavailable while a booking is out or its outcome is unknown: reconciliation by request ID (Check again) comes first. Nothing reprices or confirms on its own.
- **Found on the way.** Two presses of the paper ticket's Sell before React re-rendered booked two fills: the guard read `booking` state from a stale render. A ref now guards it, as `useProposalExecution` does.

| Quantity           | `main` `formatShares` | This branch                                             |
| ------------------ | --------------------- | ------------------------------------------------------- |
| 1.99501247         | `2`                   | `1.99501247`                                            |
| 1.99999999         | `2`                   | `1.99999999`                                            |
| 124.6882793        | `124.7`               | `124.6882793`                                           |
| 0.04987531         | `0.0499`              | `0.04987531`                                            |
| 0.00004            | `0`                   | `0.00004`                                               |
| 0.00000001         | `0`                   | `0.00000001`                                            |
| 2.4292296630859376 | `2.43`                | `≈2.42922966`, exact value in tooltip and screen reader |

### Local evidence

| #   | Scenario                                        | Local evidence                                                                                                                                                                                                                                                                                                                              | Result |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| P1  | Quantity near a whole unit                      | Action Center BUY of 0.99501247 ZCTA: the card read "0.99501247 units" (`main`: "0.995"), and the toast "Booked 0.99501247 ZCTA-USD at $100.00"                                                                                                                                                                                             | PASS   |
| P2  | Proposed versus executed                        | Analyzer rows: "Suggested size 25 units" before pricing, "Planned 24.93765586 units" once priced, "Booked 24.69074837 units" on the receipt; header "Planned units" then "Booked units". Ticket toast: "1.5 ZCTA-USD ($150.00) at $100.00 · fee $0.375"                                                                                     | PASS   |
| P3  | Precision finer than the ledger's               | Four Paper Desk +25% adds stored `0.2487531175` … `0.48584593261718756`. The position read "≈2.42922966", with 2.4292296630859376 in the tooltip and screen-reader text                                                                                                                                                                     | PASS   |
| P4  | Action Center SELL above the holding            | SELL 2 against 0.99501247 held: Execute disabled and described by "Only 0.99501247 ZCTA-USD available to sell.", no RPC. Each +25% add updated the reason ("Only ≈1.24376559 …") until Execute enabled at 2.42922966. After a reload with no position: "No open ZCTA-USD position to sell."                                                 | PASS   |
| P5  | Trade Ticket SELL above the holding             | 1.5 ZCTA held, Sell $200: Sell disabled, "Only 1.5 ZCTA-USD available to sell ($150.00).", focus stayed in the amount field and the amount was kept. At $100 it enabled                                                                                                                                                                     | PASS   |
| P6  | Server refusal after the client check passed    | The same account sold all 2.42922966 from another session; this tab still had Execute enabled. A double-click sent one `execute_tactical_signal` (400): toast "Insufficient shares", card kept, focus kept on Execute, signal still PENDING, no linked fill                                                                                 | PASS   |
| P7  | Proposal that can't be priced, then Reprice     | ZCTA quote 3 hours old: "Can't book this proposal: ZCTA-USD's server price is over 2 hours old…", Confirm disabled, Reprice and "Your budget, risk profile and holdings are kept…". Quote refreshed, Enter on Reprice: priced, focus stayed on Reprice, Confirm enabled only then                                                           | PASS   |
| P8  | A repriced plan that changed                    | ZCTA 100 → 101, Reprice: "Repriced: this plan changed since you last saw it. Review the marked rows before you confirm." ZCTA marked "was 24.93765586" and "was $100.00". Nothing booked until Confirm. Every dry run carried request `031a5a8f`, $10,000, Moderate, 3 × $2,500                                                             | PASS   |
| P9  | Unknown booking outcome stays in reconciliation | Double-click Confirm: one booking request (`expected` = the repriced plan). Its answer and the first check were dropped after the commit: "Couldn't reach the server…", Confirm disabled, Reprice `aria-disabled`, two Reprice presses sent no request. Check again: receipt `031a5a8f`, its three fills equal to it, no local storage left | PASS   |
| P10 | Layouts and themes                              | Desktop and 375 px, light and dark: Action Center card, ticket sheet, analyzer. No page-level horizontal scroll (scroll width 375 at 375); the orders table scrolls in `.robo-plan-scroll`, as before                                                                                                                                       | PASS   |

### Test results (follow-up)

- `npx tsc --noEmit`, `npm run lint`, `npm run build`: clean. `npm test`: 622/622 in 74 files, with CI's placeholder Supabase env.
- `supabase test db`: 105/105. `concurrency.sh`: 8/8 (local `zcreview` stack, this branch; no migration changed).
- The new tests cover quantities at whole-unit boundaries and tiny holdings, planned versus booked labels, inline SELL reasons and their updates, a server refusal after the client check passed, Reprice with the configuration kept, change marking, no Reprice while an outcome is unknown, and double-click and keyboard focus. Each new guard was removed once to confirm its test fails.

### Remaining limitations

- The inline SELL check covers Paper Trading, where BUY checks were already inline. A Simulation or Live Tracking SELL above the holding is still refused by a toast after Sell is pressed.
- Browser-side sizes (Trade Ticket, Paper Desk ±25%) keep their unfloored quantities, so they read `≈`. Flooring them would change stored values, which was out of scope.
- The tooltip isn't reachable on touch screens. The exact value stays in the screen-reader text.
- The "changed since you last saw it" comparison lasts as long as the dialog. After a reload there is no earlier plan to compare with.
- Production is unverified for all of the above.
