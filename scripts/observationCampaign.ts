import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Candle } from '@/lib/binance';
import {
  evaluateInput,
  normalizeEvaluationInput,
  type EvaluationAssetInput,
  type EvaluationConfig,
} from '@/lib/evaluationLab';
import {
  assertConfigurationIntegrity,
  hashEvaluationInput,
  loadEvaluationRun,
  reproduceEvaluationRun,
  saveEvaluationRun,
  stableSerialize,
} from './evaluationStore';
import { configFor, fetchObservationAssets } from './evaluate-canonical';

const DAY_MS = 24 * 60 * 60 * 1000;
const CAMPAIGN_STORE = 'evaluation-store';
const OBSERVATION_TIME = '06:30:00';
const CLOSE_BUFFER_MINUTES = 390;
export const CAMPAIGN_UNIVERSE = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'ADA-USD', 'XRP-USD'] as const;

export interface CampaignManifest {
  schemaVersion: '1';
  campaignId: string;
  createdAt: string;
  evidenceType: 'prospective-live';
  repositoryCommit: string;
  source: 'binance-rest';
  configuration: EvaluationConfig;
  schedule: {
    timezone: 'UTC';
    cadence: 'daily';
    candleCloseTime: '00:00:00';
    observationTime: '06:30:00';
    closeBufferMinutes: 390;
    start: string;
    end: string;
  };
  missingDataPolicy: {
    action: 'fail-slot-and-retry-same-slot';
    substitution: 'none';
    successfulSlotIdempotency: 'do-not-refetch';
  };
}

export interface CampaignAttempt {
  schemaVersion: '1';
  campaignId: string;
  slot: string;
  attemptNumber: number;
  startedAt: string;
  observedAt: string;
  finishedAt: string;
  status: 'COMPLETED' | 'FAILED';
  runKey: string | null;
  candleAsOf: Record<string, string | null>;
  failures: Array<{ asset: string; code: string; detail: string }>;
}

type FetchCandles = (ticker: string, interval?: string, limit?: number) => Promise<Candle[]>;

function campaignRoot(store: string, campaignId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(campaignId)) {
    throw new Error('Campaign ID must be 3-64 lowercase letters, numbers, or hyphens');
  }
  return join(resolve(store), campaignId);
}

