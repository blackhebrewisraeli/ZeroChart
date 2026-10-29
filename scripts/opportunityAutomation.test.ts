// @vitest-environment node

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  startCampaignStorageFake,
  STORAGE_OWNER_ID,
  stopCampaignStorageFakes,
} from '@/test/campaignStorageFake';
import { opportunityPathProvider } from '@/test/opportunityFixtures';
import type { CommandResult } from './campaignAutomation';
import {
  automationSummaryLines,
  durableTransport,
  importOpportunityCampaign,
  main,
  OpportunityAutomationError,
  opportunityStorageId,
  reportFailure,
  runOpportunityAutomation,
  type FrozenImplementation,
} from './opportunityAutomation';
import {
  initializeOpportunityCampaign,
  opportunityRunSummary,
  reproduceOpportunitySlot,
  runOpportunitySlot,
  type FetchOpportunityCandles,
} from './opportunityCampaign';
import { collectOpportunityOutcomes } from './opportunityOutcomes';
import type { NotificationTransport, TransportResult } from './telegramTransport';

const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 30, 0, 30);
const COMMIT = 'a'.repeat(40);
const CAMPAIGN = 'radar-2026';
const REMOTE = `${STORAGE_OWNER_ID}/${opportunityStorageId(CAMPAIGN)}/`;
const iso = (time: number) => new Date(time).toISOString();
const key = (time: number) => iso(time).replaceAll(':', '-');

