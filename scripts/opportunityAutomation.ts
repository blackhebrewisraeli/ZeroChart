import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { command, writeSummary, type CommandResult } from './campaignAutomation';
import { loadOpportunityCampaign, OpportunityCampaignError } from './opportunityCampaign';
import {
  deliverOpportunityNotifications,
  type NotificationSummary,
} from './opportunityNotification';
import type { OpportunityOutcomeCollection } from './opportunityOutcomes';
import { OPPORTUNITY_SPECIFICATION_ID } from './opportunitySpecification';
import {
  authenticateCampaignStorage,
  persistCampaign,
  PrivateStorageConflictError,
  PrivateStorageError,
  PrivateStorageIntegrityError,
  restoreCampaign,
  type SupabaseStorageSession,
} from './privateCampaignStorage';
import {
  TELEGRAM_CHAT_ENV,
  TELEGRAM_TOKEN_ENV,
  telegramTransportFromEnv,
  type NotificationTransport,
} from './telegramTransport';

const execFileAsync = promisify(execFile);

export type OpportunityStage =
  | 'CONFIGURATION'
  | 'RESTORE'
  | 'COLLECTION'
  | 'PERSISTENCE'
  | 'REPRODUCTION'
  | 'NOTIFICATION'
  | 'OUTCOME';

/** A stage failure whose message is safe for a public CI log: no paths, tickers or prices. */
export class OpportunityAutomationError extends Error {
  constructor(
    readonly stage: OpportunityStage,
    message: string,
  ) {
    super(message);
    this.name = 'OpportunityAutomationError';
  }
}

/** Storage and campaign errors can name evidence paths (and so tickers); only their class is told. */
function publicMessage(error: unknown): string {
  if (error instanceof OpportunityAutomationError) return error.message;
  if (error instanceof PrivateStorageConflictError) {
    return 'Private storage holds different content for an immutable artifact';
  }
  if (error instanceof PrivateStorageIntegrityError)
    return 'Private storage integrity check failed';
  if (error instanceof PrivateStorageError) return 'Private storage request failed';
  if (error instanceof OpportunityCampaignError) {
    return `Campaign evidence check failed (${error.code})`;
  }
  return 'Unexpected error';
}

async function stage<T>(name: OpportunityStage, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw error instanceof OpportunityAutomationError
      ? error
      : new OpportunityAutomationError(name, publicMessage(error));
  }
}

/** The frozen implementation checkout: the only code that writes study evidence. */
export interface FrozenImplementation {
  run(args: string[]): Promise<CommandResult>;
  commit(): Promise<string>;
  clean(): Promise<boolean>;
}

export interface OpportunityAutomationOptions {
  campaignId: string;
  store: string;
  storage: SupabaseStorageSession;
  frozen: FrozenImplementation;
  orchestrationRevision: string;
  /** Absent: notifications are not configured and nothing is sent. */
  transport?: NotificationTransport;
  now?: () => number;
}

export interface OpportunityAutomationSummary {
  slot: string | null;
  collection: 'COMPLETED' | 'ALREADY_COMPLETED' | 'NOT_DUE';
  reproduction: 'MATCH' | 'NOT_APPLICABLE';
  notifications: NotificationSummary | null;
  outcomes: OpportunityOutcomeCollection;
}

/** Remote evidence lives apart from the legacy campaigns, whatever the campaign is called. */
export function opportunityStorageId(campaignId: string): string {
  return `opportunity-radar-${campaignId}`;
}

function parseJson<T>(result: CommandResult, name: OpportunityStage): T {
  const start = result.stdout.indexOf('{');
  try {
    if (start < 0) throw new Error('no JSON');
    return JSON.parse(result.stdout.slice(start)) as T;
  } catch {
    throw new OpportunityAutomationError(
      name,
      `Campaign command emitted no valid JSON (exit ${result.exitCode})`,
    );
  }
}

/**
 * Persists the campaign — including the new attempt record — before handing a
 * message to the transport, so a fresh runner restores the claim and can never
 * send the same Opportunity twice. A claim that cannot be persisted is a
 * definite non-delivery and is retried by a later run.
 */
export function durableTransport(
  transport: NotificationTransport,
  persist: () => Promise<unknown>,
): NotificationTransport {
  return {
    channel: transport.channel,
    async send(text) {
      try {
        await persist();
      } catch {
        return {
          status: 'REJECTED',
          httpStatus: 0,
          description: 'Delivery claim could not be persisted; nothing was sent',
        };
      }
      return transport.send(text);
    },
  };
}

/**
 * One unattended run on a possibly fresh runner: restore, verify the frozen
 * implementation, collect the due slot, persist with round-trip verification,
 * reproduce it offline, notify, collect matured outcomes and record the run.
 * Collection is accepted only after persistence and a reproduction MATCH;
 * evidence is persisted after every stage, including failing ones.
 */
