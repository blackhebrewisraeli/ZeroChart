# Decision & Execution Journal

The Paper Desk's **Signal Journal** tab lists each TradingView tactical signal with what is recorded about it: where it came from, its current status, and the paper fill linked to it. It is read-only. It has no Execute or Dismiss button. Trades still go through the Action Center and its review.

The journal only shows facts the database recorded. When a fact was never stored, the journal says **Not recorded**. It doesn't reconstruct facts from other data.

## Inventory

### What is already recorded

| Fact                                       | Where                                                                   | Since                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Asset, side, score, quantity, stop         | `trading_signals`                                                       | The first table (`20261020120000`)                                                 |
| Signal price, delivery ID                  | `trading_signals.price`, `event_id`                                     | `20261020180000`. Earlier rows have neither                                        |
| Exchange, timeframe, bar time, model       | `trading_signals`                                                       | `20261022120000`. Earlier alerts have none                                         |
| Signal kind                                | `trading_signals.signal_kind`                                           | `20261022120000`. Null is an unverified legacy row                                 |
| Server receipt time                        | `trading_signals.created_at`                                            | Always                                                                             |
| Current status                             | `trading_signals.status`                                                | Always. One value, no history                                                      |
| Linked fill: quantity, price, fee, booking | `paper_transactions` with `signal_id`                                   | `20261022090000`. One fill per signal at most (`paper_transactions_signal_id_idx`) |
| One row per logical event                  | `trading_signals_logical_event_idx`, `trading_signals_legacy_event_idx` | `20261027130000`                                                                   |

### What is not recorded

