# Opportunity Radar v1 — implementation tasks

This checklist implements the frozen contract in `docs/opportunity-radar.v1.json`. Complete tasks in
dependency order. Every task ends with its focused tests; checkpoints add the full repository gates.

## Phase 1 — Contract and pure decision slice

## Task 1: Verify and normalize the frozen specification

**Description:** Add a Node-only specification loader that parses
`docs/opportunity-radar.v1.json`, recomputes its canonical SHA-256 with `specificationId` removed,
validates the fixed schema and exports the normalized runtime config used by campaign code.

**Acceptance criteria:**

- [x] The committed identifier recomputes to
      `0eddcc4f81ba47d74168392bb50af64050d3a9db2ab56da914c3814087d64483`.
- [x] Missing, reordered or changed semantic fields fail with a specific contract error; ordinary
      JSON key order does not change the identifier.
- [x] Runtime config includes the exact universe, thresholds, schedule, horizons, costs and gate.

**Verification:**

- [x] `npm test -- scripts/opportunitySpecification.test.ts`
- [x] Mutation fixtures for ID mismatch, unsupported schema and malformed members fail closed.

**Dependencies:** None

**Files likely touched:**

- `scripts/opportunitySpecification.ts`
- `scripts/opportunitySpecification.test.ts`

**Estimated scope:** Small (2 files)

## Task 2: Evaluate one Opportunity slot purely

**Description:** Implement deterministic market-gate, SMA trend, canonical score, momentum,
volatility, ranking and transition evaluation over collected `ScanInput` values. Return explicit
coverage/reason codes and complete Opportunity fields without I/O.

**Acceptance criteria:**

- [x] Every market-gate and candidate boundary is tested on both sides, including exact equality.
- [x] Fewer than 200 finite closed candles cannot qualify, while scanner status remains visible.
- [x] First/missing/failed previous slots emit no transition; false→true emits exactly one;
      true→true emits none; false→false emits none.

**Verification:**

- [x] `npm test -- src/test/opportunityRadar.test.ts src/test/canonicalModel.test.ts`
- [x] Truncating synthetic input after the slot leaves the slot output byte-identical.

**Dependencies:** Task 1

**Files likely touched:**

- `src/lib/opportunityRadar.ts`
- `src/test/opportunityRadar.test.ts`
- `src/lib/canonicalModel.ts`
- `src/test/canonicalModel.test.ts`

**Estimated scope:** Medium (4 files)

## Checkpoint A: Semantic contract

- [x] Owner reviews synthetic market-gate, candidate and transition tables.
- [x] `npm run typecheck`
- [x] `npm run lint`
- [x] `npm test`
- [x] `npm run build`

## Phase 2 — Immutable daily capture slice

## Task 3: Initialize a future-bound Opportunity campaign

**Description:** Add an Opportunity-specific manifest, safe campaign path, UTC slot generator and
exclusive manifest write. Bind campaign ID, specification ID, exact implementation commit,
universe, future start/end and the 00:30–06:00 retry window.

**Acceptance criteria:**

- [x] Initialization refuses past/non-boundary starts, short ranges, invalid IDs and spec/hash
      mismatch.
- [x] An existing manifest is accepted only when byte-equivalent; conflicting initialization fails.
- [x] No network request occurs during initialization.

**Verification:**

- [x] `npm test -- scripts/opportunityCampaign.test.ts`
- [x] Temporary-store fixtures cover future, past, duplicate and conflicting manifests.

**Dependencies:** Task 1

**Files likely touched:**

- `scripts/opportunityCampaign.ts`
- `scripts/opportunityCampaign.test.ts`

**Estimated scope:** Small (2 files)

## Task 4: Collect and persist one due slot

**Description:** Fetch exactly 200 Binance daily candles for each frozen member, record every
response/failure and actual attempt time, evaluate the slot, and create one immutable slot artifact.
Use injected fetch functions in tests.

**Acceptance criteria:**

- [x] Collection requests only the twelve frozen instruments and uses only candles closed by the
      logical slot.
- [x] Completed slots never refetch; retries retain failed attempts and stop after 06:00 UTC.
- [x] Partial/provider-invalid data remains in coverage; no member or candle is substituted.

**Verification:**

- [x] `npm test -- scripts/opportunityCampaign.test.ts src/test/opportunityRadar.test.ts`
- [x] Synthetic provider fixtures cover complete, partial, malformed, rate-limited and late runs.

**Dependencies:** Tasks 2–3

**Files likely touched:**

- `scripts/opportunityCampaign.ts`
- `scripts/opportunityCampaign.test.ts`
- `src/lib/opportunityRadar.ts`

**Estimated scope:** Medium (3 files)

## Task 5: Reproduce a completed slot offline

**Description:** Load a slot, verify every hash and manifest binding, recompute scanner and
Opportunity output with network explicitly blocked, and append a reproduction record.

**Acceptance criteria:**

