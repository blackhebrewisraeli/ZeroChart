import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { collectCampaignOutcomes, OUTCOME_SPECIFICATION_ID } from './outcomeMeasurement';
import {
  authenticateCampaignStorage,
  persistCampaign,
  restoreCampaign,
  type SupabaseStorageSession,
} from './privateCampaignStorage';

const execFileAsync = promisify(execFile);
const FROZEN_OUTCOME_SPECIFICATION_ID =
  '6893a69ee03ae96ca7b1b4d67b1b61d0438096811a06d532f8fb66a3b63e6931';

type Stage =
  'CONFIGURATION' | 'RESTORE' | 'COLLECTION' | 'PERSISTENCE' | 'REPRODUCTION' | 'OUTCOME';

class CampaignAutomationError extends Error {
  constructor(
    readonly stage: Stage,
    message: string,
  ) {
    super(message);
  }
}

type Manifest = {
  campaignId: string;
  repositoryCommit: string;
};

export type CommandResult = { exitCode: number; stdout: string; stderr: string };

function required(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new CampaignAutomationError('CONFIGURATION', `Missing required configuration: ${name}`);
  return value;
}

function safeIdentifier(value: string, label: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,127}$/.test(value)) {
    throw new CampaignAutomationError('CONFIGURATION', `Invalid ${label}`);
  }
  return value;
}

async function session(): Promise<SupabaseStorageSession> {
  return authenticateCampaignStorage({
    baseUrl: required('SUPABASE_URL'),
    publishableKey: required('SUPABASE_PUBLISHABLE_KEY'),
    email: required('SUPABASE_CAMPAIGN_EMAIL'),
    password: required('SUPABASE_CAMPAIGN_PASSWORD'),
    bucket: required('SUPABASE_CAMPAIGN_BUCKET'),
  });
}

