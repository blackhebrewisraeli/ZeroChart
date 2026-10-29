# Implementation Plan: ZeroChart Opportunity Radar v1

## Overview

Implement the frozen prospective contract in
[`docs/opportunity-radar.v1.json`](../docs/opportunity-radar.v1.json) as a private, deterministic
Binance Spot shadow campaign. The system will collect one immutable daily slot, evaluate the fixed
BTC market gate and twelve-member universe, emit transition-only Opportunities, reproduce every
completed slot offline, collect outcomes only after maturity, and refuse performance reporting
until the frozen decision gate is met. It will not place orders or access a brokerage account.

The task checklist lives in [`tasks/todo.md`](todo.md). This plan does not authorize campaign
initialization, a scheduled workflow, notification credentials or publication of results; each has
an explicit owner checkpoint.

## Approved capability map

| Module id                        | Responsibility                                                      | Depends on                  |
| -------------------------------- | ------------------------------------------------------------------- | --------------------------- |
| `scanner-prospective-contract`   | Load and verify the frozen specification and pure Opportunity rules | —                           |
| `scanner-prospective-capture`    | Collect, evaluate and append immutable daily slot evidence          | contract                    |
| `scanner-prospective-outcomes`   | Append exact matured outcomes and frozen benchmarks                 | capture                     |
| `scanner-prospective-analysis`   | Apply the sample gate and calculate only preregistered statistics   | outcomes                    |
| `scanner-prospective-automation` | Restore, run, persist, reproduce, notify and monitor                | capture, outcomes, analysis |

Build order: contract → capture → outcomes → analysis → automation.

## Dependency graph

```text
frozen JSON + hash verifier
        │
        ▼
pure Opportunity slot evaluator
        │
        ├──────────────► campaign manifest and scheduler
        │                         │
        │                         ▼
        │                immutable slot collection
        │                         │
        │                         ├────────► offline reproduction
        │                         │
        │                         ▼
        │                immutable outcome collection
        │                         │
        │                         ▼
        │                 frozen analysis gate
        │                         │
        │                         ▼
        └────────────────► operational/final reports
                                  │
                     ┌────────────┴────────────┐
                     ▼                         ▼
              notification adapter     private orchestration
                                                │
                                                ▼
                                      inactive scheduled workflow
```

## Architecture decisions

- **The JSON remains the research authority.** A Node-only loader verifies its schema and SHA-256
  before a campaign can initialize or run. Browser code never imports a file from `docs/`.
- **The evaluator is pure.** `src/lib/opportunityRadar.ts` receives collected `ScanInput` values,
  the previous completed slot and a normalized frozen config. It owns no clock, network, filesystem
  or environment access.
- **Reuse the scanner rather than copy it.** Candidate scoring calls `evaluateScan`; trend readings
  use the same validated closed Binance candles and `sma`. The canonical model still scores its
  existing window; Opportunity eligibility additionally requires finite SMA(200), so fewer than
  200 closed candles can be scanned but cannot qualify.
- **A slot is the aggregate root.** One exclusive JSON artifact contains attempts, exact collected
  inputs/hashes, scan output, gate evidence, eligibility states and emitted Opportunities. Later
  artifacts reference it and never rewrite it.
- **First-slot onset is unknown.** Campaign initialization does not emit Opportunities. A qualifying
  asset needs an immediately preceding successful slot on which it was evaluated and did not
  qualify.
- **Intent-to-treat is primary.** The next UTC daily open remains the reference even when it misses
  the displayed entry zone. Entry-zone reach is a secondary diagnostic.
- **Old evidence stays isolated.** Existing evaluation campaigns, scanner research, decisions
  reports and outcome v1/v2 files remain byte-identical. Opportunity artifacts use their own paths
  below the campaign root and the frozen Opportunity specification ID.
- **Generic private storage is reused.** `privateCampaignStorage.ts` already persists arbitrary
  append-only campaign files. Opportunity orchestration composes it instead of adding a second
  storage client.
- **Notification is downstream of evidence.** The immutable Opportunity record is the source of
  truth. A transport failure never removes, duplicates or changes an Opportunity.
- **Activation is a separate owner action.** Any scheduled workflow lands disabled and pins a
  reviewed implementation commit. A future campaign start must be strictly in the future.

## Vertical implementation phases

### Phase 1 — Contract and pure decision slice

Tasks 1–2 create a testable path from frozen JSON and synthetic candles to deterministic
Opportunity eligibility. This is the highest-risk semantic work and must land before storage or
automation.

