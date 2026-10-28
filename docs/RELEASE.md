# Releasing a change that touches the database

A merge to `main` deploys the frontend to production within about a minute (Vercel's Git integration). Database migrations reach production only when someone runs `supabase db push`. On 2026-10-23 the frontend from PR #75 went live before its migration: Confirm called a six-argument `execute_paper_portfolio` that production didn't have, and returned PGRST202 for about four minutes.

Production builds now refuse to go live against a database that can't serve them.

## The gate

`npm run build` runs [`scripts/check-db-contract.ts`](../scripts/check-db-contract.ts) before `vite build`. On a Vercel production build (`VERCEL_ENV=production`), the script calls the production database's `release_contract()` with the publishable key. The build fails unless:

- every migration in the commit's `supabase/migrations/` is recorded as applied, and
- every RPC listed in [`src/lib/dbContract.ts`](../src/lib/dbContract.ts) resolves to exactly one function for each argument set the frontend sends, and is executable by exactly the roles listed.

A failed build means the deployment never becomes production: Vercel keeps serving the previous one. The failure names each gap, for example:

```text
Release blocked: the database at https://<ref>.supabase.co can't serve this frontend yet.
  - migration 20261023090000 is not applied
  - execute_paper_portfolio(request_id, risk_profile, budget, holdings, dry_run, expected): no function accepts these arguments (PGRST202)
```

The check is read-only. It holds no service-role key, and `release_contract()` answers only about the versions and function names it is sent. If the database can't be reached, the build fails: a release that can't be checked doesn't ship. Preview builds run the same check and only warn, because a PR's migrations aren't applied until just before it merges. CI and local builds skip it.

`DB_CONTRACT` is typed against `src/integrations/supabase/types.ts`, so an argument the typed client can send but the contract leaves out fails `npm run typecheck`. [`src/test/dbContract.test.ts`](../src/test/dbContract.test.ts) fails when a `.rpc()` call in `src/` names a function the contract doesn't list. When you add or change an RPC call, update `types.ts` and `DB_CONTRACT` in the same PR.

### What blocks production activation

| Path                                                                             | Gated?                                                                                               |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Push or merge to `main` (Vercel Git integration)                                 | Yes: production build                                                                                |
| Redeploy in the dashboard, `vercel redeploy`, `vercel deploy --prod`             | Yes: production build                                                                                |
| Promote a preview to production                                                  | Yes: Vercel rebuilds it with production variables                                                    |
| Instant Rollback, or promoting an earlier production deployment                  | No: nothing is rebuilt. It is safe only because migrations are backward compatible (below)           |
| `vercel deploy --prebuilt --prod`                                                | Only if the local `vercel build --prod` ran with `VERCEL_ENV=production`. Not verified; don't use it |
| A custom Build Command in Vercel project settings that skips `npm run build`     | No. The project uses the framework default (`npm run build`); keep it                                |
| GitHub CI (`Lint, typecheck, build & test`, `Database migrations and SQL tests`) | No. The `main` ruleset requires them to merge, but Vercel deploys `main` whatever CI reports         |
| Edge Functions (`supabase functions deploy`)                                     | No. They deploy separately and aren't part of the contract                                           |

## Release order: expand, then contract

1. **Expand.** Write the migration so the frontend in production keeps working: add functions, arguments with defaults, nullable columns. Don't remove or rename anything the live frontend uses. CI's upgrade check applies it on top of `main`'s schema with production-shaped rows.
2. **Apply and verify before merging.** Once the PR is approved, push its migrations from a checkout of the PR's final head commit:

   ```bash
   supabase db push --dry-run
   supabase db push
   ```

   Then check that production accepts this commit's frontend, from the same checkout:

   ```bash
   VERCEL_ENV=production VITE_SUPABASE_URL=https://tldvgvlswananoxafocw.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=<publishable key> node scripts/check-db-contract.ts
   ```

   Don't add commits to the PR after this. To change an applied migration, write a new one.

3. **Release the frontend.** Merge. The production build passes the gate and goes live. In the Vercel build log, the line `Database contract: … has all N migrations and every RPC this frontend calls.` confirms it was checked.
4. **Contract, in a later release.** Remove the old compatibility (a default, an overload, a column) only after a release has shipped a frontend that no longer uses it, and after open tabs on the old bundle have had time to reload. That frontend's `DB_CONTRACT` must no longer need the removed piece, or the gate blocks it. A contract migration also means earlier deployments can no longer be rolled back to (see Rollback).

Migrations without frontend changes follow the same order. The gate only reads the database, so pushing first is always safe for the frontend currently in production.

## Delayed migrations

If a PR merges before its migrations are applied, its production build fails with `Release blocked`, and production stays on the previous deployment, which still works because step 1 kept the database backward compatible. To finish the release:

1. Push the migrations from a checkout of `origin/main` (`git switch --detach origin/main`). `db push` sends only the files in its checkout.
2. Redeploy the failed production deployment (Vercel dashboard → the failed deployment → Redeploy, or `vercel redeploy <deployment-url>`).

Don't bypass the gate to ship around a missing migration. A frontend that the database can't serve is the outage the gate prevents.

## Rollback

- **Frontend:** use Vercel Instant Rollback (`vercel rollback <deployment>`). The earlier frontend runs against the current database, which works as long as no contract step has removed something it uses. Before you roll back past a contract migration, run the check above from the rollback target's commit (commits from this one onward have `check-db-contract.ts`).
- **Database:** migrations are forward-only. Undo one with a new migration that restores what the frontend needs, then release it as usual. Never edit or delete rows in `supabase_migrations.schema_migrations` in production.
- **Both:** roll the frontend back first, then fix the database forward.

## `execute_paper_portfolio(expected)`: drift protection is conditional

`expected` (20261023090000) carries the orders a preview showed. A booking that sends it either books those orders, with every price and quantity within 0.5%, or books nothing (PT409). It defaults to null so that a frontend released before that migration kept working. A null `expected` skips the check.

Callers as of `e5c97f5`, all in [`src/hooks/useProposalExecution.ts`](../src/hooks/useProposalExecution.ts):

| Caller                              | `dry_run` | `expected`           |
| ----------------------------------- | --------- | -------------------- |
| Preview (the effect)                | true      | not sent             |
| `recover()` after a reload          | true      | not sent             |
| `reconcile()` after a lost response | true      | not sent             |
| `confirm()`                         | false     | the previewed orders |

The production bundle (`RoboAdvisor-*.js`, deployment `dpl_qTSFevwQucgUfXXNKkoyKmmZ4xdK`) sends `expected` on its only booking call. A dry run ignores it. The SQL tests call the function directly, with and without it.

So drift protection holds for the shipped UI, but the server does not require it. A booking without `expected`, from a tab still running a pre-#75 bundle or from a direct RPC call by a signed-in user, books at the current server price, however far that has moved. Only the caller's own paper account is affected.

Proposed transition (not done yet; it's a contract step):

1. Done in #75: the server accepts `expected`, and Confirm always sends it.
2. Wait until no booking arrives without it. To make that measurable, a small migration could add `'previewed': expected is not null` to each receipt. Then `select count(*) from paper_order_batches where receipt ->> 'previewed' = 'false'` must stay at 0 for a chosen period.
3. Contract migration: right after the replay lookup, refuse `not dry_run and expected is null` with `check_violation` and a message asking the user to preview again. The replay lookup runs first, so a request ID that already committed still returns its receipt without `expected`, and retries and recovery keep working. Keep the argument's `default null`: previews and recoveries never send it, and `DB_CONTRACT` marks it `sometimes`, so the gate blocks any release that drops the default.

## `dismiss_tactical_signal` (20261028120000)

Dismissal evidence ([DECISION_JOURNAL.md](./DECISION_JOURNAL.md#dismissal-evidence)). The migration only expands: a new table, the RPC and two triggers. It changes no existing grant, policy, function or row, and it backfills nothing.

**Order: database, then frontend.**

1. From a checkout of the PR's final head, `supabase db push --dry-run`, then `supabase db push`. It should list only `20261028120000`.
2. From the same checkout, run the contract check above. It must report every migration applied, `dismiss_tactical_signal(signal_id, reason)` included. Until then the gate blocks this frontend, which calls the RPC.
3. Merge. The production build passes the gate and the new Action Center goes live.

**Between steps 1 and 3**, production still runs the older frontend, which dismisses with a direct `UPDATE` of `trading_signals.status`. The new trigger records each of those dismissals (time, owner as actor, no reason) in the same statement, so none goes unrecorded. Such dismissals show **No reason provided**. An update that matches no row, because another tab resolved the signal first, records nothing, and the old frontend shows no success message for it. No feature flag or other temporary mechanism is needed. Tabs that keep the old bundle open after step 3 behave the same way until they reload.

**Contract step, in a later release.** Revoke the direct path once no old bundle is in use:

```sql
revoke update (status) on public.trading_signals from authenticated;
drop policy "Users can resolve their own pending signals" on public.trading_signals;
```

Keep the recording trigger: it still guards every other path. A dismissal record doesn't say whether the RPC or a direct update wrote it, so old-bundle use can't be measured from it. Wait at least one release after step 3. After the contract step, a stale bundle's Dismiss fails with `42501` and an error toast instead of dismissing. Instant Rollback to a frontend released before `20261028120000` is no longer possible after it.

**Rollback.**

- Frontend: Instant Rollback to an earlier deployment is safe until the contract step. The older bundle's dismissals keep being recorded, without reasons.
- Database: forward-only. Never drop `trading_signal_dismissals` or delete its rows. They are the only record of those dismissals. To withdraw the RPC, revoke its `EXECUTE` in a new migration (and roll the frontend back first, since the gate requires the function). Recorded rows stay readable in the journal.