afterEach(async () => {
  await stopCampaignStorageFakes();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

/** A campaign initialized on the owner's machine and imported to private storage. */
async function importedCampaign() {
  const fake = await startCampaignStorageFake();
  const workstation = await mkdtemp(join(tmpdir(), 'zerochart-workstation-'));
  await initializeOpportunityCampaign({
    campaignId: CAMPAIGN,
    store: workstation,
    startSlot: START,
    endSlot: START + 179 * DAY,
    implementationCommit: COMMIT,
    now: START - DAY,
  });
  await expect(
    importOpportunityCampaign({ campaignId: CAMPAIGN, store: workstation, storage: fake.session }),
  ).resolves.toEqual({ created: 1, verified: 1 });
  return fake;
}

const answer = (value: unknown, exitCode = 0): CommandResult => ({
  exitCode,
  stdout: `> evaluate\n${JSON.stringify(value)}\n`,
  stderr: '',
});

/** The frozen checkout in process: each command answers exactly as the CLI would. */
function frozenAt(
  now: number,
  options: {
    fetchCandles?: FetchOpportunityCandles;
    overrides?: Record<string, () => CommandResult>;
    commit?: string;
    clean?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const fetchCandles = options.fetchCandles ?? opportunityPathProvider().fetchCandles;
  const frozen: FrozenImplementation = {
    commit: async () => options.commit ?? COMMIT,
    clean: async () => options.clean ?? true,
    async run(args) {
      const [name, campaignId] = args as [string, string];
      const store = args[args.indexOf('--store') + 1]!;
      calls.push(name);
      const override = options.overrides?.[name];
      if (override) return override();
      if (name === 'opportunity-campaign-run') {
        const run = await runOpportunitySlot({ campaignId, store, fetchCandles, now: () => now });
        return answer(
          opportunityRunSummary(run),
          ['FAILED', 'MISSED'].includes(run.status) ? 1 : 0,
        );
      }
      if (name === 'opportunity-campaign-reproduce') {
        const receipt = await reproduceOpportunitySlot({
          campaignId,
          store,
          slot: args[args.indexOf('--slot') + 1]!,
          blockNetwork: true,
          now: () => now,
        });
        return answer(receipt, receipt.status === 'MATCH' ? 0 : 1);
      }
      const outcomes = await collectOpportunityOutcomes({
        campaignId,
        store,
        fetchCandles: async () => {
          throw new Error('no horizon matures within these three days');
        },
        now: () => now,
      });
      return answer(outcomes);
    },
  };
  return { calls, frozen };
}

function transport(answers: TransportResult[] = []) {
  const sent: string[] = [];
  const fake: NotificationTransport = {
    channel: 'fake',
    async send(text) {
      sent.push(text);
      return answers.shift() ?? { status: 'DELIVERED', messageId: String(sent.length) };
    },
  };
  return { sent, transport: fake };
}

/** One orchestration on a brand-new runner whose evidence store starts empty. */
async function automate(
  fake: Awaited<ReturnType<typeof startCampaignStorageFake>>,
  now: number,
  options: {
    frozen?: FrozenImplementation;
    transport?: NotificationTransport;
    store?: string;
  } = {},
) {
  return runOpportunityAutomation({
    campaignId: CAMPAIGN,
    store: options.store ?? (await mkdtemp(join(tmpdir(), 'zerochart-runner-'))),
    storage: fake.session,
    frozen: options.frozen ?? frozenAt(now).frozen,
    orchestrationRevision: 'b'.repeat(40),
    ...(options.transport ? { transport: options.transport } : {}),
    now: () => now,
  });
}

function remoteKeys(objects: Map<string, Buffer>, contains: string): string[] {
  return [...objects.keys()].filter((item) => item.startsWith(REMOTE) && item.includes(contains));
}

async function failure(promise: Promise<unknown>): Promise<OpportunityAutomationError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(OpportunityAutomationError);
  const failed = error as OpportunityAutomationError;
  // Public CI logs: never a path, ticker, price or Opportunity.
  expect(failed.message).not.toMatch(/\/|USD|slot\.json|zerochart-/);
  return failed;
}

const NO_NOTIFICATIONS = {
  delivered: 0,
  rejected: 0,
  unknown: 0,
  alreadyDelivered: 0,
  unresolved: 0,
  expired: 0,
  exhausted: 0,
};

describe('Opportunity Radar automation', () => {
  it('runs three days on fresh runners and sends the one Opportunity exactly once', async () => {
    const fake = await importedCampaign();
    const { sent, transport: telegram } = transport();
    const days = [0, 1, 2].map((day) => START + day * DAY + 60_000);

    const summaries = [];
    for (const now of days) summaries.push(await automate(fake, now, { transport: telegram }));

    expect(summaries.map((item) => [item.collection, item.reproduction])).toEqual([
      ['COMPLETED', 'MATCH'],
      ['COMPLETED', 'MATCH'],
      ['COMPLETED', 'MATCH'],
    ]);
    expect(summaries.map((item) => item.notifications)).toEqual([
      NO_NOTIFICATIONS,
      { ...NO_NOTIFICATIONS, delivered: 1 },
      { ...NO_NOTIFICATIONS, alreadyDelivered: 1 },
    ]);
    expect(summaries[1]!.outcomes).toMatchObject({ pending: 4, created: 0, fetchFailed: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('ETH-USD');

    // Everything a later fresh runner needs is in private storage.
    expect(remoteKeys(fake.objects, '/slot.json')).toHaveLength(3);
    expect(remoteKeys(fake.objects, '/reproductions/')).toHaveLength(3);
    expect(remoteKeys(fake.objects, '/orchestrations/')).toHaveLength(3);
    expect(
      remoteKeys(fake.objects, '/notifications/').map((item) => item.split('/').at(-1)),
    ).toEqual(['attempt-1.json', 'result-1.json']);
    for (const line of automationSummaryLines(summaries[1]!)) {
      expect(line).not.toMatch(/USD|\d+\.\d+/);
    }
  });

  it('changes no evidence on an identical same-day retry from another fresh runner', async () => {
    const fake = await importedCampaign();
    const now = START + 60_000;
    await automate(fake, now);
    const slotKey = remoteKeys(fake.objects, '/slot.json')[0]!;
    const slotBytes = fake.objects.get(slotKey)!.toString();
    const before = remoteKeys(fake.objects, '').length;

    await expect(automate(fake, now + 60 * 60_000)).resolves.toMatchObject({
      collection: 'ALREADY_COMPLETED',
      reproduction: 'MATCH',
    });
    expect(fake.objects.get(slotKey)!.toString()).toBe(slotBytes);
    // Only this run's reproduction receipt and orchestration record are new.
    expect(remoteKeys(fake.objects, '').length).toBe(before + 2);
  });

  it('accepts an upload whose response was lost after storage committed it', async () => {
    const fake = await importedCampaign();
    fake.interruptOnce.add(`${REMOTE}slots/${key(START)}/slot.json`);

    await expect(automate(fake, START + 60_000)).resolves.toMatchObject({ reproduction: 'MATCH' });
    expect(remoteKeys(fake.objects, '/slot.json')).toHaveLength(1);
  });

  it('records nothing when the frozen checkout is not the manifest commit or is dirty', async () => {
    const fake = await importedCampaign();
    for (const frozen of [
      frozenAt(START, { commit: 'c'.repeat(40) }),
      frozenAt(START, { clean: false }),
    ]) {
      const failed = await failure(automate(fake, START + 60_000, { frozen: frozen.frozen }));
      expect(failed.stage).toBe('CONFIGURATION');
      expect(frozen.calls).toEqual([]);
    }
    expect(remoteKeys(fake.objects, '/slots/')).toEqual([]);
  });

  it('refuses a campaign that was never imported', async () => {
    const fake = await startCampaignStorageFake();
    const failed = await failure(automate(fake, START + 60_000));
    expect(failed).toMatchObject({ stage: 'RESTORE', message: expect.stringContaining('import') });
  });

  it('stops at restore when the runner holds evidence that conflicts with storage', async () => {
    const fake = await importedCampaign();
    const store = await mkdtemp(join(tmpdir(), 'zerochart-runner-'));
    await mkdir(join(store, 'campaigns', CAMPAIGN), { recursive: true });
    await writeFile(join(store, 'campaigns', CAMPAIGN, 'manifest.json'), '{"tampered":true}\n');
    const remoteManifest = fake.objects.get(`${REMOTE}manifest.json`)!.toString();

    const failed = await failure(automate(fake, START + 60_000, { store }));
    expect(failed).toMatchObject({
      stage: 'RESTORE',
      message: 'Private storage holds different content for an immutable artifact',
    });
    expect(fake.objects.get(`${REMOTE}manifest.json`)!.toString()).toBe(remoteManifest);
  });

  it('persists a failed collection attempt before failing the run', async () => {
    const fake = await importedCampaign();
    const offline = frozenAt(START + 60_000, {
      fetchCandles: async () => {
        throw new Error('Binance klines request failed with status 451');
      },
    });

    const failed = await failure(automate(fake, START + 60_000, { frozen: offline.frozen }));
    expect(failed.stage).toBe('COLLECTION');
    expect(remoteKeys(fake.objects, '/attempt-1.json')).toHaveLength(1);
    expect(offline.calls).toEqual(['opportunity-campaign-run']);
  });

  it('fails at persistence without exposing the object path when storage rejects uploads', async () => {
    const fake = await importedCampaign();
    fake.failUploads.value = true;

    const failed = await failure(automate(fake, START + 60_000));
    expect(failed).toMatchObject({
      stage: 'PERSISTENCE',
      message: 'Private storage request failed',
    });
  });

  it('sends nothing for a slot whose offline reproduction does not match', async () => {
    const fake = await importedCampaign();
    await automate(fake, START + 60_000);
    const { sent, transport: telegram } = transport();
    const mismatch = frozenAt(START + DAY + 60_000, {
      overrides: {
        'opportunity-campaign-reproduce': () =>
          answer({ status: 'MISMATCH', reason: 'OUTPUT_MISMATCH' }, 1),
      },
    });

    const failed = await failure(
      automate(fake, START + DAY + 60_000, { frozen: mismatch.frozen, transport: telegram }),
    );
    expect(failed.stage).toBe('REPRODUCTION');
    expect(sent).toEqual([]);
    expect(mismatch.calls).not.toContain('opportunity-outcomes');
  });

  it('still collects outcomes and records the run before failing a rejected notification', async () => {
    const fake = await importedCampaign();
    await automate(fake, START + 60_000);
    const { transport: telegram } = transport([
      { status: 'REJECTED', httpStatus: 400, description: 'Bad Request: chat not found' },
    ]);
    const day = frozenAt(START + DAY + 60_000);

    const failed = await failure(
      automate(fake, START + DAY + 60_000, { frozen: day.frozen, transport: telegram }),
    );
    expect(failed.stage).toBe('NOTIFICATION');
    expect(day.calls).toContain('opportunity-outcomes');
    expect(remoteKeys(fake.objects, '/orchestrations/')).toHaveLength(2);
    expect(
      remoteKeys(fake.objects, '/notifications/').map((item) => item.split('/').at(-1)),
    ).toEqual(['attempt-1.json', 'result-1.json']);
  });

  it('records the run, then fails on conflicting outcome evidence', async () => {
    const fake = await importedCampaign();
    const conflicting = frozenAt(START + 60_000, {
      overrides: {
        'opportunity-outcomes': () =>
          answer(
            { created: 0, unchanged: 0, recorded: 0, conflicts: 2, pending: 0, fetchFailed: 0 },
            1,
          ),
      },
    });

    const failed = await failure(automate(fake, START + 60_000, { frozen: conflicting.frozen }));
    expect(failed).toMatchObject({
      stage: 'OUTCOME',
      message: 'Outcome collection found 2 conflicting and 0 unfetched records',
    });
    expect(remoteKeys(fake.objects, '/orchestrations/')).toHaveLength(1);
  });
});

describe('owner restore', () => {
  it('downloads the private evidence for local reports without uploading anything', async () => {
    const fake = await importedCampaign();
    await automate(fake, START + 60_000);
    const before = new Map(fake.objects);
    const local = await mkdtemp(join(tmpdir(), 'zerochart-owner-'));
    vi.stubEnv('CAMPAIGN_ID', CAMPAIGN);
    vi.stubEnv('CAMPAIGN_STORE', local);
    vi.stubEnv('SUPABASE_URL', fake.session.baseUrl);
    vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'publishable-test-key');
    vi.stubEnv('SUPABASE_CAMPAIGN_EMAIL', 'campaign@example.invalid');
    vi.stubEnv('SUPABASE_CAMPAIGN_PASSWORD', 'test-password');
    vi.stubEnv('SUPABASE_CAMPAIGN_BUCKET', 'private-campaign-evidence');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let printed: unknown;
    try {
      await main(['node', 'opportunityAutomation.ts', 'restore']);
      printed = stdout.mock.calls[0]?.[0];
    } finally {
      stdout.mockRestore();
    }

    expect(JSON.parse(String(printed))).toEqual({
      restored: remoteKeys(fake.objects, '').length,
      verified: 0,
    });
    expect(fake.objects).toEqual(before);
    await expect(
      readFile(join(local, 'campaigns', CAMPAIGN, 'manifest.json'), 'utf8'),
    ).resolves.toContain(CAMPAIGN);
  });
});

describe('durable notification claims', () => {
  it('persists the claim before sending, and sends nothing if it cannot', async () => {
    const order: string[] = [];
    const inner: NotificationTransport = {
      channel: 'fake',
      async send() {
        order.push('send');
        return { status: 'DELIVERED', messageId: '1' };
      },
    };

    await durableTransport(inner, async () => order.push('persist')).send('x');
    expect(order).toEqual(['persist', 'send']);

    order.length = 0;
    const result = await durableTransport(inner, async () => {
      throw new Error('storage down');
    }).send('x');
    expect(result).toMatchObject({ status: 'REJECTED', httpStatus: 0 });
    expect(order).toEqual([]);
  });
});

describe('automation entry point', () => {
  it('rejects an unknown mode, refuses collection unless enabled, and names missing configuration', async () => {
    await expect(main(['node', 'opportunityAutomation.ts', 'deploy'])).rejects.toMatchObject({
      stage: 'CONFIGURATION',
      message: 'Usage: opportunityAutomation.ts <import|restore|run>',
    });
    await expect(main(['node', 'opportunityAutomation.ts', 'run'])).rejects.toMatchObject({
      stage: 'CONFIGURATION',
      message: 'Collection is disabled until OPPORTUNITY_RADAR_AUTOMATION_ENABLED=true',
    });
    vi.stubEnv('OPPORTUNITY_RADAR_AUTOMATION_ENABLED', 'TRUE');
    await expect(main(['node', 'opportunityAutomation.ts', 'run'])).rejects.toMatchObject({
      message: 'Collection is disabled until OPPORTUNITY_RADAR_AUTOMATION_ENABLED=true',
    });
    vi.stubEnv('OPPORTUNITY_RADAR_AUTOMATION_ENABLED', 'true');
    vi.stubEnv('CAMPAIGN_ID', '');
    await expect(main(['node', 'opportunityAutomation.ts', 'run'])).rejects.toMatchObject({
      stage: 'CONFIGURATION',
      message: 'Missing required configuration: CAMPAIGN_ID',
    });
    vi.stubEnv('CAMPAIGN_ID', '../escape');
    await expect(main(['node', 'opportunityAutomation.ts', 'import'])).rejects.toMatchObject({
      stage: 'CONFIGURATION',
      message: 'Invalid campaign ID',
    });
  });
});

describe('automation failure reporting', () => {
  it('names the failed stage on one line and hides unexpected error text', async () => {
    const summaryPath = join(await mkdtemp(join(tmpdir(), 'zerochart-summary-')), 'summary.md');
    vi.stubEnv('GITHUB_STEP_SUMMARY', summaryPath);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await reportFailure(new Error('ENOENT: /private/store/outcomes/ETH-USD-20d.json'));

    expect(errors).toHaveBeenCalledWith('::error title=CONFIGURATION failure::Unexpected error');
    expect(await readFile(summaryPath, 'utf8')).toContain('failed during configuration');
    expect(process.exitCode).toBe(1);
    errors.mockRestore();
  });
});