- [x] Untouched evidence returns `MATCH`; input, manifest, output or implementation changes return
      a specific mismatch without rewriting evidence.
- [x] `--block-network` proves no fetch occurs during reproduction.
- [x] Repeated identical reproductions append receipts but do not alter the completed slot.

**Verification:**

- [x] `npm test -- scripts/opportunityCampaign.test.ts`
- [x] Tamper tests cover input hash, prior-slot link, spec ID and Opportunity output.

**Dependencies:** Task 4

**Files likely touched:**

- `scripts/opportunityCampaign.ts`
- `scripts/opportunityCampaign.test.ts`

**Estimated scope:** Small (2 files)

## Task 6: Expose campaign commands through the existing CLI

**Description:** Wire init, run, reproduce and operational status commands into
`scripts/evaluate-canonical.ts`, with workspace-contained paths and non-zero exits on failures or
mismatches.

**Acceptance criteria:**

- [ ] Usage and argument parsing match the frozen command contract.
- [ ] JSON stdout is machine-readable; sensitive paths, candles and per-asset evidence are not
      printed by status commands.
- [ ] Unknown flags, unsafe paths and failed attempts exit non-zero.

**Verification:**

- [ ] `npm test -- scripts/evaluate-canonical.test.ts scripts/opportunityCampaign.test.ts`
- [ ] Run every command against a temporary synthetic campaign.

**Dependencies:** Tasks 3–5

**Files likely touched:**

- `scripts/evaluate-canonical.ts`
- `scripts/evaluate-canonical.test.ts`
- `scripts/opportunityCampaign.ts`

**Estimated scope:** Medium (3 files)

## Checkpoint B: Capture and reproduction

- [ ] A synthetic three-slot campaign emits only the expected false→true transition.
- [ ] Its second run is idempotent and its offline reproduction is byte-equivalent.
- [ ] Legacy campaign, scan-store and outcome tests remain unchanged and passing.
- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] Owner approves the evidence tree before outcome work.

## Phase 3 — Outcomes and frozen evidence gate

## Task 7: Measure one Opportunity outcome purely

**Description:** Implement exact next-open reference, 5/10/20/30-day endpoints, 30 bps cost,
entry-zone reach, invalidation touch and favorable/adverse excursions over validated synthetic
candles.

**Acceptance criteria:**

- [ ] Exact timestamp, maturity, missing, invalid and no-substitution states match the spec.
- [ ] Primary intent-to-treat output remains present when all three entry opens miss the zone.
- [ ] Cost and excursion calculations have hand-verifiable fixtures, including gaps.

**Verification:**

- [ ] `npm test -- scripts/opportunityOutcomes.test.ts`
- [ ] Table fixtures cover each horizon and every outcome state.

**Dependencies:** Task 1

**Files likely touched:**

- `scripts/opportunityOutcomes.ts`
- `scripts/opportunityOutcomes.test.ts`

**Estimated scope:** Small (2 files)

## Task 8: Append matured outcomes and benchmarks

**Description:** Collect exact Binance candles only for matured Opportunities, measure every
eligible same-date universe member and BTC, and create-or-verify immutable outcome files under the
Opportunity specification ID.

**Acceptance criteria:**

- [ ] Immature Opportunities are skipped without placeholder conclusions; matured missing data is
      recorded explicitly.
- [ ] BTC and equal-weight baselines use identical timestamps and frozen eligibility membership.
- [ ] Identical reruns are unchanged; revised/conflicting provider bytes produce `CONFLICT`.

**Verification:**

- [ ] `npm test -- scripts/opportunityOutcomes.test.ts`
- [ ] Network-injected fixtures cover pagination/range bounds, partial benchmarks and conflicts.

**Dependencies:** Tasks 4 and 7

**Files likely touched:**

- `scripts/opportunityOutcomes.ts`
- `scripts/opportunityOutcomes.test.ts`
- `scripts/opportunityCampaign.ts`

**Estimated scope:** Medium (3 files)

## Task 9: Apply the preregistered analysis and decision gate

**Description:** Summarize only frozen primary/secondary measures, concentration and integrity;
implement the deterministic 20-day moving-block bootstrap and return `INSUFFICIENT`, `FAIL` or
`PASS_FOR_OWNER_REVIEW` without side effects.

**Acceptance criteria:**

- [ ] Every minimum count, concentration, integrity and signal condition has an exact boundary test.
- [ ] Bootstrap output is deterministic for seed 20261029 and date blocks; ordering inputs does not
      change results.
- [ ] No secondary subgroup can affect the primary decision result.

**Verification:**

- [ ] `npm test -- scripts/opportunityAnalysis.test.ts`
- [ ] Hand-built pass, fail, insufficient and concentration fixtures return expected reasons.

**Dependencies:** Task 8

**Files likely touched:**

- `scripts/opportunityAnalysis.ts`
- `scripts/opportunityAnalysis.test.ts`

**Estimated scope:** Small (2 files)

## Checkpoint C: Research integrity

