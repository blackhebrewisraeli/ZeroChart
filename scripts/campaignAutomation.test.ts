// @vitest-environment node

import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  authenticate: vi.fn(),
  persist: vi.fn(),
  restore: vi.fn(),
  outcomes: vi.fn(),
}));

// The script promisifies execFile, so the stub answers through promisify's hook.
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(() => undefined, { [promisify.custom]: mocks.exec }) };
});
vi.mock('./privateCampaignStorage', () => ({
  authenticateCampaignStorage: mocks.authenticate,
  persistCampaign: mocks.persist,
  restoreCampaign: mocks.restore,
}));
vi.mock('./outcomeMeasurement', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./outcomeMeasurement')>()),
  collectCampaignOutcomes: mocks.outcomes,
}));

const { importExisting, main, reportFailure, runCampaign } = await import('./campaignAutomation');

const campaignId = 'private-2026q4-003';
const commit = 'c'.repeat(40);
const slot = '2026-10-29T00:00:00.000Z';
const storage = { token: 'session' };

type Exec = { stdout: string; stderr: string };
type Answer = Exec | Error;

function failure(code: number, stdout: string): Error {
  return Object.assign(new Error(`exit ${code}`), { code, stdout, stderr: 'failed' });
}

let store: string;
let summary: string;
let answers: { collection: Answer; reproduction: Answer; head: string };

async function withArgv<T>(argv: string[], run: () => Promise<T>): Promise<T> {
  const original = process.argv;
  process.argv = argv;
  try {
    return await run();
  } finally {
    process.argv = original;
  }
}

async function writeManifest(manifest: object) {
  await mkdir(join(store, campaignId), { recursive: true });
  await writeFile(join(store, campaignId, 'manifest.json'), JSON.stringify(manifest));
}