export async function command(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<CommandResult> {
  try {
    const result = await execFileAsync('npm', ['run', 'evaluate', '--', ...args], {
      cwd,
      env: { ...env, NO_COLOR: '1' },
      maxBuffer: 20 * 1024 * 1024,
      timeout: 20 * 60_000,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof failed.code === 'number' ? failed.code : 1,
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? failed.message,
    };
  }
}

function parseCommandJson<T>(result: CommandResult, stage: Stage): T {
  const start = result.stdout.indexOf('{');
  if (start < 0)
    throw new CampaignAutomationError(
      stage,
      `Campaign command emitted no JSON (exit ${result.exitCode})`,
    );
  try {
    return JSON.parse(result.stdout.slice(start)) as T;
  } catch {
    throw new CampaignAutomationError(stage, 'Campaign command emitted invalid JSON');
  }
}

async function verifyManifest(
  campaignRoot: string,
  campaignId: string,
  implementationDir?: string,
): Promise<Manifest> {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await readFile(join(campaignRoot, 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    throw new CampaignAutomationError(
      'RESTORE',
      'Persisted campaign manifest is missing or invalid',
    );
  }
  if (manifest.campaignId !== campaignId || !/^[0-9a-f]{40}$/.test(manifest.repositoryCommit)) {
    throw new CampaignAutomationError('RESTORE', 'Persisted campaign manifest identity is invalid');
  }
  if (implementationDir) {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: implementationDir,
    });
    if (stdout.trim() !== manifest.repositoryCommit) {
      throw new CampaignAutomationError(
        'CONFIGURATION',
        'Frozen implementation checkout does not match the campaign manifest',
      );
    }
  }
  return manifest;
}

async function persistOrFail(
  storage: SupabaseStorageSession,
  campaignId: string,
  campaignRoot: string,
) {
  try {
    return await persistCampaign(storage, campaignId, campaignRoot);
  } catch (error) {
    throw new CampaignAutomationError(
      'PERSISTENCE',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function writeSummary(lines: string[]): Promise<void> {
  const path = process.env['GITHUB_STEP_SUMMARY'];
  if (path) await writeFile(path, `${lines.join('\n')}\n`, { flag: 'a' });
}

export async function importExisting(): Promise<void> {
  const campaignId = safeIdentifier(required('CAMPAIGN_ID'), 'campaign ID');
  const store = resolve(required('CAMPAIGN_STORE'));
  const campaignRoot = join(store, campaignId);
  await verifyManifest(campaignRoot, campaignId);
  const storage = await session();
  const persisted = await persistOrFail(storage, campaignId, campaignRoot);
  const restored = await restoreCampaign(storage, campaignId, campaignRoot);
  await writeSummary([
    '## Private campaign import',
    '',
    `- Artifacts created: ${persisted.created}`,
    `- Existing artifacts verified: ${persisted.verified + restored.verified}`,
    `- Round-trip restores verified: ${restored.restored}`,
  ]);
}

export async function runCampaign(): Promise<void> {
  const campaignId = safeIdentifier(required('CAMPAIGN_ID'), 'campaign ID');
  const implementationDir = resolve(required('FROZEN_IMPLEMENTATION_DIR'));
  const store = resolve(required('CAMPAIGN_STORE'));
  const campaignRoot = join(store, campaignId);
  const orchestrationRevision = safeIdentifier(
    required('ORCHESTRATION_REVISION'),
    'orchestration revision',
  );
  const storage = await session();

  try {
    await restoreCampaign(storage, campaignId, campaignRoot);
  } catch (error) {
    throw new CampaignAutomationError(
      'RESTORE',
      error instanceof Error ? error.message : String(error),
    );
  }
  const manifest = await verifyManifest(campaignRoot, campaignId, implementationDir);
  if (OUTCOME_SPECIFICATION_ID !== FROZEN_OUTCOME_SPECIFICATION_ID) {
    throw new CampaignAutomationError(
      'CONFIGURATION',
      'Orchestration outcome specification does not match the reviewed frozen specification',
    );
  }

  const collection = await command(implementationDir, [
    'campaign-run',
    campaignId,
    '--store',
    store,
  ]);
  await persistOrFail(storage, campaignId, campaignRoot);
  const collectionResult = parseCommandJson<{
    alreadyCompleted: boolean;
    attempt: {
      slot: string;
      observedAt: string;
      status: 'COMPLETED' | 'FAILED';
      runKey: string | null;
    };
  }>(collection, 'COLLECTION');

  if (collection.exitCode !== 0 || collectionResult.attempt.status !== 'COMPLETED') {
    throw new CampaignAutomationError('COLLECTION', 'Campaign record reports a failed observation');
  }

  const reproduction = await command(implementationDir, [
    'campaign-reproduce',
    campaignId,
    '--slot',
    collectionResult.attempt.slot,
    '--store',
    store,
    '--block-network',
  ]);
  await persistOrFail(storage, campaignId, campaignRoot);
  const reproductionResult = parseCommandJson<{ status: 'MATCH' | 'MISMATCH' }>(
    reproduction,
    'REPRODUCTION',
  );
  if (reproduction.exitCode !== 0 || reproductionResult.status !== 'MATCH') {
    throw new CampaignAutomationError(
      'REPRODUCTION',
      'Offline campaign reproduction did not match',
    );
  }

  let outcomeResult: Awaited<ReturnType<typeof collectCampaignOutcomes>>;
  try {
    outcomeResult = await collectCampaignOutcomes(campaignId, store, {
      maturedOnly: true,
    });
  } catch (error) {
    await persistOrFail(storage, campaignId, campaignRoot);
    throw new CampaignAutomationError(
      'OUTCOME',
      error instanceof Error ? error.message : String(error),
    );
  }
  await persistOrFail(storage, campaignId, campaignRoot);
  if (outcomeResult.results.some((item) => item.status === 'CONFLICT')) {
    throw new CampaignAutomationError('OUTCOME', 'Outcome collection found conflicting evidence');
  }

  const orchestrationRecord = {
    schemaVersion: '1',
    campaignId,
    orchestrationRevision,
    implementationCommit: manifest.repositoryCommit,
    invokedAt: new Date().toISOString(),
    slot: collectionResult.attempt.slot,
    observedAt: collectionResult.attempt.observedAt,
    alreadyCompleted: collectionResult.alreadyCompleted,
    collection: 'COMPLETED',
    persistence: 'VERIFIED',
    reproduction: 'MATCH',
    outcomes: {
      maturedObservations: outcomeResult.eligibleObservations,
      skippedImmatureObservations: outcomeResult.skippedImmatureObservations,
      records: outcomeResult.results.length,
    },
  };
  const recordDir = join(campaignRoot, 'orchestrations');
  await mkdir(recordDir, { recursive: true });
  await writeFile(
    join(recordDir, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.json`),
    `${JSON.stringify(orchestrationRecord, null, 2)}\n`,
    { flag: 'wx' },
  );
  await persistOrFail(storage, campaignId, campaignRoot);

  await writeSummary([
    '## Private observation campaign',
    '',
    `- Observation: ${collectionResult.alreadyCompleted ? 'already complete; no refetch' : 'completed'}`,
    '- Durable persistence: verified',
    '- Offline reproduction: matched',
    `- Mature outcome records processed: ${outcomeResult.results.length}`,
    `- Immature observations skipped: ${outcomeResult.skippedImmatureObservations}`,
    '- Evidence and asset details: omitted because this repository is public',
  ]);
}

export async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === 'import') await importExisting();
  else if (mode === 'run') await runCampaign();
  else
    throw new CampaignAutomationError('CONFIGURATION', 'Usage: campaignAutomation.ts <import|run>');
}

export async function reportFailure(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const failure =
    error instanceof CampaignAutomationError
      ? error
      : new CampaignAutomationError('CONFIGURATION', message);
  await writeSummary([
    '## Private observation campaign',
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