- [ ] Review timestamp conventions, costs, benchmarks, concentration and bootstrap implementation.
- [ ] Confirm no code path exposes interim performance before Task 10's gate.
- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] Owner approves the analysis refusal behavior.

## Phase 4 — Reports and unattended operation

## Task 10: Build refusal-first operational and final reports

**Description:** Generate a private report whose default view contains operational health only.
Performance sections are generated only when the decision gate is eligible and an explicit final
flag is supplied; otherwise the command refuses.

**Acceptance criteria:**

- [ ] Before eligibility, no return, benchmark, hit-rate, excursion or per-asset value appears in
      HTML, JSON stdout or logs.
- [ ] The final report includes every frozen primary/secondary result and limitation in either
      direction.
- [ ] Public/sanitized summary contains counts and phase statuses only.

**Verification:**

- [ ] `npm test -- scripts/opportunityReport.test.ts scripts/evaluate-canonical.test.ts`
- [ ] DOM/string tests assert forbidden interim fields are absent.
- [ ] Manual desktop and phone-width inspection of the synthetic private report.

**Dependencies:** Tasks 6 and 9

**Files likely touched:**

- `scripts/opportunityReport.ts`
- `scripts/opportunityReport.test.ts`
- `scripts/evaluate-canonical.ts`
- `scripts/reportStyles.ts`

**Estimated scope:** Medium (4 files)

## Task 11: Add one owner-selected notification transport

**Description:** Deliver newly persisted Opportunities from an immutable outbox through one chosen
channel. Record deterministic delivery receipts and keep transport retry state separate from study
evidence.

**Acceptance criteria:**

- [ ] The owner explicitly selects the channel before implementation begins.
- [ ] One Opportunity ID produces at most one logical notification despite retries or lost replies.
- [ ] Secrets and private evidence never appear in logs; transport failure cannot change campaign
      output.

**Verification:**

- [ ] Focused adapter tests with a fake transport cover success, timeout, retry and duplicate receipt.
- [ ] Manual delivery test uses synthetic data only.

**Dependencies:** Tasks 4 and 6; owner channel decision

**Files likely touched:**

- `scripts/opportunityNotification.ts`
- `scripts/opportunityNotification.test.ts`
- One channel-specific adapter file selected later

**Estimated scope:** Medium (3 files)

## Task 12: Orchestrate private restore, run, persist, reproduce and outcomes

**Description:** Compose the generic restricted Supabase storage client with Opportunity commands.
Each run restores evidence, verifies manifest/implementation, collects the due slot, persists and
round-trip verifies it, reproduces offline, collects only matured outcomes and writes a sanitized
summary.

**Acceptance criteria:**

- [ ] Collection is accepted only after durable round-trip persistence and reproduction `MATCH`.
- [ ] Stage-specific failures are visible without candles, tickers, prices, Opportunities or
      credentials.
- [ ] Interrupted upload, identical retry and conflicting remote object behaviors preserve evidence.

**Verification:**

- [ ] `npm test -- scripts/opportunityAutomation.test.ts scripts/privateCampaignStorage.test.ts`
- [ ] In-process storage fixtures exercise fresh-runner restore and each failure stage.

**Dependencies:** Tasks 5, 8 and 10

**Files likely touched:**

- `scripts/opportunityAutomation.ts`
- `scripts/opportunityAutomation.test.ts`
- `scripts/privateCampaignStorage.ts`

**Estimated scope:** Medium (3 files)

## Task 13: Add an inactive schedule and owner runbook

**Description:** Add a disabled-by-default scheduled workflow pinned to the reviewed implementation
commit and a runbook for restricted credentials, private import, synthetic acceptance, activation,
disablement, backup and regional Binance failure.

**Acceptance criteria:**

- [ ] Workflow cannot collect unless an explicit activation variable is `true` and the manifest
      already exists privately.
- [ ] Primary/retry runs respect the 00:30–06:00 UTC window, never upload public artifacts and never
      cancel an in-progress writer.
- [ ] Runbook requires synthetic acceptance and owner review before live initialization or enablement.

**Verification:**

- [ ] Workflow syntax and pinned actions are reviewed.
- [ ] Synthetic orchestration succeeds while activation is false; no Binance or production write.
- [ ] Full repository gates pass.

**Dependencies:** Tasks 11–12; owner runner/storage approval

**Files likely touched:**

- `.github/workflows/private-opportunity-radar.yml`
- `docs/private-opportunity-radar-automation.md`
- `scripts/opportunityAutomation.ts`

**Estimated scope:** Medium (3 files)

## Checkpoint D: Ready for owner activation review

- [ ] All focused and legacy tests pass.
- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] Synthetic end-to-end campaign restores, collects, persists, reproduces, matures outcomes,
      refuses interim performance and sends one synthetic notification.
- [ ] Security review confirms least-privilege storage and secret redaction.
- [ ] No live campaign exists and the workflow remains disabled.
- [ ] Owner reviews and separately authorizes campaign initialization and activation.