export async function runOpportunityAutomation(
  options: OpportunityAutomationOptions,
): Promise<OpportunityAutomationSummary> {
  const { campaignId, storage, frozen } = options;
  const store = resolve(options.store);
  const root = join(store, 'campaigns', campaignId);
  const remote = opportunityStorageId(campaignId);
  const persist = () => stage('PERSISTENCE', () => persistCampaign(storage, remote, root));

  await stage('RESTORE', () => restoreCampaign(storage, remote, root));
  let manifest: { campaignId?: unknown; specificationId?: unknown; implementationCommit?: unknown };
  try {
    manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as typeof manifest;
  } catch {
    throw new OpportunityAutomationError(
      'RESTORE',
      'Persisted campaign manifest is missing or invalid; import the campaign first',
    );
  }
  if (
    manifest.campaignId !== campaignId ||
    manifest.specificationId !== OPPORTUNITY_SPECIFICATION_ID ||
    typeof manifest.implementationCommit !== 'string' ||
    !/^[0-9a-f]{40}$/.test(manifest.implementationCommit)
  ) {
    throw new OpportunityAutomationError(
      'RESTORE',
      'Persisted campaign manifest identity is invalid',
    );
  }
  const implementationCommit = manifest.implementationCommit;
  await stage('CONFIGURATION', async () => {
    if ((await frozen.commit()) !== implementationCommit || !(await frozen.clean())) {
      throw new OpportunityAutomationError(
        'CONFIGURATION',
        'Frozen implementation checkout does not match the campaign manifest',
      );
    }
  });

  const collection = await stage('COLLECTION', () =>
    frozen.run(['opportunity-campaign-run', campaignId, '--store', store]),
  );
  await persist();
  const run = parseJson<{ status: string; slot: string | null }>(collection, 'COLLECTION');
  if (
    run.status !== 'COMPLETED' &&
    run.status !== 'ALREADY_COMPLETED' &&
    run.status !== 'NOT_DUE'
  ) {
    throw new OpportunityAutomationError(
      'COLLECTION',
      `Slot collection ended ${String(run.status).toLowerCase()}; failed attempts are persisted`,
    );
  }

  let reproduction: OpportunityAutomationSummary['reproduction'] = 'NOT_APPLICABLE';
  let notifications: NotificationSummary | null = null;
  if (run.status !== 'NOT_DUE' && run.slot !== null) {
    const result = await stage('REPRODUCTION', () =>
      frozen.run([
        'opportunity-campaign-reproduce',
        campaignId,
        '--slot',
        run.slot!,
        '--store',
        store,
        '--block-network',
      ]),
    );
    await persist();
    const receipt = parseJson<{ status: string }>(result, 'REPRODUCTION');
    if (result.exitCode !== 0 || receipt.status !== 'MATCH') {
      throw new OpportunityAutomationError(
        'REPRODUCTION',
        'Offline slot reproduction did not match',
      );
    }
    reproduction = 'MATCH';

    // Accepted evidence only: notifications follow a persisted, reproduced slot.
    if (options.transport) {
      notifications = await stage('NOTIFICATION', () =>
        deliverOpportunityNotifications({
          campaignId,
          store,
          transport: durableTransport(options.transport!, () =>
            persistCampaign(storage, remote, root),
          ),
          ...(options.now ? { now: options.now } : {}),
        }),
      );
      await persist();
    }
  }

  const outcome = await stage('OUTCOME', () =>
    frozen.run(['opportunity-outcomes', campaignId, '--store', store, '--matured-only']),
  );
  await persist();
  const outcomes = parseJson<OpportunityOutcomeCollection>(outcome, 'OUTCOME');
  const summary: OpportunityAutomationSummary = {
    slot: run.slot,
    collection: run.status,
    reproduction,
    notifications,
    outcomes,
  };

  const record = {
    schemaVersion: '1',
    campaignId,
    orchestrationRevision: options.orchestrationRevision,
    implementationCommit,
    invokedAt: new Date((options.now ?? Date.now)()).toISOString(),
    persistence: 'VERIFIED',
    ...summary,
  };
  await mkdir(join(root, 'orchestrations'), { recursive: true });
  await writeFile(
    join(root, 'orchestrations', `${record.invokedAt.replaceAll(':', '-')}-${randomUUID()}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  await persist();

  // Fail visibly only after every stage's evidence is persisted.
  if (outcomes.conflicts > 0 || outcomes.fetchFailed > 0) {
    throw new OpportunityAutomationError(
      'OUTCOME',
      `Outcome collection found ${outcomes.conflicts} conflicting and ${outcomes.fetchFailed} unfetched records`,
    );
  }
  if (notifications && (notifications.rejected > 0 || notifications.unknown > 0)) {
    throw new OpportunityAutomationError(
      'NOTIFICATION',
      `${notifications.rejected} notifications rejected and ${notifications.unknown} with unknown delivery`,
    );
  }
  return summary;
}

/** Uploads a locally initialized campaign once, then proves it restores byte-for-byte. */
export async function importOpportunityCampaign(options: {
  campaignId: string;
  store: string;
  storage: SupabaseStorageSession;
}): Promise<{ created: number; verified: number }> {
  const root = join(resolve(options.store), 'campaigns', options.campaignId);
  const remote = opportunityStorageId(options.campaignId);
  await stage('RESTORE', () => loadOpportunityCampaign(options.store, options.campaignId));
  const persisted = await stage('PERSISTENCE', () =>
    persistCampaign(options.storage, remote, root),
  );
  const restored = await stage('RESTORE', () => restoreCampaign(options.storage, remote, root));
  return { created: persisted.created, verified: persisted.verified + restored.verified };
}

/** Counts and phase statuses only; the repository is public. */
export function automationSummaryLines(summary: OpportunityAutomationSummary): string[] {
  const { notifications, outcomes } = summary;
  return [
    '## Private Opportunity Radar campaign',
    '',
    `- Slot: ${{ COMPLETED: 'completed', ALREADY_COMPLETED: 'already complete; no refetch', NOT_DUE: 'not due' }[summary.collection]}`,
    '- Durable persistence: verified',
    `- Offline reproduction: ${summary.reproduction === 'MATCH' ? 'matched' : 'not applicable'}`,
    notifications
      ? `- Notifications: ${notifications.delivered} delivered, ${notifications.alreadyDelivered} already delivered, ${notifications.unresolved} unresolved`
      : '- Notifications: not configured',
    `- Outcome records: ${outcomes.created} created, ${outcomes.unchanged + outcomes.recorded} on file, ${outcomes.pending} horizons pending`,
    '- Evidence, assets, prices and Opportunities: omitted because this repository is public',
  ];
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new OpportunityAutomationError(
      'CONFIGURATION',
      `Missing required configuration: ${name}`,
    );
  }
  return value;
}

function configuredCampaignId(): string {
  const value = required('CAMPAIGN_ID');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new OpportunityAutomationError('CONFIGURATION', 'Invalid campaign ID');
  }
  return value;
}

async function storageSession(): Promise<SupabaseStorageSession> {
  return stage('CONFIGURATION', () =>
    authenticateCampaignStorage({
      baseUrl: required('SUPABASE_URL'),
      publishableKey: required('SUPABASE_PUBLISHABLE_KEY'),
      email: required('SUPABASE_CAMPAIGN_EMAIL'),
      password: required('SUPABASE_CAMPAIGN_PASSWORD'),
      bucket: required('SUPABASE_CAMPAIGN_BUCKET'),
    }),
  );
}

function frozenCheckout(directory: string): FrozenImplementation {
  return {
    run: (args) => command(directory, args),
    commit: async () =>
      (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: directory })).stdout.trim(),
    clean: async () =>
      (await execFileAsync('git', ['status', '--porcelain'], { cwd: directory })).stdout.trim() ===
      '',
  };
}

export async function main(argv = process.argv): Promise<void> {
  const mode = argv[2];
  if (mode === 'import') {
    const result = await importOpportunityCampaign({
      campaignId: configuredCampaignId(),
      store: required('CAMPAIGN_STORE'),
      storage: await storageSession(),
    });
    await writeSummary([
      '## Private Opportunity Radar import',
      '',
      `- Artifacts created: ${result.created}`,
      `- Existing artifacts verified: ${result.verified}`,
    ]);
    return;
  }
  if (mode !== 'run') {
    throw new OpportunityAutomationError(
      'CONFIGURATION',
      'Usage: opportunityAutomation.ts <import|run>',
    );
  }
  const notify = Boolean(process.env[TELEGRAM_TOKEN_ENV] || process.env[TELEGRAM_CHAT_ENV]);
  const summary = await runOpportunityAutomation({
    campaignId: configuredCampaignId(),
    store: required('CAMPAIGN_STORE'),
    storage: await storageSession(),
    frozen: frozenCheckout(resolve(required('FROZEN_IMPLEMENTATION_DIR'))),
    orchestrationRevision: required('ORCHESTRATION_REVISION'),
    ...(notify
      ? { transport: await stage('CONFIGURATION', async () => telegramTransportFromEnv()) }
      : {}),
  });
  await writeSummary(automationSummaryLines(summary));
}

/** One annotation line naming the failed stage; the message is already public-safe. */
export async function reportFailure(error: unknown): Promise<void> {
  const failure =
    error instanceof OpportunityAutomationError
      ? error
      : new OpportunityAutomationError('CONFIGURATION', publicMessage(error));
  await writeSummary([
    '## Private Opportunity Radar campaign',
    '',
    `- Status: failed during ${failure.stage.toLowerCase()}`,
    '- Evidence details: omitted because this repository is public',
  ]).catch(() => undefined);
  console.error(
    `::error title=${failure.stage} failure::${failure.message.replace(/[\r\n%]/g, ' ')}`,
  );
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    await reportFailure(error);
  }
}
