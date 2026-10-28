# Private observation campaign automation

This runbook automates the existing `private-2026q4-003` campaign. It does not create or alter a campaign manifest. The frozen observation implementation is commit `595963cbe9fdd83e77d6286792bb0517e621b54a`; the workflow records its own orchestration revision separately in each successful orchestration record.

The GitHub repository is public. The workflow summary therefore contains only phase statuses and counts. Campaign artifacts, run keys, decisions, asset details, and credentials are never printed or uploaded as GitHub artifacts.

## Security model

Use a private Supabase Storage bucket named `private-campaign-evidence`. The workflow authenticates as a dedicated Supabase Auth user whose `app_metadata.role` is `campaign_automation`. The migration grants that user only `SELECT` and `INSERT` access below its own UID prefix. There is deliberately no update, delete, or upsert permission.

This is narrower than a service-role key, which bypasses all RLS policies and would grant the public repository's workflow broad access to the Supabase project. Do not add a service-role key to GitHub Actions.

Required repository configuration:

| Kind     | Name                                  | Purpose                                                   |
| -------- | ------------------------------------- | --------------------------------------------------------- |
| Variable | `SUPABASE_URL`                        | Supabase project URL                                      |
| Variable | `SUPABASE_PUBLISHABLE_KEY`            | Public Auth API key; RLS still applies                    |
| Secret   | `SUPABASE_CAMPAIGN_EMAIL`             | Dedicated automation user login                           |
| Secret   | `SUPABASE_CAMPAIGN_PASSWORD`          | Dedicated automation user password                        |
| Variable | `PRIVATE_CAMPAIGN_AUTOMATION_ENABLED` | Explicit activation switch; only `true` runs observations |

Never use a personal account for the automation user. Disable sign-up if the project does not require it, use a unique generated password, and set the role in protected app metadata with an administrative tool. The role must not be placed in user-editable metadata.

## Infrastructure setup

1. Apply the repository migrations in the normal reviewed release process.
2. In the Supabase Dashboard, create `private-campaign-evidence` as a **private** bucket. Do not make it public.
3. Create and confirm the dedicated Auth user, then set `app_metadata.role` to `campaign_automation`.
4. Add the variables and secrets above. Leave `PRIVATE_CAMPAIGN_AUTOMATION_ENABLED` unset or `false`.
5. Confirm the storage policies expose only the dedicated user's own UID prefix and do not allow update or delete.

The migration intentionally does not insert directly into `storage.buckets`; Supabase recommends managing Storage objects and buckets through the Storage API or Dashboard rather than treating the Storage schema as an application data model.

## Synthetic acceptance test

Before importing private evidence, run the isolated storage and orchestration-contract tests. They use temporary synthetic campaign fixtures and an in-process storage target; they do not contact Supabase or Binance.

```bash
npm ci --ignore-scripts
npm test -- scripts/privateCampaignStorage.test.ts scripts/observationCampaign.test.ts scripts/evaluationStore.test.ts scripts/outcomeMeasurement.test.ts
npm run typecheck
npm run lint
```

The tests cover fresh-runner restore, identical retries, conflicting content, interrupted upload recovery, delayed/missed slots, duplicate dispatch, configuration/hash mismatch, offline reproduction, and immature outcome suppression. The workflow concurrency group additionally prevents two GitHub jobs from entering the evidence write concurrently and never cancels an in-progress writer.

## Explicit initial import

The ignored local directory `.zerochart-campaigns/private-2026q4-003` is the source of the initial manifest and any existing evidence. Do not add it to git. From a trusted local checkout, set the required values in the shell without echoing them and run:

```bash
CAMPAIGN_ID=private-2026q4-003 \
CAMPAIGN_STORE=.zerochart-campaigns \
SUPABASE_URL="$SUPABASE_URL" \
SUPABASE_PUBLISHABLE_KEY="$SUPABASE_PUBLISHABLE_KEY" \
SUPABASE_CAMPAIGN_BUCKET=private-campaign-evidence \
SUPABASE_CAMPAIGN_EMAIL="$SUPABASE_CAMPAIGN_EMAIL" \
SUPABASE_CAMPAIGN_PASSWORD="$SUPABASE_CAMPAIGN_PASSWORD" \
npx tsx scripts/campaignAutomation.ts import
```

The import hashes every local artifact, performs create-if-absent uploads, downloads each object again, and verifies the hashes. An existing identical object is accepted; conflicting content fails. A lost response after a committed upload is recovered by downloading and verifying the object.

After import, manually dispatch the workflow while the enable variable is still false to confirm the activation gate. Then set `PRIVATE_CAMPAIGN_AUTOMATION_ENABLED=true` and manually dispatch once. Review its sanitized summary and the private bucket before relying on the schedule.

## Runtime behavior

The workflow runs at 06:42 UTC and once more at 08:12 UTC as a bounded retry. GitHub may start scheduled jobs late. The campaign records the actual fetch time and never backdates it. The existing campaign contract selects only the latest due incomplete slot; older missed slots remain missed, and a completed slot is returned without another market-data request.

Every active invocation performs these phases in order:

1. Authenticate with the restricted Auth user and restore all immutable campaign artifacts.
2. Verify the restored manifest and the frozen implementation checkout SHA.
3. Run only the due observation with the frozen implementation.
4. Persist and round-trip verify the evidence before accepting collection success.
5. Reproduce the saved evaluation with network access blocked by the evaluator.
6. Collect outcomes only for observations whose complete frozen 30-day horizon has matured. Zero eligible decisions is successful.
7. Persist the reproduction, matured outcomes, and a separate orchestration-revision record.

Collection, persistence, reproduction, and outcome failures have separate workflow error titles. A zero process exit is not enough: the orchestration also checks the campaign attempt status and reproduction result.

## Recovery, disablement, and backup

- Disable immediately by setting `PRIVATE_CAMPAIGN_AUTOMATION_ENABLED=false`. In-progress writes are not cancelled.
- After a runner interruption, dispatch again. Restore is create-or-verify and completed slots do not refetch.
- A content conflict is not repaired automatically. Disable the workflow, download both copies, determine which credential or process wrote the unexpected bytes, rotate the affected credential, and preserve both files for review.
- A missing or hash-mismatched manifest is a hard stop. Restore the original manifest from a verified backup; never initialize a replacement campaign.
- Back up the private bucket with a trusted account that can read the dedicated UID prefix. Preserve object paths and bytes exactly, and verify SHA-256 hashes after export. Supabase project backups do not necessarily substitute for a separate Storage-object export.
- If GitHub-hosted runners receive a regional Binance HTTP 451, keep automation disabled. Use a persistent, non-laptop self-hosted runner in a legally supported region or an owner-reviewed provider path; do not silently change the frozen campaign source.

No workflow path books orders, writes paper transactions, changes TradingView alerts, or executes trades. The automation only invokes the evaluation campaign, offline reproduction, and research outcome collection commands.