| Fact                                              | Why it's missing                                                                                                                                                                                                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider event time                               | No column holds it. Current Pine payloads put TradingView's `timenow` in `event_id`, but that's a delivery ID. tv-webhook fills it with the receipt minute when it's missing, and only the first accepted delivery is kept. The journal never reads it as a time |
| When or why a signal was dismissed                | Dismissal only sets `status`. There is no timestamp, actor or reason column                                                                                                                                                                                      |
| Execution attempts and rejections                 | `execute_tactical_signal` raises on a failed check, which rolls back everything. A refused attempt leaves no row                                                                                                                                                 |
| The risk checks that applied at decision time     | The client checks in `usePaperRisk` and the server checks in `check_paper_transaction` are not saved. The journal can't say which checks a past decision passed                                                                                                  |
| The price the Action Center showed (the preview)  | Not stored. Only the price sent with the execution request is stored, as the fill price                                                                                                                                                                          |
| Whether a fill was recovered by reconciliation    | `ActionCenter` checks `paper_transactions.signal_id` after a lost response (#99, D1). That check runs in the browser and writes nothing, so a recovered fill looks like any other                                                                                |
| Duplicate deliveries                              | A duplicate is answered `duplicate` and not stored                                                                                                                                                                                                               |
| Fills of signals executed before `20261022090000` | The client booked those fills itself and then set the status, so the fill has no `signal_id`. The fill is in the Trade Ledger but not linked to its signal                                                                                                       |

None of these are backfilled. Recording them in future is the [next increment](#next-increment).

## Evidence-field map

| Journal field                 | Source                                                   | Meaning                                                               | Limitations                                                                                       |
| ----------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Asset                         | `trading_signals.ticker`                                 | The symbol TradingView sent, such as `BTCUSDT`                        | The fill can book under the scanner's ticker (`BTC-USD`). The journal shows both                  |
| BUY / SELL                    | `trading_signals.action`                                 | The alert's side                                                      |                                                                                                   |
| Kind                          | `trading_signals.signal_kind`                            | `strategy` or `transport_test`                                        | Null on legacy rows: not recorded and not verified                                                |
| Exchange, timeframe, model    | `trading_signals.exchange`, `timeframe`, `model_version` | What the alert said about its source                                  | The alert's claim. Null on alerts set up before `20261022120000`                                  |
| Bar time                      | `trading_signals.bar_time`                               | Open time of the bar that fired, from the Pine payload                | Null on legacy alerts                                                                             |
| Provider event time           | none                                                     | Always **Not recorded**                                               | See [Inventory](#what-is-not-recorded)                                                            |
| Delivery ID                   | `trading_signals.event_id`                               | The first accepted delivery's ID                                      | An identifier, not a time. Null before `20261020180000`                                           |
| Server receipt                | `trading_signals.created_at`                             | When the database accepted the delivery                               |                                                                                                   |
| Signal price                  | `trading_signals.price`                                  | The bar's close when the alert fired                                  | Null before `20261020180000`                                                                      |
| Score, quantity, planned stop | `signal_score`, `quantity`, `stop_loss`                  | As the alert sent them. Quantity is in units                          | The score is the model's, not a probability                                                       |
| Recorded status               | `trading_signals.status`                                 | The current value                                                     | No history and no timestamps                                                                      |
| Linked fill                   | `paper_transactions` where `signal_id` = the signal      | The fill `execute_tactical_signal` booked                             | Only since `20261022090000`                                                                       |
| Executed quantity, price, fee | `paper_transactions.quantity`, `price`, `fees`           | The stored values. Quantities use the Trade Ledger's precision (#101) | A paper fill at the server-checked price. It does not show what a real exchange would have filled |
| Booked as                     | `paper_transactions.ticker`                              | The ticker the fill booked under                                      |                                                                                                   |
| Fill time                     | `paper_transactions.created_at`                          | When the fill booked, stamped after the account lock                  |                                                                                                   |
| Signal-to-fill price change   | (fill price − signal price) ÷ signal price               | How far the price moved between the alert and the fill                | Includes market movement and the time before the owner acted. Not execution slippage              |
| Receipt to booking            | fill time − server receipt                               | How long the signal waited before it was executed                     |                                                                                                   |
| Reconciliation recovery       | none                                                     | Never shown                                                           | See [Inventory](#what-is-not-recorded)                                                            |

## Journal states

Each signal gets one state, worked out from its row and its linked fills in `src/lib/decisionJournal.ts`:

| State                     | When                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| **Awaiting user action**  | `PENDING`, kind `strategy`, no linked fill                                                 |
| **Dismissed**             | `DISMISSED`, no linked fill                                                                |
| **Executed**              | `EXECUTED` with exactly one linked fill that matches the signal                            |
| **Outcome unresolved**    | `PENDING` transport test or unverified legacy signal: the app never offers an action on it |
| **Evidence inconsistent** | Anything else, with the reasons listed (below)                                             |

A `PENDING` signal is never labeled as rejected: no rejection is recorded. When the journal can't load, it shows an error and no entries. It never shows a guessed outcome.

Inconsistencies the journal reports:

- `EXECUTED` with no linked fill. Expected for signals executed before `20261022090000`.
- A linked fill on a `PENDING` or `DISMISSED` signal.
- More than one linked fill.
- A linked fill whose side or quantity differs from the signal, or that booked under an unrelated asset.
- A fill booked before the signal was received.

A row with any of exchange, timeframe, bar time or model missing is also marked **Provenance incomplete**.

## Data access and security

- One PostgREST request per page through the browser's existing client and session: `trading_signals` with its `paper_transactions` embedded through the `signal_id` foreign key. Both tables' existing owner-only `SELECT` policies apply, so the database filters both. The journal also filters by `user_id`, but it doesn't rely on that.
- Signals and fills come from one statement, so one snapshot. Two requests could read a signal as `PENDING`, then its fill after an execution in between, and report a false inconsistency.
- The query names its columns. It reads neither `signal_webhook_tokens` nor any payload, and `trading_signals` stores no token or raw payload.
- Pages of 25, newest server receipt first, with keyset pagination on `(created_at, id)`. New signals or a status change during paging can't repeat or skip a row.
- No migration and no `SECURITY DEFINER` function. `supabase/tests/decision_journal.test.sql` runs the same read as an authenticated user and checks isolation, duplicate deliveries and retried executions.
- Filters run on the server: the recorded status exactly, and the asset as a fragment of the ticker. The fragment keeps only ticker characters, so it can't carry a `LIKE` wildcard.
- Times show in the browser's time zone with the zone named, because a daily bar's 00:00 UTC open reads differently on either side of a DST change. The stored ISO value is the tooltip.

## Verification — 2026-10-28

Local only. Nothing was written to production: no migration, deploy, TradingView change or production trade.

**Automated, collected by CI**

| Command                                                                     | Result                                      |
| --------------------------------------------------------------------------- | ------------------------------------------- |
| `npm run typecheck`, `npm run build`, `npm run lint` (CI's placeholder env) | Pass. The release gate skips outside Vercel |
| `npm test -- --coverage`                                                    | 76 files, 651 tests. 29 of them are new     |
| `supabase test db` (isolated stack)                                         | 6 files, 121 assertions. 16 are new         |

`src/test/decisionJournal.test.ts` covers each state, legacy omissions, every inconsistency rule, the price change and elapsed time, the summary, the asset filter and the page query (named columns, embedded fills, keyset filter, no recount after page one). `src/test/decisionJournalView.test.tsx` covers loading, error with no entries, empty versus filtered-empty, server-side filters, Load older, the signed-out and `?devAuth` states, and that the only button is Refresh. `supabase/tests/decision_journal.test.sql` covers a redelivery with another attempt ID (one row), a retried execution (refused, one fill), the owner's linked amounts, and refusal of another owner's signals and fills, of token hashes, and of anon reads. Loosening the fill or the signal read policy fails 1 and 3 of its assertions.

**Isolated stack with real local sessions**

A scratch Supabase stack (`project_id = "zcjournal"`, API on 55921), set up as in [PAPER_TRADING_ACCEPTANCE.md](./PAPER_TRADING_ACCEPTANCE.md#setup), and `vite dev` on 8084 pointed at it. Two throwaway `@example.test` accounts signed in through the app's own sign-in form, not `?devAuth`. Data was labeled synthetic: `ZCT*` tickers, exchange `ZC_SYNTHETIC`, `SYN-*` and `SYNTHETIC-*` event IDs. Signals went through the local `tv-webhook` with each account's minted token. Executions and dismissals used each account's JWT. Two kinds of row came from the database superuser: 30 pending signals inserted in one statement, so they share one `created_at`, and legacy-shaped rows. One contradiction (a fill linked to a dismissed signal) was also injected that way, since no client or RPC path can create one.

| Check                                      | Result                                                                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Redelivery with another attempt ID         | `{"ok":true,"duplicate":true}`. The journal shows one signal                                                                |
| Retried execution                          | `23514 Signal is no longer waiting`. One linked fill                                                                        |
| Executing the other account's signal       | `P0002 Signal not found`                                                                                                    |
| Linked amounts                             | 0.99501247 units at $100.42, fee 0.2497978805935 (= quantity × price × 0.0025), booked as `ZCTA-USD`                        |
| Comparison                                 | Signal $100.00 → fill $100.42: +0.42%. Receipt to booking 17 s, matching the stored times                                   |
| Paging through 37 signals                  | 2 pages, 37 unique IDs, strictly newest first across the 30-row `created_at` tie, total 37                                  |
| A new signal and a dismissal between pages | Page two returned the 7 remaining rows: none repeated, none skipped                                                         |
| Filters                                    | Dismissed: 4 of 4, all `DISMISSED`. Asset `ZCTB`: 3, all `ZCTBUSDT`                                                         |
| Account A reading B (and B reading A)      | `loadJournalPage` with the other account's ID: 0 rows, total 0. The other's fill by `signal_id`, and B's signal by ID: `[]` |
| UI as B                                    | "Showing 1 of 1 signal": only B's own                                                                                       |
| Error state                                | Journal reads forced to fail: alert, no entries; Retry recovers                                                             |
| Keyboard                                   | Tab reaches each entry; Enter expands, Space collapses; visible focus ring                                                  |
| Layout                                     | Desktop and 375 px, light and dark. No page-level horizontal scroll (scroll width 375 at 375)                               |

The browser console showed 400s from Binance, which has no market for the synthetic `ZCT` symbols (the chart reads "Couldn't load chart data"). Every Supabase request was 200.

**Limitations of this pass**

- Production data is unverified. Real legacy rows may hold combinations the synthetic ones don't.
- Page size and ordering were checked against one account's 38 rows. There is no index on `(user_id, created_at, id)`. Add one if an account reaches thousands of signals.
- A failed read waits for postgrest-js's own retries (about 7 s locally) before the error shows. The loading state shows meanwhile.

## Next increment

Recording rejections, approvals and dismissal times needs schema changes, so it's left out of this read-only first increment:

1. An append-only `trading_signal_events` table (signal, user, event kind, reason, server price and quote time, timestamp), readable by its owner only.
2. A `dismiss_tactical_signal` RPC that sets the status and writes the event in one transaction, in place of the client's direct `UPDATE`.
3. `execute_tactical_signal` returns its refusals in place of raising them, so the refusal event can commit. That changes its contract with `ActionCenter`, the release contract (`dbContract.ts`) and the pgTAP suites.
4. Optionally, the price the Action Center showed, sent with the execution request and stored on the fill.

Rows from before the increment stay **Not recorded**.
