// @vitest-environment node

import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CandleProviderDataError, ProviderRateLimitError, type Candle } from '@/lib/binance';
import {
  OpportunityCampaignError,
  campaignManifestPath,
  initializeOpportunityCampaign,
  opportunitySlotDirectory,
  runOpportunitySlot,
  type FetchOpportunityCandles,
} from './opportunityCampaign';

const DAY_MS = 86_400_000;
const COMMIT = 'a'.repeat(40);
const NOW = Date.UTC(2026, 9, 29, 12);
const START = Date.UTC(2026, 9, 30, 0, 30);
const END = START + 179 * DAY_MS;

async function store(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'zerochart-opportunity-'));
}

describe('Opportunity Radar campaign initialization', () => {
  it('persists a future-bound manifest with the frozen contract and 180 UTC slots', async () => {
    const root = await store();
    const manifest = await initializeOpportunityCampaign({
      campaignId: 'prospective-2026-10-30',
      store: root,
      startSlot: START,
      endSlot: END,
      implementationCommit: COMMIT,
      now: NOW,
    });

    expect(manifest).toMatchObject({
      schemaVersion: '1',
      campaignId: 'prospective-2026-10-30',
      studyId: 'zerochart-opportunity-radar-binance-spot-v1',
      specificationId: '0eddcc4f81ba47d74168392bb50af64050d3a9db2ab56da914c3814087d64483',
      implementationCommit: COMMIT,
      startSlot: new Date(START).toISOString(),
      endSlot: new Date(END).toISOString(),
      slotCount: 180,
      schedule: { primarySlot: '00:30:00.000Z', retryDeadline: '06:00:00.000Z' },
    });
    expect(manifest.universe).toHaveLength(12);
    expect(manifest.slots).toHaveLength(180);
    expect(manifest.slots[0]).toEqual({
      slot: new Date(START).toISOString(),
      retryDeadline: new Date(Date.UTC(2026, 9, 30, 6)).toISOString(),
    });
    expect(manifest.slots.at(-1)).toEqual({
      slot: new Date(END).toISOString(),
      retryDeadline: new Date(END + 5.5 * 60 * 60_000).toISOString(),
    });

    const persisted = JSON.parse(
      await readFile(campaignManifestPath(root, manifest.campaignId), 'utf8'),
    );
    expect(persisted).toEqual(manifest);
  });

  it.each([
    ['past start', NOW - DAY_MS, NOW - DAY_MS + 179 * DAY_MS, 'FUTURE_START_REQUIRED'],
    ['non-boundary start', START + 1, END + 1, 'INVALID_SLOT_BOUNDARY'],
    ['non-boundary end', START, END + 1, 'INVALID_SLOT_BOUNDARY'],
    ['179-slot range', START, START + 178 * DAY_MS, 'CAMPAIGN_TOO_SHORT'],
  ] as const)('rejects a %s', async (_label, startSlot, endSlot, code) => {
    await expect(
      initializeOpportunityCampaign({
        campaignId: 'prospective-v1',
        store: await store(),
        startSlot,
        endSlot,
        implementationCommit: COMMIT,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code });
  });

  it.each([
    ['../escape', COMMIT, 'INVALID_CAMPAIGN_ID'],
    ['campaign/child', COMMIT, 'INVALID_CAMPAIGN_ID'],
    ['valid-campaign', 'not-a-commit', 'INVALID_IMPLEMENTATION_COMMIT'],
  ] as const)('rejects unsafe identity input %s', async (campaignId, commit, code) => {
    await expect(
      initializeOpportunityCampaign({
        campaignId,
        store: await store(),
        startSlot: START,
        endSlot: END,
        implementationCommit: commit,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code });
  });

  it('accepts a byte-equivalent retry and rejects a conflicting initialization', async () => {
    const root = await store();
    const options = {
      campaignId: 'prospective-v1',
      store: root,
      startSlot: START,
      endSlot: END,
      implementationCommit: COMMIT,
      now: NOW,
    };
    const first = await initializeOpportunityCampaign(options);
    await expect(initializeOpportunityCampaign(options)).resolves.toEqual(first);
    await expect(
      initializeOpportunityCampaign({ ...options, implementationCommit: 'b'.repeat(40) }),
    ).rejects.toBeInstanceOf(OpportunityCampaignError);
    await expect(
      initializeOpportunityCampaign({ ...options, implementationCommit: 'b'.repeat(40) }),
    ).rejects.toMatchObject({ code: 'MANIFEST_CONFLICT' });
  });

  it('refuses a campaign directory symlink that escapes the evidence store', async () => {
    const root = await store();
    const outside = await store();
    await mkdir(join(root, 'campaigns'));
    await symlink(outside, join(root, 'campaigns', 'linked-campaign'));

    await expect(
      initializeOpportunityCampaign({
        campaignId: 'linked-campaign',
        store: root,
        startSlot: START,
        endSlot: END,
        implementationCommit: COMMIT,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STORAGE_PATH' });
  });

  it('fails closed when the supplied specification no longer matches its frozen hash', async () => {
    const root = await store();
    const changed = JSON.parse(await readFile('docs/opportunity-radar.v1.json', 'utf8')) as Record<
      string,
      unknown
    >;
    const schedule = changed['schedule'] as Record<string, unknown>;
    schedule['primarySlot'] = '01:30:00.000Z';
    const path = join(root, 'changed-specification.json');
    await writeFile(path, JSON.stringify(changed));

    await expect(
      initializeOpportunityCampaign({
        campaignId: 'prospective-v1',
        store: root,
        startSlot: START,
        endSlot: END,
        implementationCommit: COMMIT,
        specificationPath: path,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'IDENTIFIER_MISMATCH' });
  });

  it('initializes without making a network request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const root = await store();
    const manifest = await initializeOpportunityCampaign({
      campaignId: 'offline-initialization',
      store: root,
      startSlot: START,
      endSlot: END,
      implementationCommit: COMMIT,
      now: NOW,
    });

    expect(manifest.slots).toHaveLength(180);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

const FROZEN_INSTRUMENTS = [
  'ADAUSDT',
  'AVAXUSDT',
  'BCHUSDT',
  'BNBUSDT',
  'BTCUSDT',
  'DOGEUSDT',
  'DOTUSDT',
  'ETHUSDT',
  'LINKUSDT',
  'LTCUSDT',
  'SOLUSDT',
  'XRPUSDT',
];
const DEADLINE = Date.UTC(2026, 9, 30, 6);

/** Synthetic Binance: `limit` closed daily candles ending at `endTime`; `fail` throws per instrument. */
function provider(fail: Record<string, () => never> = {}) {
  const calls: Array<{ instrument: string; limit: number; endTime: number }> = [];
  const fetchCandles: FetchOpportunityCandles = async (instrument, request) => {
    calls.push({ instrument, ...request });
    fail[instrument]?.();
    const lastOpen = request.endTime + 1 - DAY_MS;
    return Array.from({ length: request.limit }, (_, index): Candle => {
      const timestamp = lastOpen - (request.limit - 1 - index) * DAY_MS;
      const close = 100 + index * 0.1;
      return {
        timestamp,
        closeTime: timestamp + DAY_MS - 1,
        open: close - 0.05,
        high: close + 0.5,
        low: close - 0.5,
        close,
      };
    });
  };
  return { calls, fetchCandles };
}

async function campaign(): Promise<{ root: string; campaignId: string; directory: string }> {
  const root = await store();
  const campaignId = 'slot-collection';
  await initializeOpportunityCampaign({
    campaignId,
    store: root,
    startSlot: START,
    endSlot: END,
    implementationCommit: COMMIT,
    now: NOW,
  });
  return { root, campaignId, directory: join(root, 'campaigns', campaignId) };
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

describe('Opportunity Radar slot collection', () => {
  it('collects 200 closed candles for exactly the twelve frozen instruments and persists the slot', async () => {
    const { root, campaignId, directory } = await campaign();
    const { calls, fetchCandles } = provider();

    const run = await runOpportunitySlot({
      campaignId,
      store: root,
      fetchCandles,
      now: () => START + 60_000,
    });

    expect(run.status).toBe('COMPLETED');
    if (run.status !== 'COMPLETED') return;
    expect(calls.map((call) => call.instrument).sort()).toEqual(FROZEN_INSTRUMENTS);
    expect(new Set(calls.map((call) => `${call.limit}|${call.endTime}`))).toEqual(
      new Set([`200|${Date.UTC(2026, 9, 30) - 1}`]),
    );
    const { artifact } = run;
    expect(artifact.slot).toBe(new Date(START).toISOString());
    expect(artifact.previous).toBeNull();
    expect(artifact.attempts).toEqual([
      expect.objectContaining({ attemptNumber: 1, status: 'COMPLETED', failures: [] }),
    ]);
    expect(artifact.inputs.every((input) => input.candles?.length === 200)).toBe(true);
    expect(
      artifact.inputs.every((input) => input.candles!.every((candle) => candle.closeTime < START)),
    ).toBe(true);
    expect(artifact.result.scan.status).toBe('COMPLETE');
    expect(artifact.result.assets.every((asset) => asset.closedCandles === 200)).toBe(true);
    expect(artifact.result.opportunities).toEqual([]);

    const persisted = JSON.parse(
      await readFile(join(opportunitySlotDirectory(directory, artifact.slot), 'slot.json'), 'utf8'),
    );
    expect(persisted).toEqual(JSON.parse(JSON.stringify(artifact)));
  });

  it('never refetches a completed slot', async () => {
    const { root, campaignId } = await campaign();
    await runOpportunitySlot({
      campaignId,
      store: root,
      fetchCandles: provider().fetchCandles,
      now: () => START,
    });
    const again = provider();

    await expect(
      runOpportunitySlot({
        campaignId,
        store: root,
        fetchCandles: again.fetchCandles,
        now: () => START + 60 * 60_000,
      }),
    ).resolves.toEqual({ status: 'ALREADY_COMPLETED', slot: new Date(START).toISOString() });
    expect(again.calls).toEqual([]);
  });

  it('keeps a rate-limited attempt and completes the same slot on retry', async () => {
    const { root, campaignId, directory } = await campaign();
    const limited = provider({
      SOLUSDT: () => {
        throw new ProviderRateLimitError(429, null);
      },
    });

    const first = await runOpportunitySlot({
      campaignId,
      store: root,
      fetchCandles: limited.fetchCandles,
      now: () => START,
    });
    expect(first.status).toBe('FAILED');
    if (first.status !== 'FAILED') return;
    expect(first.attempt.failures).toContainEqual(
      expect.objectContaining({ ticker: 'SOL-USD', code: 'RATE_LIMITED' }),
    );
    const slotDirectory = opportunitySlotDirectory(directory, first.slot);
    expect(await readdir(slotDirectory)).toEqual(['attempt-1.json']);

    const second = await runOpportunitySlot({
      campaignId,
      store: root,
      fetchCandles: provider().fetchCandles,
      now: () => START + 30 * 60_000,
    });
    expect(second.status).toBe('COMPLETED');
    if (second.status !== 'COMPLETED') return;
    expect(
      second.artifact.attempts.map((attempt) => [attempt.attemptNumber, attempt.status]),
    ).toEqual([
      [1, 'FAILED'],
      [2, 'COMPLETED'],
    ]);
    expect((await readdir(slotDirectory)).sort()).toEqual(['attempt-1.json', 'slot.json']);
  });

  it('completes with provider-invalid data in coverage and no substituted candles', async () => {
    const { root, campaignId } = await campaign();
    const run = await runOpportunitySlot({
      campaignId,
      store: root,
      fetchCandles: provider({
        DOTUSDT: () => {
          throw new CandleProviderDataError('Binance kline row 3 contains a malformed field');
        },
      }).fetchCandles,
      now: () => START,
    });

    expect(run.status).toBe('COMPLETED');
    if (run.status !== 'COMPLETED') return;
    const dot = run.artifact.inputs.find((input) => input.ticker === 'DOT-USD');
    expect(dot).toMatchObject({ error: { code: 'DATA_INVALID' } });
    expect(dot?.candles).toBeUndefined();
    expect(run.artifact.result.scan.status).toBe('PARTIAL');
    expect(run.artifact.result.assets.find((asset) => asset.ticker === 'DOT-USD')).toMatchObject({
      scannerStatus: 'DATA_INVALID',
      qualified: false,
      reasons: ['SCANNER_NOT_EVALUATED'],
    });
  });

  it('is not due before the first slot and is MISSED from the retry deadline on', async () => {
    const { root, campaignId, directory } = await campaign();
    const { calls, fetchCandles } = provider();

    await expect(
      runOpportunitySlot({ campaignId, store: root, fetchCandles, now: () => START - 1 }),
    ).resolves.toEqual({ status: 'NOT_DUE', slot: null });
    await expect(
      runOpportunitySlot({ campaignId, store: root, fetchCandles, now: () => DEADLINE }),
    ).resolves.toEqual({ status: 'MISSED', slot: new Date(START).toISOString() });
    expect(calls).toEqual([]);
    expect(await exists(join(directory, 'slots'))).toBe(false);
  });

  it('fails an attempt whose collection ends at the deadline instead of backdating it', async () => {
    const { root, campaignId } = await campaign();
    const times = [DEADLINE - 1, DEADLINE];

    const run = await runOpportunitySlot({
      campaignId,
      store: root,
      fetchCandles: provider().fetchCandles,
      now: () => times.shift()!,
    });

    expect(run.status).toBe('FAILED');
    if (run.status !== 'FAILED') return;
    expect(run.attempt.failures).toEqual([expect.objectContaining({ code: 'DEADLINE_PASSED' })]);
    await expect(
      runOpportunitySlot({ campaignId, store: root, now: () => DEADLINE + 1 }),
    ).resolves.toMatchObject({ status: 'MISSED' });
  });

  it('links each slot to the exact bytes of the completed slot before it', async () => {
    const { root, campaignId, directory } = await campaign();
    await runOpportunitySlot({
      campaignId,
      store: root,
      fetchCandles: provider().fetchCandles,
      now: () => START,
    });
    const run = await runOpportunitySlot({
      campaignId,
      store: root,
      fetchCandles: provider().fetchCandles,
      now: () => START + DAY_MS,
    });

    expect(run.status).toBe('COMPLETED');
    if (run.status !== 'COMPLETED') return;
    const previousSlot = new Date(START).toISOString();
    const bytes = await readFile(
      join(opportunitySlotDirectory(directory, previousSlot), 'slot.json'),
    );
    expect(run.artifact.previous).toEqual({
      slot: previousSlot,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      status: 'COMPLETE',
      qualifiedTickers: expect.any(Array),
    });
  });

  it('refuses a manifest that no longer matches the frozen specification', async () => {
    const { root, campaignId } = await campaign();
    const path = campaignManifestPath(root, campaignId);
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.universe[0].instrument = 'BTCUSDC';
    await writeFile(path, JSON.stringify(manifest));

    await expect(
      runOpportunitySlot({ campaignId, store: root, now: () => START }),
    ).rejects.toMatchObject({ code: 'MANIFEST_INVALID' });
  });
});
