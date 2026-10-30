# Private Opportunity Radar automation

This runbook operates the frozen Opportunity Radar v1 study
([`OPPORTUNITY_RADAR_RESEARCH.md`](OPPORTUNITY_RADAR_RESEARCH.md),
[`opportunity-radar.v1.json`](opportunity-radar.v1.json)) unattended. The workflow
[`private-opportunity-radar.yml`](../.github/workflows/private-opportunity-radar.yml) collects
nothing until the owner sets the activation variable. Its campaign ID and frozen implementation
commit are already pinned to a campaign the owner initialized and imported, whose implementation
predates the corrected notification lifecycle (see [Current state](#current-state)). The study's
Binance data source is separate from the TradingView product flow
([data source attribution](OPPORTUNITY_RADAR_RESEARCH.md#data-source-attribution)).

## Current state

Checked read-only on 2026-10-30. Nothing was enabled, initialized, dispatched or uploaded.

| Check                         | Result   | Evidence                                                                                                                                                                                                                                                                                          |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow pins                 | VERIFIED | `CAMPAIGN_ID: opportunity-radar-v1-2026-12-01` and `FROZEN_IMPLEMENTATION_COMMIT: 99ec46261aee9d945c594ba6b01d8e0d21b9336d`, set by `b80eb03` (the last commit of #119) and merged in `96198c9`. They are not placeholders                                                                        |
| Frozen commit                 | VERIFIED | `99ec462` has `opportunity-campaign-run`, `opportunity-campaign-reproduce --block-network` and `opportunity-outcomes --matured-only`. Its tree differs from `96198c9` only in those two pins. #119 was squash-merged, so it is not in `main`'s history; it is reachable from `refs/pull/119/head` |
| Manifest and pins agree       | VERIFIED | Private storage holds one manifest for that ID, uploaded 2026-10-30T16:05:03Z, byte-identical (size and MD5) to the owner's local copy. It names `99ec462`, specification `0eddcc4f…`, 365 slots from 2026-12-01 to 2027-11-30, and validates against the frozen specification. No slot is due    |
| Activation switch             | VERIFIED | `OPPORTUNITY_RADAR_AUTOMATION_ENABLED` is not set, so collection is off                                                                                                                                                                                                                           |
| Workflow runs                 | VERIFIED | None                                                                                                                                                                                                                                                                                              |
| Telegram secrets              | VERIFIED | Not set; notifications would report "not configured"                                                                                                                                                                                                                                              |
| Runner checkout of `99ec462`  | UNKNOWN  | Only the enabled `collect` job checks it out, and it has never run                                                                                                                                                                                                                                |
| Binance reachability (runner) | UNKNOWN  | `binance-preflight` has never been dispatched                                                                                                                                                                                                                                                     |

**Compatibility.** `99ec462` writes slot schema 1, whose Opportunities store `expiresAt` as
observedAt + 72 hours (00:30 UTC) instead of the contract's third UTC daily open (00:00 UTC). The
orchestration on `main` never sends an Opportunity from a schema-1 slot. It counts it
`incompatible` and fails the run's notification stage after every stage's evidence is persisted.
Collection, reproduction and outcomes are unaffected, because `99ec462` runs them and reproduces
its own schema-1 slots. To get notifications, initialize a new campaign under a new ID from a
reviewed commit that writes schema 2 (step 4), import it, and pin both values in a reviewed pull
request. Keep the 2026-12-01 manifest as it is: it has no slots, and its ID is never reused.

The GitHub repository is public. Workflow logs and summaries carry only stage names, statuses and
counts. Candles, tickers, prices, Opportunities, outcomes and credentials are never printed or
uploaded as GitHub artifacts. No path places orders, touches a brokerage account or infers a fill.

## Security model

Evidence reuses the private Supabase Storage bucket `private-campaign-evidence` and the dedicated
`campaign_automation` Auth user from the
[observation campaign](private-campaign-automation.md#security-model). That user can only `SELECT`
and `INSERT` below its own UID prefix: no update, delete or upsert. Opportunity Radar evidence lives
under `<uid>/opportunity-radar-<CAMPAIGN_ID>/`, apart from the legacy campaigns, so the existing
storage policies cover it without a migration. Never add a service-role key to GitHub Actions.

Secrets reach only the two workflow steps that read them (configuration validation and the
orchestration), never the checkout, setup or install steps or the disabled-state jobs. The
orchestration also strips the storage and Telegram credentials before it starts the frozen
implementation, which needs only Binance and its local evidence store.

| Kind     | Name                                   | Purpose                                                  |
| -------- | -------------------------------------- | -------------------------------------------------------- |
| Variable | `SUPABASE_URL`                         | Supabase project URL                                     |
| Variable | `SUPABASE_PUBLISHABLE_KEY`             | Public Auth API key; RLS still applies                   |
| Secret   | `SUPABASE_CAMPAIGN_EMAIL`              | Dedicated automation user login                          |
| Secret   | `SUPABASE_CAMPAIGN_PASSWORD`           | Dedicated automation user password                       |
| Secret   | `ZEROCHART_TELEGRAM_BOT_TOKEN`         | Optional: the owner's Telegram bot token                 |
| Secret   | `ZEROCHART_TELEGRAM_CHAT_ID`           | Optional: the owner's chat with that bot                 |
| Variable | `OPPORTUNITY_RADAR_AUTOMATION_ENABLED` | Activation switch; only exactly `true` collects evidence |

`CAMPAIGN_ID` and `FROZEN_IMPLEMENTATION_COMMIT` are not variables: they are pinned in the workflow
file by a reviewed change, so nobody can redirect collection by editing repository settings. A
collection run with either value missing or malformed stops at configuration.

## Activation sequence

Each step needs the previous one to pass. Steps 4 and 5 are separate owner decisions.

### 1. Synthetic acceptance (no Binance, storage or Telegram)

```bash
npm ci --ignore-scripts
npm test -- scripts/opportunityAutomation.test.ts scripts/privateCampaignStorage.test.ts scripts/opportunityCampaign.test.ts scripts/opportunityOutcomes.test.ts scripts/opportunityAnalysis.test.ts scripts/opportunityReport.test.ts scripts/opportunityNotification.test.ts scripts/telegramTransport.test.ts
npm run typecheck
npm run lint
npm run build
```

The suites run a synthetic campaign on fresh runners against in-process storage: restore, a
three-slot false→true transition, round-trip persistence, offline reproduction, exactly one
notification, outcome maturity, report refusal, interrupted uploads, identical retries, conflicting
evidence and every failing stage. Then, still disabled, dispatch the workflow on GitHub with
`check: synthetic-acceptance` to run the same suites on its runner.

### 2. Binance preflight on the runner

Dispatch the workflow with `check: binance-preflight`. It requests one public BTCUSDT daily candle
and prints only the HTTP status. `200` is required. HTTP `451` means GitHub's runner region is
blocked: keep automation disabled and move the `collect` job to a persistent, non-laptop self-hosted
runner in a legally supported region. Never switch to another venue or data source; that would be a
new study version.

### 3. Telegram delivery check (optional)

Create a bot with Telegram's @BotFather, start a chat with it and find the chat ID. In a local shell,
without echoing them, export `ZEROCHART_TELEGRAM_BOT_TOKEN` and `ZEROCHART_TELEGRAM_CHAT_ID`, then:

```bash
npm run evaluate -- opportunity-notify-test
```

It sends one message marked `SYNTHETIC DELIVERY TEST` and touches no campaign. When it arrives, add
both values as Actions secrets. Without them the workflow runs and reports notifications as not
configured.

### 4. Owner review, then live initialization

Review Checkpoint D in [`tasks/todo.md`](../tasks/todo.md). Initializing permanently binds a future
start slot and the exact implementation commit, so it is a separate, explicit decision. From a clean
checkout of the reviewed commit:

```bash
npm run evaluate -- opportunity-campaign-init CAMPAIGN_ID --start 2026-12-01T00:30:00.000Z --end 2027-11-30T00:30:00.000Z
```

The start must be a future 00:30 UTC slot and the range at least 180 slots (365 is the conservative
default). Initialization refuses a dirty worktree, a past or misaligned start and a short range. It
contacts no market provider.

### 5. Import, pin and enable

Upload the manifest once and prove it restores byte-for-byte:

```bash
CAMPAIGN_ID=CAMPAIGN_ID \
CAMPAIGN_STORE=.zerochart-campaigns \
SUPABASE_CAMPAIGN_BUCKET=private-campaign-evidence \
SUPABASE_URL="$SUPABASE_URL" \
SUPABASE_PUBLISHABLE_KEY="$SUPABASE_PUBLISHABLE_KEY" \
SUPABASE_CAMPAIGN_EMAIL="$SUPABASE_CAMPAIGN_EMAIL" \
SUPABASE_CAMPAIGN_PASSWORD="$SUPABASE_CAMPAIGN_PASSWORD" \
npx tsx scripts/opportunityAutomation.ts import
```

Then, in a reviewed pull request, set `CAMPAIGN_ID` and `FROZEN_IMPLEMENTATION_COMMIT` in the
workflow to the manifest's campaign ID and `implementationCommit`. After it merges:

1. Dispatch once while disabled and confirm the activation gate reports disabled.
2. Set `OPPORTUNITY_RADAR_AUTOMATION_ENABLED=true` and dispatch once **before the start slot**. The
   run restores, verifies the checkout, reports the slot as not due, collects no market data and
   records the orchestration privately.
3. Review its sanitized summary and the private bucket before relying on the schedule.

## Runtime behavior

The schedule runs at 00:42, 02:17 and 04:47 UTC, inside the frozen 00:30–06:00 retry window.
GitHub may start a scheduled job late. A collection that finishes at or after 06:00 is kept as a
failed attempt, and any run that begins at or after 06:00 reports the slot `MISSED`; a slot is never
backdated. The concurrency group never cancels
an in-progress writer, so two jobs cannot interleave evidence writes.

Every enabled run, on a fresh runner:

1. Authenticates as the restricted user and restores the campaign from private storage. A missing
   manifest stops the run: the campaign was never imported.
2. Refuses unless the frozen checkout is exactly the manifest's implementation commit, unmodified.
3. Collects only the due slot with the frozen implementation. A completed slot is never refetched;
   a failed attempt is kept and retried by the next scheduled run.
4. Persists and round-trip verifies the evidence after every stage, including failing ones.
5. Reproduces the slot offline with network access blocked. The slot is accepted only on `MATCH`.
6. After the due slot reproduces, sends each Opportunity in a completed schema-2 slot to Telegram
   at most once, and only while the evidence on record at that moment shows it valid. It must be
   before the third UTC daily open after observation (`expiresAt`). No later completed slot may
   have failed the BTC market gate, and no later recorded daily low may be at or below the
   invalidation level. A daily candle proves only that the level was touched by its close, never
   when. A later slot that is due but not on record, or whose BTC or member data could not be
   judged, holds the send. That hold neither cancels the Opportunity nor claims it is still valid.
   Holds and cancellations write nothing and never change which Opportunities the study counts or
   how their outcomes are measured. The attempt is persisted before the message leaves, so no later
   runner resends it. A timeout, server error or unanswered attempt is reported `unresolved` and
   never resent: check the chat.
7. Collects outcomes only for matured horizons, from each endpoint day's 00:30 slot on.
8. Records the run privately and writes the sanitized summary.

Failures carry a single `STAGE failure` annotation (configuration, restore, collection,
persistence, reproduction, notification or outcome) with a fixed message per error class, so no
evidence path or ticker reaches the log.

## Monitoring

Restore the private evidence to a local, git-ignored store (read-only; nothing is uploaded) and open
the operational report:

```bash
CAMPAIGN_ID=CAMPAIGN_ID CAMPAIGN_STORE=.zerochart-campaigns SUPABASE_CAMPAIGN_BUCKET=private-campaign-evidence \
SUPABASE_URL="$SUPABASE_URL" SUPABASE_PUBLISHABLE_KEY="$SUPABASE_PUBLISHABLE_KEY" \
SUPABASE_CAMPAIGN_EMAIL="$SUPABASE_CAMPAIGN_EMAIL" SUPABASE_CAMPAIGN_PASSWORD="$SUPABASE_CAMPAIGN_PASSWORD" \
npx tsx scripts/opportunityAutomation.ts restore
npm run evaluate -- opportunity-report CAMPAIGN_ID --operational-only
```

It shows slot, attempt, reproduction and outcome-data counts and decision-gate progress only. After
90 calendar slots review collection and reproduction health; there is no performance decision then.
`--final` refuses until every frozen sample and integrity condition holds (180 slots, 40 matured
outcomes, 6 assets, 4 months, no asset above 30%, 95% completion, full reproduction, zero
conflicts).

## Disablement, recovery and backup

- Disable immediately with `OPPORTUNITY_RADAR_AUTOMATION_ENABLED=false`. In-progress writes finish.
- After a runner interruption, dispatch again: restore is create-or-verify and nothing completed is
  refetched or resent.
- A content conflict is never repaired automatically. Disable, download both copies, find which
  credential or process wrote the unexpected bytes, rotate it and preserve both files. Outcome
  conflicts are kept as receipts and hold the decision gate at `INSUFFICIENT`.
- A missing or mismatched manifest is a hard stop. Restore it from a verified backup; never
  initialize a replacement campaign under the same ID.
- An `unresolved` notification may or may not have arrived. Check the chat; the study is unaffected.
- Back up the private bucket with a trusted account that can read the dedicated UID prefix.
  Preserve object paths and bytes exactly and verify SHA-256 hashes after export.
- A regional Binance HTTP 451 keeps automation disabled until a supported runner is in place.
- Rotate a leaked Telegram token with @BotFather and replace the secret; delivery records stay valid.