function iso(value: string | number | Date): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid UTC timestamp: ${String(value)}`);
  return date.toISOString();
}

function assertSlotBoundary(value: string, label: string): string {
  const normalized = iso(value);
  if (!normalized.endsWith(`T${OBSERVATION_TIME}.000Z`)) {
    throw new Error(`${label} must be a UTC daily observation slot at ${OBSERVATION_TIME}Z`);
  }
  return normalized;
}

function assertManifest(manifest: CampaignManifest): void {
  if (
    manifest.schemaVersion !== '1' ||
    manifest.evidenceType !== 'prospective-live' ||
    manifest.source !== 'binance-rest'
  ) {
    throw new Error('Campaign manifest is not a prospective Binance observation campaign');
  }
  if (!/^[0-9a-f]{40}$/.test(manifest.repositoryCommit)) {
    throw new Error('Campaign repository commit is not a full Git SHA');
  }
  if (
    manifest.schedule.timezone !== 'UTC' ||
    manifest.schedule.cadence !== 'daily' ||
    manifest.schedule.candleCloseTime !== '00:00:00' ||
    manifest.schedule.observationTime !== OBSERVATION_TIME ||
    manifest.schedule.closeBufferMinutes !== CLOSE_BUFFER_MINUTES
  ) {
    throw new Error('Campaign schedule does not match the frozen daily UTC schedule');
  }
  if (
    manifest.missingDataPolicy.action !== 'fail-slot-and-retry-same-slot' ||
    manifest.missingDataPolicy.substitution !== 'none' ||
    manifest.missingDataPolicy.successfulSlotIdempotency !== 'do-not-refetch'
  ) {
    throw new Error('Campaign missing-data policy does not match the frozen policy');
  }
  assertConfigurationIntegrity(manifest.configuration);
  const expected = configFor('moderate', CAMPAIGN_UNIVERSE);
  if (stableSerialize(manifest.configuration) !== stableSerialize(expected)) {
    throw new Error('Campaign configuration does not match the frozen moderate configuration');
  }
  const start = assertSlotBoundary(manifest.schedule.start, 'Campaign start');
  const end = assertSlotBoundary(manifest.schedule.end, 'Campaign end');
  if (Date.parse(start) > Date.parse(end)) throw new Error('Campaign start must not exceed end');
}

async function writeExclusive(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

export async function initializeCampaign(input: {
  campaignId: string;
  start: string;
  end: string;
  repositoryCommit: string;
  store: string;
  now?: Date;
}): Promise<CampaignManifest> {
  const start = assertSlotBoundary(input.start, 'Campaign start');
  const end = assertSlotBoundary(input.end, 'Campaign end');
  if (Date.parse(start) > Date.parse(end)) throw new Error('Campaign start must not exceed end');
  const createdAt = input.now ?? new Date();
  if (Date.parse(start) <= createdAt.getTime()) {
    throw new Error(
      'Campaign start must be a future slot; prospective evidence cannot be backdated',
    );
  }
  if (!/^[0-9a-f]{40}$/.test(input.repositoryCommit)) {
    throw new Error('Repository commit must be a full 40-character Git SHA');
  }
  const manifest: CampaignManifest = {
    schemaVersion: '1',
    campaignId: input.campaignId,
    createdAt: createdAt.toISOString(),
    evidenceType: 'prospective-live',
    repositoryCommit: input.repositoryCommit,
    source: 'binance-rest',
    configuration: configFor('moderate', CAMPAIGN_UNIVERSE),
    schedule: {
      timezone: 'UTC',
      cadence: 'daily',
      candleCloseTime: '00:00:00',
      observationTime: OBSERVATION_TIME,
      closeBufferMinutes: CLOSE_BUFFER_MINUTES,
      start,
      end,
    },
    missingDataPolicy: {
      action: 'fail-slot-and-retry-same-slot',
      substitution: 'none',
      successfulSlotIdempotency: 'do-not-refetch',
    },
  };
  await writeExclusive(
    join(campaignRoot(input.store, input.campaignId), 'manifest.json'),
    manifest,
  );
  return manifest;
}

async function loadManifest(campaignId: string, store: string): Promise<CampaignManifest> {
  const manifest = JSON.parse(
    await readFile(join(campaignRoot(store, campaignId), 'manifest.json'), 'utf8'),
  ) as CampaignManifest;
  if (manifest.campaignId !== campaignId) throw new Error('Campaign ID does not match manifest');
  assertManifest(manifest);
  return manifest;
}

function slotsThrough(manifest: CampaignManifest, now: Date): string[] {
  const start = Date.parse(manifest.schedule.start);
  const end = Math.min(Date.parse(manifest.schedule.end), now.getTime());
  const slots: string[] = [];
  for (let value = start; value <= end; value += DAY_MS) slots.push(new Date(value).toISOString());
  return slots;
}

async function loadAttempts(root: string): Promise<CampaignAttempt[]> {
  const directory = join(root, 'attempts');
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const attempts = await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map(
        async (name) =>
          JSON.parse(await readFile(join(directory, name), 'utf8')) as CampaignAttempt,
      ),
  );
  return attempts.sort((a, b) => a.slot.localeCompare(b.slot) || a.attemptNumber - b.attemptNumber);
}

async function saveAttempt(root: string, attempt: CampaignAttempt): Promise<void> {
  const name = `${attempt.slot.replaceAll(':', '-')}-${attempt.attemptNumber}-${randomUUID()}.json`;
  await writeExclusive(join(root, 'attempts', name), attempt);
}

function attemptFailures(run: ReturnType<typeof evaluateInput>) {
  return run.decisions.flatMap((decision) =>
    decision.rejectionReasons
      .filter((reason) =>
        ['DATA_UNAVAILABLE', 'DATA_FETCH_FAILED', 'STALE_DATA', 'INSUFFICIENT_HISTORY'].includes(
          reason.code,
        ),
      )
      .map((reason) => ({ asset: decision.asset, code: reason.code, detail: reason.detail })),
  );
}

export async function runDueCampaign(
  campaignId: string,
  store: string,
  options: { now?: Date; fetchCandles?: FetchCandles } = {},
): Promise<{ alreadyCompleted: boolean; attempt: CampaignAttempt }> {
  const root = campaignRoot(store, campaignId);
  const manifest = await loadManifest(campaignId, store);
  const now = options.now ?? new Date();
  const due = slotsThrough(manifest, now);
  const slot = due.at(-1);
  if (!slot) throw new Error('No campaign observation slot is due');
  const attempts = await loadAttempts(root);
  const completed = attempts.find(
    (attempt) => attempt.slot === slot && attempt.status === 'COMPLETED',
  );
  if (completed) return { alreadyCompleted: true, attempt: completed };

  const startedAt = new Date().toISOString();
  const attemptNumber = attempts.filter((attempt) => attempt.slot === slot).length + 1;
  let assets: EvaluationAssetInput[] = [];
  try {
    assets = await fetchObservationAssets(CAMPAIGN_UNIVERSE, options.fetchCandles);
    const slotTime = Date.parse(slot);
    assets = assets.map((asset) => ({
      ...asset,
      candles: asset.candles.filter((candle) => candle.closeTime <= slotTime),
    }));
    const observedAt = new Date().toISOString();
    const input = normalizeEvaluationInput({ evaluationTime: slotTime, assets });
    const run = evaluateInput(input, manifest.configuration, hashEvaluationInput(input));
    const failures = attemptFailures(run);
    const attempt: CampaignAttempt = {
      schemaVersion: '1',
      campaignId,
      slot,
      attemptNumber,
      startedAt,
      observedAt,
      finishedAt: new Date().toISOString(),
      status: failures.length === 0 ? 'COMPLETED' : 'FAILED',
      runKey: failures.length === 0 ? run.runKey : null,
      candleAsOf: Object.fromEntries(
        run.decisions.map((decision) => [
          decision.asset,
          decision.dataAsOf === null ? null : new Date(decision.dataAsOf).toISOString(),
        ]),
      ),
      failures,
    };
    if (attempt.status === 'COMPLETED') {
      await saveEvaluationRun(run, join(root, CAMPAIGN_STORE));
    }
    await saveAttempt(root, attempt);
    return { alreadyCompleted: false, attempt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const attempt: CampaignAttempt = {
      schemaVersion: '1',
      campaignId,
      slot,
      attemptNumber,
      startedAt,
      observedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: 'FAILED',
      runKey: null,
      candleAsOf: Object.fromEntries(
        assets.map((asset) => [
          asset.ticker,
          asset.candles.at(-1)?.closeTime
            ? new Date(asset.candles.at(-1)!.closeTime).toISOString()
            : null,
        ]),
      ),
      failures: [{ asset: '*', code: 'CAMPAIGN_RUN_FAILED', detail: message }],
    };
    await saveAttempt(root, attempt);
    return { alreadyCompleted: false, attempt };
  }
}

export async function reproduceCampaignRun(
  campaignId: string,
  store: string,
  requestedSlot?: string,
  blockNetwork = false,
  now = new Date(),
) {
  const root = campaignRoot(store, campaignId);
  const manifest = await loadManifest(campaignId, store);
  const attempts = await loadAttempts(root);
  const slot = requestedSlot
    ? iso(requestedSlot)
    : [...attempts].reverse().find((attempt) => attempt.status === 'COMPLETED')?.slot;
  const attempt = attempts.find((item) => item.slot === slot && item.status === 'COMPLETED');
  if (!attempt?.runKey)
    throw new Error(`No successful campaign observation for ${slot ?? 'any slot'}`);
  const stored = await loadEvaluationRun(attempt.runKey, join(root, CAMPAIGN_STORE));
  if (stableSerialize(stored.contract) !== stableSerialize(manifest.configuration)) {
    throw new Error('Saved run configuration does not match campaign manifest');
  }
  const originalFetch = globalThis.fetch;
  if (blockNetwork)
    globalThis.fetch = () => Promise.reject(new Error('network explicitly blocked'));
  let result: Awaited<ReturnType<typeof reproduceEvaluationRun>>;
  try {
    result = await reproduceEvaluationRun(attempt.runKey, join(root, CAMPAIGN_STORE));
  } finally {
    globalThis.fetch = originalFetch;
  }
  await writeExclusive(
    join(root, 'reproductions', `${slot!.replaceAll(':', '-')}-${randomUUID()}.json`),
    {
      schemaVersion: '1',
      campaignId,
      slot,
      reproducedAt: now.toISOString(),
      networkBlocked: blockNetwork,
      status: result.status,
      runKey: result.runKey,
    },
  );
  return { ...result, campaignId, slot, networkBlocked: blockNetwork };
}

export async function campaignReport(campaignId: string, store: string, now = new Date()) {
  const root = campaignRoot(store, campaignId);
  const manifest = await loadManifest(campaignId, store);
  const due = slotsThrough(manifest, now);
  const attempts = await loadAttempts(root);
  const successful = new Map(
    attempts
      .filter((attempt) => attempt.status === 'COMPLETED' && attempt.runKey)
      .map((attempt) => [attempt.slot, attempt]),
  );
  const attemptedSlots = new Set(attempts.map((attempt) => attempt.slot));
  const latestDue = due.at(-1);
  const missed = due.filter(
    (slot) => slot !== latestDue && !attemptedSlots.has(slot) && !successful.has(slot),
  );
  const failed = due.filter((slot) => attemptedSlots.has(slot) && !successful.has(slot));
  const pending = due.filter((slot) => !attemptedSlots.has(slot) && slot === latestDue);
  const runs = await Promise.all(
    [...successful.values()].map((attempt) =>
      loadEvaluationRun(attempt.runKey!, join(root, CAMPAIGN_STORE)),
    ),
  );
  for (const stored of runs) {
    if (stableSerialize(stored.contract) !== stableSerialize(manifest.configuration)) {
      throw new Error('Saved run configuration does not match campaign manifest');
    }
  }
  const reproductionDirectory = join(root, 'reproductions');
  const reproductionNames = await readdir(reproductionDirectory).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  const reproductions = await Promise.all(
    reproductionNames
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => JSON.parse(await readFile(join(reproductionDirectory, name), 'utf8'))),
  );
  const rejectionReasons: Record<string, number> = {};
  for (const { run } of runs) {
    for (const [reason, count] of Object.entries(run.coverage.rejectionReasons)) {
      rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + count;
    }
  }
  return {
    campaignId,
    evidenceType: manifest.evidenceType,
    repositoryCommit: manifest.repositoryCommit,
    schedule: manifest.schedule,
    modelVersion: manifest.configuration.modelVersion,
    strategyVersion: manifest.configuration.strategyVersion,
    configurationId: manifest.configuration.configurationId,
    riskProfile: manifest.configuration.riskProfile,
    universe: manifest.configuration.universe,
    freshness: { maxDataAgeMs: manifest.configuration.maxDataAgeMs, source: manifest.source },
    slots: {
      expected: due.length,
      completed: successful.size,
      failed: failed.length,
      missed: missed.length,
      pending: pending.length,
      retryAttempts: attempts.length - attemptedSlots.size,
    },
    attempts,
    coverage: {
      assets: runs.reduce((sum, { run }) => sum + run.coverage.assets, 0),
      eligible: runs.reduce((sum, { run }) => sum + run.coverage.eligible, 0),
      selected: runs.reduce((sum, { run }) => sum + run.coverage.selected, 0),
      qualifiedNotSelected: runs.reduce(
        (sum, { run }) => sum + run.coverage.qualifiedNotSelected,
        0,
      ),
      rejected: runs.reduce((sum, { run }) => sum + run.coverage.rejected, 0),
      rejectionReasons,
    },
    reproductions,
    performanceMetrics: 'not measurable: no complete executable entry/exit strategy contract',
  };
}

export async function loadCampaignEvidence(campaignId: string, store: string, now = new Date()) {
  const report = await campaignReport(campaignId, store, now);
  const root = campaignRoot(store, campaignId);
  const observations = await Promise.all(
    report.attempts
      .filter(
        (attempt): attempt is CampaignAttempt & { runKey: string } =>
          attempt.status === 'COMPLETED' && Boolean(attempt.runKey),
      )
      .map(async (attempt) => ({
        slot: attempt.slot,
        observedAt: attempt.observedAt,
        attemptNumber: attempt.attemptNumber,
        run: (await loadEvaluationRun(attempt.runKey, join(root, CAMPAIGN_STORE))).run,
      })),
  );
  return { report, observations };
}