### Phase 2 — Immutable daily capture slice

Tasks 3–6 create a future-bound manifest, collect one slot, emit transition-only Opportunities,
reproduce it with network access blocked and expose the commands through the existing CLI.

### Phase 3 — Outcome and evidence gate slice

Tasks 7–9 measure the exact preregistered prices, append records, calculate benchmarks and enforce
the 90-day operational checkpoint and 180-day/40-Opportunity decision gate.

### Phase 4 — Human-readable and unattended operation slice

Tasks 10–13 add refusal-first reports, one owner-selected notification channel, durable private
orchestration and an inactive scheduled workflow with a synthetic acceptance path.

## Checkpoints

1. **After Tasks 1–2 — semantic review:** approve every boundary, transition and reason code using
   synthetic fixtures before filesystem work.
2. **After Tasks 3–6 — capture review:** run a synthetic three-slot campaign and prove byte-stable
   offline reproduction; do not contact Binance in acceptance tests.
3. **After Tasks 7–9 — research review:** verify gaps, costs, benchmarks, dependence and all report
   refusals. Compare no real performance.
4. **After Tasks 10–13 — activation review:** run the synthetic end-to-end acceptance suite, inspect
   sanitized output and private paths, then stop. Initializing or enabling a live campaign requires
   a new explicit owner instruction.

At every checkpoint run:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

The planning skill's referenced `definition-of-done.md` is absent from the installed skill package;
the repository's four commands above, focused tests, immutable-evidence checks and manual
checkpoint reviews are the Definition of Done for this initiative.

## Parallelization

- Tasks 1–6 are sequential because they define and consume one shared evidence contract.
- After Task 6, Task 7's pure outcome math and Task 10's operational-only report model may be
  developed in parallel if they do not share files; final report gating waits for Task 9.
- Notification transport selection can happen while Tasks 7–9 are implemented, but code for it
  starts only after the owner chooses the channel.
- Workflow/runbook work waits for the orchestration API and frozen implementation commit.

## Risks and mitigations

| Risk                                                   | Impact | Mitigation                                                                            |
| ------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------- |
| Frozen JSON and runtime rules drift                    | High   | Hash verifier, explicit config normalization and boundary fixtures fail CI            |
| SMA(200) and scanner's 199-candle minimum are confused | High   | Require 200 finite closes for Opportunity eligibility; keep scanner coverage separate |
| A retry backdates evidence                             | High   | Bind a logical slot, retain actual attempt timestamps and refuse after 06:00 UTC      |
| First run creates false transitions                    | High   | Unknown onset emits no Opportunity; test missing/failed previous slots                |
| Binance revises or omits candles                       | High   | Exclusive writes, exact timestamps, no substitution and immutable conflict status     |
| Overlapping outcomes overstate confidence              | High   | One primary horizon, date-block bootstrap and explicit dependence language            |
| Rare signals never reach the gate                      | Medium | Keep shadow mode running; never lower thresholds inside v1                            |
| One asset dominates observations                       | Medium | Frozen 30% concentration gate and per-asset coverage                                  |
| Notification retries duplicate alerts                  | Medium | Deterministic Opportunity ID and create-or-verify delivery receipts                   |
| Scheduled runner gets Binance HTTP 451                 | High   | Synthetic preflight; keep automation disabled and choose a supported runner region    |
| Public CI leaks private evidence                       | High   | Sanitized summaries only; no artifact uploads; private bucket with restricted user    |
| Existing campaign evidence regresses                   | High   | Run legacy campaign/outcome/report tests and keep paths/spec IDs isolated             |

## Owner decisions before activation

- Choose one notification transport. Recommended evaluation order: Telegram bot, email, then app
  push. The choice must support idempotency and secret redaction.
- Choose the runner environment after a Binance connectivity preflight. GitHub Actions reuses the
  repository's current pattern; a persistent runner is the fallback for regional HTTP 451.
- Approve reuse or creation of a private Supabase Storage prefix/bucket and restricted automation
  identity.
- Choose a future campaign start/end. The contract requires at least 180 slots; a 365-day manifest
  is the conservative default, but is not created by this plan.

## Explicit non-goals

- No brokerage authentication, orders, positions, portfolio accounting, leverage or shorts.
- No Interactive Brokers integration in v1.
- No tuning of the frozen universe, thresholds, entry zone, horizons, costs or benchmarks.
- No public performance dashboard and no interim performance output.
- No live campaign initialization, deployment or workflow activation during implementation unless
  separately authorized.
