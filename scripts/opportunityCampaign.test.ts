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
  reproduceOpportunitySlot,
  runOpportunitySlot,
  type FetchOpportunityCandles,
  type OpportunitySlotArtifact,
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

describe('Opportunity Radar offline reproduction', () => {
  const SECOND = new Date(START + DAY_MS).toISOString();

  /** Two completed slots, so the second has a previous-slot link to verify. */
  async function completedCampaign() {
    const created = await campaign();
    for (const time of [START, START + DAY_MS]) {
      await runOpportunitySlot({
        campaignId: created.campaignId,
        store: created.root,
        fetchCandles: provider().fetchCandles,
        now: () => time,
      });
    }
    const slotPath = (slot: string) =>
      join(opportunitySlotDirectory(created.directory, slot), 'slot.json');
    return { ...created, slotPath };
  }

  it('matches untouched evidence with the network blocked and restores fetch afterwards', async () => {
    const { root, campaignId } = await completedCampaign();
    const original = globalThis.fetch;
    const fetchSpy = vi.fn<typeof fetch>();
    globalThis.fetch = fetchSpy;
    try {
      const receipt = await reproduceOpportunitySlot({
        campaignId,
        store: root,
        blockNetwork: true,
        now: () => START + 2 * DAY_MS,
      });

      expect(receipt).toMatchObject({
        campaignId,
        slot: SECOND,
        networkBlocked: true,
        status: 'MATCH',
        reason: null,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(globalThis.fetch).toBe(fetchSpy);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('appends a receipt per reproduction and never rewrites the slot', async () => {
    const { root, campaignId, directory, slotPath } = await completedCampaign();
    const before = await readFile(slotPath(SECOND), 'utf8');

    const first = await reproduceOpportunitySlot({ campaignId, store: root, slot: SECOND });
    const second = await reproduceOpportunitySlot({ campaignId, store: root, slot: SECOND });

    expect([first.status, second.status]).toEqual(['MATCH', 'MATCH']);
    expect(first.slotSha256).toBe(createHash('sha256').update(before).digest('hex'));
    expect(
      await readdir(join(opportunitySlotDirectory(directory, SECOND), 'reproductions')),
    ).toHaveLength(2);
    expect(await readFile(slotPath(SECOND), 'utf8')).toBe(before);
  });

  it.each([
    [
      'a changed input candle',
      (artifact: OpportunitySlotArtifact) => {
        artifact.inputs[0]!.candles![199]!.close += 1;
      },
      'INPUT_HASH_MISMATCH',
    ],
    [
      'a changed specification ID',
      (artifact: OpportunitySlotArtifact) => {
        artifact.specificationId = 'f'.repeat(64);
      },
      'SPECIFICATION_MISMATCH',
    ],
    [
      'a changed implementation commit',
      (artifact: OpportunitySlotArtifact) => {
        artifact.implementationCommit = 'b'.repeat(40);
      },
      'IMPLEMENTATION_MISMATCH',
    ],
    [
      'a changed previous-slot link',
      (artifact: OpportunitySlotArtifact) => {
        artifact.previous!.sha256 = '0'.repeat(64);
      },
      'PREVIOUS_SLOT_MISMATCH',
    ],
    [
      'an injected Opportunity',
      (artifact: OpportunitySlotArtifact) => {
        (artifact.result.opportunities as unknown[]).push({ id: `${SECOND}|ETH-USD` });
      },
      'OUTPUT_MISMATCH',
    ],
  ])(
    'reports %s as a specific mismatch without rewriting evidence',
    async (_label, tamper, reason) => {
      const { root, campaignId, slotPath } = await completedCampaign();
      const artifact = JSON.parse(await readFile(slotPath(SECOND), 'utf8'));
      tamper(artifact);
      const tampered = `${JSON.stringify(artifact, null, 2)}\n`;
      await writeFile(slotPath(SECOND), tampered);

      await expect(
        reproduceOpportunitySlot({ campaignId, store: root, slot: SECOND, blockNetwork: true }),
      ).resolves.toMatchObject({ status: 'MISMATCH', reason });
      expect(await readFile(slotPath(SECOND), 'utf8')).toBe(tampered);
    },
  );

  it('breaks the chain when an earlier slot is altered after the next one linked it', async () => {
    const { root, campaignId, slotPath } = await completedCampaign();
    const firstSlot = new Date(START).toISOString();
    await writeFile(slotPath(firstSlot), `${await readFile(slotPath(firstSlot), 'utf8')} `);

    await expect(
      reproduceOpportunitySlot({ campaignId, store: root, slot: SECOND }),
    ).resolves.toMatchObject({ status: 'MISMATCH', reason: 'PREVIOUS_SLOT_MISMATCH' });
    await expect(
      reproduceOpportunitySlot({ campaignId, store: root, slot: firstSlot }),
    ).resolves.toMatchObject({ status: 'MISMATCH', reason: 'ARTIFACT_MISMATCH' });
  });

  it('refuses a changed manifest and a slot that was never completed', async () => {
    const { root, campaignId } = await completedCampaign();

    await expect(
      reproduceOpportunitySlot({
        campaignId,
        store: root,
        slot: new Date(START + 2 * DAY_MS).toISOString(),
      }),
    ).rejects.toMatchObject({ code: 'SLOT_NOT_FOUND' });

    const path = campaignManifestPath(root, campaignId);
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.implementationCommit = 'b'.repeat(40);
    manifest.endSlot = new Date(END + DAY_MS).toISOString();
    await writeFile(path, JSON.stringify(manifest));
    await expect(reproduceOpportunitySlot({ campaignId, store: root })).rejects.toMatchObject({
      code: 'MANIFEST_INVALID',
    });
  });
});

describe('Checkpoint B: synthetic three-slot campaign', () => {
  /** Path day 257 is the last candle slot 1 sees; slots 2 and 3 see days 258 and 259. */
  const PATH_ORIGIN = Date.UTC(2026, 9, 29) - 257 * DAY_MS;

  /** Daily closes compounding the given return; each candle opens at the prior close, ±h wicks. */
  function compounding(dailyReturn: (day: number) => number, h: number) {
    const closes = [100];
    for (let day = 1; day < 300; day += 1) closes.push(closes[day - 1]! * (1 + dailyReturn(day)));
    return { closes, h };
  }

  const PATHS: Record<string, ReturnType<typeof compounding>> = {
    // A long uptrend, an 11-day 3% pullback, then a slow drift: oversold RSI with turning
    // momentum (MEAN_REVERTING, score 85), whose close crosses back above SMA(50) on day 258.
    ETHUSDT: compounding((day) => (day < 201 ? 0.006 : day < 212 ? -0.03 : 0.0001), 0.004),
    // A steady rise keeps the BTC market gate open while BTC itself never qualifies.
    BTCUSDT: compounding(() => 0.002, 0.002),
  };
  const DECLINING = compounding(() => -0.001, 0.002);

  function pathProvider() {
    const calls: string[] = [];
    const fetchCandles: FetchOpportunityCandles = async (instrument, request) => {
      calls.push(instrument);
      const { closes, h } = PATHS[instrument] ?? DECLINING;
      const lastDay = (request.endTime + 1 - DAY_MS - PATH_ORIGIN) / DAY_MS;
      return Array.from({ length: request.limit }, (_, index): Candle => {
        const day = lastDay - (request.limit - 1 - index);
        const timestamp = PATH_ORIGIN + day * DAY_MS;
        const close = closes[day]!;
        const open = closes[day - 1]!;
        return {
          timestamp,
          closeTime: timestamp + DAY_MS - 1,
          open,
          high: Math.max(open, close) * (1 + h),
          low: Math.min(open, close) * (1 - h),
          close,
        };
      });
    };
    return { calls, fetchCandles };
  }

  it('emits exactly one Opportunity, on the false→true slot, and reproduces byte-for-byte', async () => {
    const { root, campaignId, directory } = await campaign();
    const slots = [0, 1, 2].map((day) => START + day * DAY_MS);
    const runs: OpportunitySlotArtifact[] = [];
    for (const slot of slots) {
      const run = await runOpportunitySlot({
        campaignId,
        store: root,
        fetchCandles: pathProvider().fetchCandles,
        now: () => slot + 60_000,
      });
      if (run.status !== 'COMPLETED') throw new Error(`slot ${slot} was ${run.status}`);
      runs.push(run.artifact);
    }
    const eth = (index: number) =>
      runs[index]!.result.assets.find((asset) => asset.ticker === 'ETH-USD');

    expect(runs.map((artifact) => artifact.result.marketGate.passed)).toEqual([true, true, true]);
    expect(runs.map((artifact) => artifact.result.scan.status)).toEqual([
      'COMPLETE',
      'COMPLETE',
      'COMPLETE',
    ]);
    expect(eth(0)).toMatchObject({
      qualified: false,
      reasons: ['CLOSE_NOT_ABOVE_FAST_SMA'],
      newTransition: false,
    });
    expect(eth(1)).toMatchObject({ qualified: true, reasons: [], newTransition: true });
    expect(eth(2)).toMatchObject({ qualified: true, reasons: [], newTransition: false });
    expect(runs.map((artifact) => artifact.previous?.qualifiedTickers ?? null)).toEqual([
      null,
      [],
      ['ETH-USD'],
    ]);
    expect(runs.flatMap((artifact) => artifact.result.opportunities)).toEqual([
      expect.objectContaining({
        id: `${new Date(slots[1]!).toISOString()}|ETH-USD`,
        ticker: 'ETH-USD',
        instrument: 'ETHUSDT',
        evaluationTime: slots[1],
        score: 85,
        regime: 'MEAN_REVERTING',
      }),
    ]);

    const slotPaths = slots.map((slot) =>
      join(opportunitySlotDirectory(directory, new Date(slot).toISOString()), 'slot.json'),
    );
    const before = await Promise.all(slotPaths.map((path) => readFile(path, 'utf8')));

    const rerun = pathProvider();
    await expect(
      runOpportunitySlot({
        campaignId,
        store: root,
        fetchCandles: rerun.fetchCandles,
        now: () => slots[2]! + 2 * 60 * 60_000,
      }),
    ).resolves.toEqual({ status: 'ALREADY_COMPLETED', slot: new Date(slots[2]!).toISOString() });
    expect(rerun.calls).toEqual([]);

    for (const slot of slots) {
      await expect(
        reproduceOpportunitySlot({
          campaignId,
          store: root,
          slot: new Date(slot).toISOString(),
          blockNetwork: true,
        }),
      ).resolves.toMatchObject({ status: 'MATCH', reason: null, networkBlocked: true });
    }
    expect(await Promise.all(slotPaths.map((path) => readFile(path, 'utf8')))).toEqual(before);
  });
});
