# Decision & Execution Journal

The Paper Desk's **Signal Journal** tab lists each TradingView tactical signal with what is recorded about it: where it came from, its current status, the paper fill linked to it, and, for a dismissal, when and why it was dismissed. It is read-only. It has no Execute or Dismiss button. Trades and dismissals still go through the Action Center.

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
| Dismissal: time, owner, actor, reason      | `trading_signal_dismissals`, one row per dismissed signal               | `20261028120000`. Signals dismissed before it have no row                          |

### What is not recorded

| Fact                                                        | Why it's missing                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider event time                                         | No column holds it. Current Pine payloads put TradingView's `timenow` in `event_id`, but that's a delivery ID. tv-webhook fills it with the receipt minute when it's missing, and only the first accepted delivery is kept. The journal never reads it as a time |
| When or why a signal was dismissed, before `20261028120000` | Dismissal only set `status` then. Those signals have no dismissal row, and none is made up for them                                                                                                                                                              |
| Execution attempts and rejections                           | `execute_tactical_signal` raises on a failed check, which rolls back everything. A refused attempt leaves no row                                                                                                                                                 |
| The risk checks that applied at decision time               | The client checks in `usePaperRisk` and the server checks in `check_paper_transaction` are not saved. The journal can't say which checks a past decision passed                                                                                                  |
| The price the Action Center showed (the preview)            | Not stored. Only the price sent with the execution request is stored, as the fill price                                                                                                                                                                          |
| Whether a fill was recovered by reconciliation              | `ActionCenter` checks `paper_transactions.signal_id` after a lost response (#99, D1). That check runs in the browser and writes nothing, so a recovered fill looks like any other                                                                                |
| Duplicate deliveries                                        | A duplicate is answered `duplicate` and not stored                                                                                                                                                                                                               |
| Fills of signals executed before `20261022090000`           | The client booked those fills itself and then set the status, so the fill has no `signal_id`. The fill is in the Trade Ledger but not linked to its signal                                                                                                       |

None of these are backfilled. Recording them in future is the [next increment](#next-increment).

## Evidence-field map

| Journal field                 | Source                                                   | Meaning                                                                                         | Limitations                                                                                       |
| ----------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Asset                         | `trading_signals.ticker`                                 | The symbol TradingView sent, such as `BTCUSDT`                                                  | The fill can book under the scanner's ticker (`BTC-USD`). The journal shows both                  |
| BUY / SELL                    | `trading_signals.action`                                 | The alert's side                                                                                |                                                                                                   |
| Kind                          | `trading_signals.signal_kind`                            | `strategy` or `transport_test`                                                                  | Null on legacy rows: not recorded and not verified                                                |
| Exchange, timeframe, model    | `trading_signals.exchange`, `timeframe`, `model_version` | What the alert said about its source                                                            | The alert's claim. Null on alerts set up before `20261022120000`                                  |
| Bar time                      | `trading_signals.bar_time`                               | Open time of the bar that fired, from the Pine payload                                          | Null on legacy alerts                                                                             |
| Provider event time           | none                                                     | Always **Not recorded**                                                                         | See [Inventory](#what-is-not-recorded)                                                            |
| Delivery ID                   | `trading_signals.event_id`                               | The first accepted delivery's ID                                                                | An identifier, not a time. Null before `20261020180000`                                           |
| Server receipt                | `trading_signals.created_at`                             | When the database accepted the delivery                                                         |                                                                                                   |
| Signal price                  | `trading_signals.price`                                  | The bar's close when the alert fired                                                            | Null before `20261020180000`                                                                      |
| Score, quantity, planned stop | `signal_score`, `quantity`, `stop_loss`                  | As the alert sent them. Quantity is in units                                                    | The score is the model's, not a probability                                                       |
| Recorded status               | `trading_signals.status`                                 | The current value                                                                               | No history and no timestamps                                                                      |
| Dismissed at                  | `trading_signal_dismissals.dismissed_at`                 | The server's clock when the dismissal committed, after the row lock                             | Only for dismissals since `20261028120000`                                                        |
| Dismissal reason              | `trading_signal_dismissals.reason`                       | One of the allowlisted codes, shown by label. **No reason provided** when the owner picked none | An old frontend's direct `UPDATE` records no reason ([Release](#release))                         |
| Dismissal time and reason     | none                                                     | **Not recorded**, on a `DISMISSED` signal with no dismissal row                                 | Dismissed before `20261028120000`                                                                 |
| Linked fill                   | `paper_transactions` where `signal_id` = the signal      | The fill `execute_tactical_signal` booked                                                       | Only since `20261022090000`                                                                       |
| Executed quantity, price, fee | `paper_transactions.quantity`, `price`, `fees`           | The stored values. Quantities use the Trade Ledger's precision (#101)                           | A paper fill at the server-checked price. It does not show what a real exchange would have filled |
| Booked as                     | `paper_transactions.ticker`                              | The ticker the fill booked under                                                                |                                                                                                   |
| Fill time                     | `paper_transactions.created_at`                          | When the fill booked, stamped after the account lock                                            |                                                                                                   |
| Signal-to-fill price change   | (fill price − signal price) ÷ signal price               | How far the price moved between the alert and the fill                                          | Includes market movement and the time before the owner acted. Not execution slippage              |
| Receipt to booking            | fill time − server receipt                               | How long the signal waited before it was executed                                               |                                                                                                   |
| Reconciliation recovery       | none                                                     | Never shown                                                                                     | See [Inventory](#what-is-not-recorded)                                                            |

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
- A dismissal row on a signal that isn't `DISMISSED`.

A row with any of exchange, timeframe, bar time or model missing is also marked **Provenance incomplete**.

## Data access and security

- One PostgREST request per page through the browser's existing client and session: `trading_signals` with its `paper_transactions` and its `trading_signal_dismissals` row embedded through their `signal_id` foreign keys. Every table's owner-only `SELECT` policy applies, so the database filters all three. The journal also filters by `user_id`, but it doesn't rely on that.
- Signals, fills and dismissals come from one statement, so one snapshot. Two requests could read a signal as `PENDING`, then its fill after an execution in between, and report a false inconsistency.
- The query names its columns. It reads neither `signal_webhook_tokens` nor any payload, and `trading_signals` stores no token or raw payload. From the dismissal row it reads the time and reason only, not the owner or actor.
- Pages of 25, newest server receipt first, with keyset pagination on `(created_at, id)`. New signals or a status change during paging can't repeat or skip a row.
- The journal itself adds no `SECURITY DEFINER` function: it reads under RLS. `supabase/tests/decision_journal.test.sql` runs the same read as an authenticated user and checks isolation, duplicate deliveries, retried executions and the dismissal reason.
- Filters run on the server: the recorded status exactly, and the asset as a fragment of the ticker. The fragment keeps only ticker characters, so it can't carry a `LIKE` wildcard.
- Times show in the browser's time zone with the zone named, because a daily bar's 00:00 UTC open reads differently on either side of a DST change. The stored ISO value is the tooltip.

## Dismissal evidence

Since `20261028120000`, every dismissal writes a row in `trading_signal_dismissals` in the same transaction as the status change.

### For the owner

- **Dismiss** in the Action Center still takes one click. The **Dismiss reason (optional)** menu beside it can add one reason: _Price moved_, _Too risky_, _Signal is stale_, _Disagree with the signal_ or _Other_. There is no free text. The menu resets to _No reason_ for each new card.
- The journal shows the dismissal's server time (**Dismissed at**) and its **Dismissal reason**. A dismissal with no reason reads **No reason provided**.
- A signal dismissed before dismissals were recorded reads **Dismissal time and reason: Not recorded**. Its time and reason are unknown, and the journal doesn't guess them.
- If the network drops after you press Dismiss, the Action Center reads the signal back before it reports anything. A committed dismissal just clears the card. If another tab executed the signal first, a note says it wasn't dismissed. If another tab dismissed it with another reason, a note shows the recorded reason. Only a signal still pending (or unreadable) shows an error, and the card stays.

### The record

| Column         | Set by                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| `signal_id`    | The dismissed signal. Primary key: one row per signal                                                   |
| `user_id`      | The signal's owner, from the locked signal row                                                          |
| `actor_id`     | `auth.uid()` of the session that dismissed it. Today always the owner                                   |
| `dismissed_at` | `clock_timestamp()` after the signal's row lock                                                         |
| `reason`       | `price_moved`, `too_risky`, `stale`, `disagree`, `other`, or null. A check constraint enforces the list |

Owners can `SELECT` their own rows. No client role can insert, update or delete one, and the caller never supplies the owner, actor or time. A `BEFORE UPDATE` trigger refuses any rewrite, by the service role too. Deleting the signal's account still cascades.

### `dismiss_tactical_signal(signal_id, reason default null)`

`SECURITY DEFINER` with `search_path = ''`, executable by `authenticated` only. It takes the same row lock as `execute_tactical_signal` (`SELECT … FOR UPDATE` on the signal), so a dismissal and an execution of one signal run one after the other, and the second sees the first one's result.

| Situation                                            | Result                                                                               | HTTP |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ | ---- |
| Owner, `PENDING`, no linked fill                     | Writes the record, sets `DISMISSED`, returns the record                              | 200  |
| Retry with the same reason (or none, again)          | Returns the original record. Nothing is written                                      | 200  |
| Retry with a different reason, or none after one     | `PT409` _Signal was already dismissed with another reason_. The first record stands  | 409  |
| `EXECUTED`                                           | `23514` _Signal was executed, so it can't be dismissed_                              | 400  |
| `DISMISSED` with no record (before `20261028120000`) | `23514` _Signal was dismissed before dismissals were recorded_. No record is created | 400  |
| `PENDING` with a linked fill (only a hand-made row)  | `23514` _Signal has a booked fill, so it can't be dismissed_                         | 400  |
| Reason outside the list                              | `23514` check violation. Nothing changes                                             | 400  |
| Another owner's signal, or no such signal            | `P0002` _Signal not found_                                                           | 500  |
| No signed-in user                                    | `42501`                                                                              | 401  |

It never touches `paper_transactions`, so fills, positions and cash can't change.

### Direct updates

`trading_signals` keeps its `UPDATE (status)` grant and the _resolve their own pending signals_ policy (`PENDING` → `DISMISSED` only), because frontends released before `20261028120000` still dismiss that way. An `AFTER UPDATE` trigger records evidence for every `PENDING` → `DISMISSED` change on any path. It refuses the change unless `auth.uid()` is the signal's owner, so even the service role can't dismiss without an owner. The RPC writes its row (with the reason) first, and the trigger then adds nothing. A direct update gets a row with no reason. Clients still can't write `EXECUTED` directly. See [Release](#release).

### Release

The database goes first. The production gate blocks this frontend until `20261028120000` is applied, and the older frontend keeps working against the new database.

- **Old frontend, new database.** Its direct `UPDATE` still dismisses. The trigger records the time and the owner as actor, with no reason, in the same statement. It never reports success for an update that changed nothing: a signal resolved elsewhere matches no row, and the trigger records nothing. No dismissal goes unrecorded during the switch-over, so no flag or temporary mechanism is needed beyond the trigger, which stays.
- **Contract step, later.** Once no tab runs a pre-`20261028120000` bundle, a migration can revoke `UPDATE (status)` from `authenticated` and drop the update policy. Keep the trigger. After that, a stale bundle's dismissal fails loudly (`42501`) instead of recording no reason.
- **Rollback.** Rolling the frontend back is safe: the older bundle's dismissals are still recorded, without a reason. Migrations are forward-only. Never drop `trading_signal_dismissals` or delete its rows to undo this. To withdraw the RPC, revoke its `EXECUTE` in a new migration, and the recorded evidence stays.

The full steps are in [RELEASE.md](./RELEASE.md#dismiss_tactical_signal-20261028120000).

### Verification — 2026-10-28

Local only. Nothing was written to production: no migration, deploy, TradingView change, trade or campaign.

**Automated, collected by CI**

| Command                                                                                  | Result                                                              |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `npm run typecheck`, `npm run build`, `npm run lint` (CI's placeholder env)              | Pass                                                                |
| `npm test -- --coverage`                                                                 | 76 files, 664 tests. 13 are new                                     |
| `supabase test db`                                                                       | 7 files, 157 assertions. `dismiss_tactical_signal.test.sql` adds 36 |
| `supabase/tests/concurrency.sh`                                                          | 19 checks. 11 are new (section 5)                                   |
| `supabase/tests/upgrade.sh` from the pre-#79 base (as CI runs it) and from `origin/main` | 12 checks each. 4 are new                                           |
| `scripts/check-db-contract.ts` against the local stack, `VERCEL_ENV=production`          | `has all 28 migrations and every RPC this frontend calls`           |

`dismiss_tactical_signal.test.sql` covers the atomic status change with its record; retries with the same, a different and no reason; executed, legacy and fill-linked signals; an out-of-list reason; another owner's signal; extra actor or time arguments; client insert, update and delete of records; an old client's direct update (recorded, no reason) and its refusal across owners; anon; a session without a user; the service role rewriting a record or dismissing without an owner; and that no dismissed signal carries a fill. Dropping the recording trigger, granting clients `INSERT`, or dropping the append-only trigger each fails it (4, 3 and 1 assertions).

`concurrency.sh` section 5 races real sessions, each holding its transaction for 2 s: two dismissals (one record, the second gets the first's), dismissal then execution and execution then dismissal (one terminal state each, `DISMISSED/0 fills/1 record` and `EXECUTED/1/0`), an old client's direct update against an execution (`updated=0`, no record), and two reasons (the second gets `PT409`, the first stands).

`upgrade.sh` seeds a `DISMISSED` row on the old schema. After the upgrade it has no record, and a signal the old release left pending can be dismissed, with the owner as actor.

`actionCenter.test.tsx`: one-click Dismiss calls the RPC with `reason: null` and never `UPDATE`; the reason menu's options and reset per card; aria-disabled while busy with one call per double press; a lost response that committed (card goes, no error, no retry); a refusal while pending (error, card stays); an unreadable outcome (error); executed elsewhere (note); dismissed elsewhere with another reason (note with the recorded reason). `decisionJournal.test.ts` and `decisionJournalView.test.tsx`: recorded time and reason, **No reason provided**, **Not recorded** for an earlier dismissal, a record on a non-dismissed signal flagged, the embedded columns (time and reason only), and a switch of signed-in owner.

**Isolated stack with real local sessions**

A scratch stack (`project_id = "zcdismiss"`, API on 56021), set up as in [PAPER_TRADING_ACCEPTANCE.md](./PAPER_TRADING_ACCEPTANCE.md#setup), with `vite dev` on 8085 pointed at it. Account A signed up through the app's form and B through the same GoTrue endpoint, both throwaway `@example.test` accounts. Synthetic data only: `ZCT*` tickers, exchange `ZC_SYNTHETIC`, `SYN-*` event IDs, delivered through the local `tv-webhook` with each account's minted token. One legacy-shaped `DISMISSED` row (`SYNTHETIC-legacy-dismissed`) was inserted by the database superuser.

| Check                                                  | Result                                                                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One click, no reason (mouse)                           | `DISMISSED`, record with reason null, actor = owner, server time                                                                                                    |
| Keyboard with a reason                                 | Tab reaches the menu; Shift+Tab, Enter on Dismiss records `price_moved`. Focus stays on Dismiss for the next card, whose menu reads _No reason_                     |
| Lost response (`stale`)                                | Server answered 200 and committed; the page saw `Failed to fetch`. One read-back of status and reason, card cleared, no error toast, no `PATCH`                     |
| Double-click on Dismiss                                | One RPC call, one card cleared                                                                                                                                      |
| Dismiss an executed signal (A's JWT)                   | 400 `23514` _Signal was executed, so it can't be dismissed_                                                                                                         |
| Retry, same reason / no reason                         | 200 with the original `dismissed_at`                                                                                                                                |
| Retry, another reason                                  | 409 `PT409`. Reason and time unchanged                                                                                                                              |
| A dismisses B's signal                                 | `P0002` _Signal not found_; B's signal still `PENDING`                                                                                                              |
| B reads dismissal records, or A's signal by ID         | `[]`                                                                                                                                                                |
| Anon calls the RPC / reads records                     | 401 `42501`                                                                                                                                                         |
| A inserts, rewrites or deletes a record                | 403 `42501` each                                                                                                                                                    |
| RPC with `actor_id` and `dismissed_at`                 | 404 `PGRST202`                                                                                                                                                      |
| Legacy dismissed signal                                | 400 `23514`; still no record                                                                                                                                        |
| Old client: direct `PATCH` to `DISMISSED`              | 200; record with no reason, actor = owner. Repeated: 200 `[]`, nothing new                                                                                          |
| Old client: direct `PATCH` to `EXECUTED`               | 403 `42501` (RLS)                                                                                                                                                   |
| Execute and dismiss sent together over HTTP, 3 signals | One `EXECUTED` (1 fill, no record) and two `DISMISSED` (no fill, 1 record each). Dismissed signals with a fill: 0                                                   |
| Journal as A                                           | 13 signals, 10 dismissed, 3 executed. Each recorded dismissal shows its time and reason label; 3 show **No reason provided**; the legacy row shows **Not recorded** |
| Journal keyboard                                       | Tab reaches an entry; Enter expands it; 2 px focus ring                                                                                                             |
| UI as B                                                | Action Center shows only B's signal; journal "Showing 1 of 1 signal", no dismissal facts                                                                            |
| Layout                                                 | Dark and light; 375 px with no horizontal scroll (scroll width 375). The reason menu wraps under its label                                                          |

The console showed 400s from Binance klines for the synthetic symbols, as in earlier passes, and two 401s on the first `user_portfolios` and `user_subscriptions` reads right after sign-up, which then returned 200. Neither involves this change.

**Limitations of this pass**

- Production data is unverified. Production's dismissed signals will read **Not recorded** until new dismissals happen.
- The native `<select>` popup can't be driven by keys in the test browser pane. The option was set with a form-input event; Tab order, focus and Enter were checked with real keys.
- The direct-update compatibility path was exercised with `curl` using A's session, not with a pre-`20261028120000` bundle in the browser.

## Verification of the read-only journal — 2026-10-28 (#102)

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

Dismissals are recorded (above). Still to do, each a schema change of its own:

1. `execute_tactical_signal` returns its refusals in place of raising them, so a refusal can be recorded. That changes its contract with `ActionCenter`, the release contract (`dbContract.ts`) and the pgTAP suites.
2. Optionally, the price the Action Center showed, sent with the execution request and stored on the fill.
3. The contract step that revokes direct status updates ([Release](#release)).

Rows from before each increment stay **Not recorded**.