beforeEach(async () => {
  store = await mkdtemp(join(tmpdir(), 'zerochart-automation-'));
  summary = join(store, 'summary.md');
  vi.stubEnv('SUPABASE_URL', 'http://storage.test');
  vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'publishable');
  vi.stubEnv('SUPABASE_CAMPAIGN_EMAIL', 'campaign@example.test');
  vi.stubEnv('SUPABASE_CAMPAIGN_PASSWORD', 'test-password');
  vi.stubEnv('SUPABASE_CAMPAIGN_BUCKET', 'private-campaign-evidence');
  vi.stubEnv('CAMPAIGN_ID', campaignId);
  vi.stubEnv('CAMPAIGN_STORE', store);
  vi.stubEnv('FROZEN_IMPLEMENTATION_DIR', join(store, 'frozen'));
  vi.stubEnv('ORCHESTRATION_REVISION', 'd'.repeat(40));
  vi.stubEnv('GITHUB_STEP_SUMMARY', summary);
  await writeManifest({ campaignId, repositoryCommit: commit });

  answers = {
    head: `${commit}\n`,
    collection: {
      stdout: `> npm run evaluate\n${JSON.stringify({
        alreadyCompleted: false,
        attempt: { slot, observedAt: '2026-10-29T00:05:00.000Z', status: 'COMPLETED', runKey: 'r' },
      })}`,
      stderr: '',
    },
    reproduction: { stdout: JSON.stringify({ status: 'MATCH' }), stderr: '' },
  };
  mocks.exec.mockImplementation(async (file: string, args: string[]) => {
    const answer =
      file === 'git'
        ? { stdout: answers.head, stderr: '' }
        : args.includes('campaign-run')
          ? answers.collection
          : answers.reproduction;
    if (answer instanceof Error) throw answer;
    return answer;
  });
  mocks.authenticate.mockResolvedValue(storage);
  mocks.persist.mockResolvedValue({ created: 2, verified: 1 });
  mocks.restore.mockResolvedValue({ verified: 3, restored: 4 });
  mocks.outcomes.mockResolvedValue({
    eligibleObservations: 1,
    skippedImmatureObservations: 2,
    results: [{ status: 'RECORDED' }],
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('private campaign automation', () => {
  it('imports an existing campaign and verifies a round trip', async () => {
    await importExisting();

    expect(mocks.authenticate).toHaveBeenCalledWith({
      baseUrl: 'http://storage.test',
      publishableKey: 'publishable',
      email: 'campaign@example.test',
      password: 'test-password',
      bucket: 'private-campaign-evidence',
    });
    expect(mocks.persist).toHaveBeenCalledWith(storage, campaignId, join(store, campaignId));
    expect(await readFile(summary, 'utf8')).toBe(
      [
        '## Private campaign import',
        '',
        '- Artifacts created: 2',
        '- Existing artifacts verified: 4',
        '- Round-trip restores verified: 4',
        '',
      ].join('\n'),
    );
  });

  it('runs a due observation, reproduces it offline and records the orchestration', async () => {
    await withArgv(['node', 'automation', 'run'], main);

    expect(mocks.exec).toHaveBeenCalledWith(
      'npm',
      ['run', 'evaluate', '--', 'campaign-run', campaignId, '--store', store],
      expect.objectContaining({ cwd: join(store, 'frozen') }),
    );
    expect(mocks.exec).toHaveBeenCalledWith(
      'npm',
      expect.arrayContaining(['campaign-reproduce', '--slot', slot, '--block-network']),
      expect.anything(),
    );
    expect(mocks.outcomes).toHaveBeenCalledWith(campaignId, store, { maturedOnly: true });
    // Evidence is persisted after every stage, including the orchestration record.
    expect(mocks.persist).toHaveBeenCalledTimes(4);

    const records = await readdir(join(store, campaignId, 'orchestrations'));
    expect(records).toHaveLength(1);
    const record = JSON.parse(
      await readFile(join(store, campaignId, 'orchestrations', records[0]!), 'utf8'),
    );
    expect(record).toMatchObject({
      campaignId,
      implementationCommit: commit,
      slot,
      alreadyCompleted: false,
      reproduction: 'MATCH',
      outcomes: { maturedObservations: 1, skippedImmatureObservations: 2, records: 1 },
    });
    const written = await readFile(summary, 'utf8');
    expect(written).toContain('- Observation: completed');
    expect(written).toContain('- Immature observations skipped: 2');
  });

  it('writes no step summary outside GitHub Actions', async () => {
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');
    await runCampaign();
    await expect(readFile(summary, 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('rejects an unknown mode', async () => {
    await expect(withArgv(['node', 'automation'], main)).rejects.toMatchObject({
      stage: 'CONFIGURATION',
      message: 'Usage: campaignAutomation.ts <import|run>',
    });
  });

  it.each([
    ['a missing setting', 'CAMPAIGN_ID', '', 'Missing required configuration: CAMPAIGN_ID'],
    ['an unsafe campaign ID', 'CAMPAIGN_ID', '../escape', 'Invalid campaign ID'],
    ['an unsafe revision', 'ORCHESTRATION_REVISION', 'x y', 'Invalid orchestration revision'],
  ])('stops on %s before touching storage', async (_label, name, value, message) => {
    vi.stubEnv(name, value);
    await expect(runCampaign()).rejects.toMatchObject({ stage: 'CONFIGURATION', message });
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null, 'Persisted campaign manifest is missing or invalid'],
    [
      'for another campaign',
      { campaignId: 'other-campaign', repositoryCommit: commit },
      'Persisted campaign manifest identity is invalid',
    ],
    [
      'without a commit',
      { campaignId, repositoryCommit: 'main' },
      'Persisted campaign manifest identity is invalid',
    ],
  ])('refuses to import a manifest that is %s', async (_label, manifest, message) => {
    if (manifest) await writeManifest(manifest);
    else await writeFile(join(store, campaignId, 'manifest.json'), '{not json');
    await expect(importExisting()).rejects.toMatchObject({ stage: 'RESTORE', message });
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('stops when the frozen checkout is not the manifest commit', async () => {
    answers.head = `${'e'.repeat(40)}\n`;
    await expect(runCampaign()).rejects.toMatchObject({
      stage: 'CONFIGURATION',
      message: 'Frozen implementation checkout does not match the campaign manifest',
    });
    expect(mocks.exec).toHaveBeenCalledTimes(1);
  });

  it('reports a restore failure', async () => {
    mocks.restore.mockRejectedValue(new Error('object listing failed'));
    await expect(runCampaign()).rejects.toMatchObject({
      stage: 'RESTORE',
      message: 'object listing failed',
    });
  });

  it('reports a persistence failure', async () => {
    mocks.persist.mockRejectedValue('storage conflict');
    await expect(runCampaign()).rejects.toMatchObject({
      stage: 'PERSISTENCE',
      message: 'storage conflict',
    });
  });

  it.each([
    ['emits no JSON', failure(1, 'npm ERR!'), 'Campaign command emitted no JSON (exit 1)'],
    [
      'emits broken JSON',
      { stdout: '{"attempt":', stderr: '' },
      'Campaign command emitted invalid JSON',
    ],
    [
      'records a failed observation',
      failure(1, JSON.stringify({ alreadyCompleted: false, attempt: { slot, status: 'FAILED' } })),
      'Campaign record reports a failed observation',
    ],
  ])('persists then fails when collection %s', async (_label, answer, message) => {
    answers.collection = answer;
    await expect(runCampaign()).rejects.toMatchObject({ stage: 'COLLECTION', message });
    expect(mocks.persist).toHaveBeenCalledTimes(1);
  });

  it('fails when offline reproduction does not match', async () => {
    answers.reproduction = { stdout: JSON.stringify({ status: 'MISMATCH' }), stderr: '' };
    await expect(runCampaign()).rejects.toMatchObject({
      stage: 'REPRODUCTION',
      message: 'Offline campaign reproduction did not match',
    });
    expect(mocks.outcomes).not.toHaveBeenCalled();
  });

  it('persists the evidence before reporting an outcome failure', async () => {
    mocks.outcomes.mockRejectedValue(new Error('candle fetch failed'));
    await expect(runCampaign()).rejects.toMatchObject({
      stage: 'OUTCOME',
      message: 'candle fetch failed',
    });
    expect(mocks.persist).toHaveBeenCalledTimes(3);
  });

  it('fails on conflicting outcome evidence without writing a record', async () => {
    mocks.outcomes.mockResolvedValue({
      eligibleObservations: 1,
      skippedImmatureObservations: 0,
      results: [{ status: 'CONFLICT' }],
    });
    await expect(runCampaign()).rejects.toMatchObject({
      stage: 'OUTCOME',
      message: 'Outcome collection found conflicting evidence',
    });
    await expect(readdir(join(store, campaignId, 'orchestrations'))).rejects.toThrow(/ENOENT/);
  });
});

describe('failure reporting', () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it('annotates the failed stage on one line and omits evidence from the summary', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.restore.mockRejectedValue(new Error('line one\nline two 100%'));
    await reportFailure(await runCampaign().catch((error: unknown) => error));

    expect(log).toHaveBeenCalledWith('::error title=RESTORE failure::line one line two 100 ');
    expect(await readFile(summary, 'utf8')).toBe(
      [
        '## Private observation campaign',
        '',
        '- Status: failed during restore',
        '- Evidence details: omitted because this repository is public',
        '',
      ].join('\n'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('treats an unexpected error as configuration and survives an unwritable summary', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubEnv('GITHUB_STEP_SUMMARY', store);
    await reportFailure('spawn npm ENOENT');

    expect(log).toHaveBeenCalledWith('::error title=CONFIGURATION failure::spawn npm ENOENT');
    expect(process.exitCode).toBe(1);
  });
});
