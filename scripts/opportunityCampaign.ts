import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fetchSymbolCandles, type Candle } from '@/lib/binance';
import {
  collectScanInputs,
  SCAN_CANDLE_REQUEST,
  SCAN_TIMEFRAME,
  scanInstrument,
  type ScanFetchError,
  type ScanInput,
  type ScanStatus,
} from '@/lib/marketScanner';
import { evaluateOpportunitySlot, type OpportunitySlotResult } from '@/lib/opportunityRadar';
import { stableSerialize } from './evaluationStore';
import { hashInputs, normalizeInputs } from './marketScanStore';
import {
  loadOpportunitySpecification,
  type OpportunityRuntimeConfig,
  type OpportunityUniverseMember,
} from './opportunitySpecification';

const DAY_MS = 86_400_000;
const CAMPAIGN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const GIT_COMMIT = /^[0-9a-f]{40}$/;

export type OpportunityCampaignErrorCode =
  | 'INVALID_CAMPAIGN_ID'
  | 'INVALID_IMPLEMENTATION_COMMIT'
  | 'FUTURE_START_REQUIRED'
  | 'INVALID_SLOT_BOUNDARY'
  | 'INVALID_SLOT_RANGE'
  | 'CAMPAIGN_TOO_SHORT'
  | 'INVALID_STORAGE_PATH'
  | 'MANIFEST_CONFLICT'
  | 'MANIFEST_INVALID'
  | 'EVIDENCE_CONFLICT';

export class OpportunityCampaignError extends Error {
  constructor(
    readonly code: OpportunityCampaignErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OpportunityCampaignError';
  }
}

export interface OpportunityCampaignSlot {
  slot: string;
  retryDeadline: string;
}

export interface OpportunityCampaignManifest {
  schemaVersion: '1';
  campaignId: string;
  studyId: OpportunityRuntimeConfig['studyId'];
  specificationId: OpportunityRuntimeConfig['specificationId'];
  implementationCommit: string;
  universe: OpportunityUniverseMember[];
  schedule: OpportunityRuntimeConfig['schedule'];
  startSlot: string;
  endSlot: string;
  slotCount: number;
  slots: OpportunityCampaignSlot[];
}

export interface InitializeOpportunityCampaignOptions {
  campaignId: string;
  store: string;
  startSlot: number;
  endSlot: number;
  implementationCommit: string;
  specificationPath?: string;
  now?: number;
}

function assertCampaignId(campaignId: string): void {
  if (!CAMPAIGN_ID.test(campaignId)) {
    throw new OpportunityCampaignError(
      'INVALID_CAMPAIGN_ID',
      'Campaign ID must be 1–64 safe ASCII letters, digits, dots, underscores or hyphens.',
    );
  }
}

function timeOfDay(value: string, label: string): number {
  const match = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/.exec(value);
  if (!match) {
    throw new OpportunityCampaignError(
      'INVALID_SLOT_BOUNDARY',
      `Invalid ${label} UTC time: ${value}`,
    );
  }
  const [, hoursText, minutesText, secondsText, millisecondsText] = match;
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  const seconds = Number(secondsText);
  const milliseconds = Number(millisecondsText);
  if (hours > 23 || minutes > 59 || seconds > 59) {
    throw new OpportunityCampaignError(
      'INVALID_SLOT_BOUNDARY',
      `Invalid ${label} UTC time: ${value}`,
    );
  }
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
}

function assertSlotBoundary(slot: number, offset: number, label: string): void {
  if (!Number.isSafeInteger(slot) || ((slot % DAY_MS) + DAY_MS) % DAY_MS !== offset) {
    throw new OpportunityCampaignError(
      'INVALID_SLOT_BOUNDARY',
      `${label} must fall exactly on the frozen UTC primary slot.`,
    );
  }
}

export function opportunitySlots(
  startSlot: number,
  endSlot: number,
  schedule: OpportunityRuntimeConfig['schedule'],
  minimumSlots: number,
): OpportunityCampaignSlot[] {
  const primaryOffset = timeOfDay(schedule.primarySlot, 'primary slot');
  const deadlineOffset = timeOfDay(schedule.retryDeadline, 'retry deadline');
  assertSlotBoundary(startSlot, primaryOffset, 'Start slot');
  assertSlotBoundary(endSlot, primaryOffset, 'End slot');
  if (endSlot < startSlot || (endSlot - startSlot) % DAY_MS !== 0) {
    throw new OpportunityCampaignError(
      'INVALID_SLOT_RANGE',
      'Campaign end slot must be on or after its start slot at a whole-day interval.',
    );
  }
  const slotCount = (endSlot - startSlot) / DAY_MS + 1;
  if (!Number.isSafeInteger(minimumSlots) || minimumSlots <= 0 || slotCount < minimumSlots) {
    throw new OpportunityCampaignError(
      'CAMPAIGN_TOO_SHORT',
      `Campaign has ${slotCount} slots; the frozen decision gate requires at least ${minimumSlots}.`,
    );
  }
  return Array.from({ length: slotCount }, (_, index) => {
    const slot = startSlot + index * DAY_MS;
    const utcDayStart = slot - primaryOffset;
    return {
      slot: new Date(slot).toISOString(),
      retryDeadline: new Date(utcDayStart + deadlineOffset).toISOString(),
    };
  });
}

export function campaignManifestPath(store: string, campaignId: string): string {
  assertCampaignId(campaignId);
  return resolve(store, 'campaigns', campaignId, 'manifest.json');
}

async function assertCampaignDirectory(
  store: string,
  campaignId: string,
  create = true,
): Promise<string> {
  const root = resolve(store);
  if (create) await mkdir(root, { recursive: true });
  const canonicalRoot = await realpath(root);
  const directory = resolve(root, 'campaigns', campaignId);
  if (create) await mkdir(directory, { recursive: true });
  const canonicalDirectory = await realpath(directory);
  if (!canonicalDirectory.startsWith(`${canonicalRoot}${sep}`)) {
    throw new OpportunityCampaignError(
      'INVALID_STORAGE_PATH',
      'Campaign directory resolves outside the configured evidence store.',
    );
  }
  return directory;
}

async function assertNotSymbolicLink(path: string): Promise<void> {
  if ((await lstat(path)).isSymbolicLink()) {
    throw new OpportunityCampaignError(
      'INVALID_STORAGE_PATH',
      'Campaign evidence must not be a symbolic link.',
    );
  }
}

/** Exclusive create; an existing file is accepted only when byte-identical. */
async function createOrVerify(
  path: string,
  content: string,
  conflict: 'MANIFEST_CONFLICT' | 'EVIDENCE_CONFLICT',
): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await assertNotSymbolicLink(path);
      if ((await readFile(path, 'utf8')) !== content) {
        throw new OpportunityCampaignError(
          conflict,
          `Immutable campaign evidence already exists with different content: ${path}`,
        );
      }
    }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function manifestFor(
  runtime: OpportunityRuntimeConfig,
  campaignId: string,
  implementationCommit: string,
  startSlot: number,
  endSlot: number,
): OpportunityCampaignManifest {
  const slots = opportunitySlots(
    startSlot,
    endSlot,
    runtime.schedule,
    runtime.decisionGate.minimumCalendarSlots,
  );
  return {
    schemaVersion: '1',
    campaignId,
    studyId: runtime.studyId,
    specificationId: runtime.specificationId,
    implementationCommit,
    universe: runtime.universe.map((member) => ({ ...member })),
    schedule: { ...runtime.schedule },
    startSlot: new Date(startSlot).toISOString(),
    endSlot: new Date(endSlot).toISOString(),
    slotCount: slots.length,
    slots,
  };
}

/** Create one immutable, future-bound campaign manifest. No market provider is contacted. */
export async function initializeOpportunityCampaign(
  options: InitializeOpportunityCampaignOptions,
): Promise<OpportunityCampaignManifest> {
  assertCampaignId(options.campaignId);
  if (!GIT_COMMIT.test(options.implementationCommit)) {
    throw new OpportunityCampaignError(
      'INVALID_IMPLEMENTATION_COMMIT',
      'Implementation commit must be a full 40-character lowercase Git SHA.',
    );
  }
  if (!Number.isSafeInteger(options.now ?? Date.now())) {
    throw new OpportunityCampaignError('FUTURE_START_REQUIRED', 'Current time must be finite.');
  }
  if (options.startSlot <= (options.now ?? Date.now())) {
    throw new OpportunityCampaignError(
      'FUTURE_START_REQUIRED',
      'Campaign start must be a future logical slot.',
    );
  }

  const loaded = await loadOpportunitySpecification(options.specificationPath);
  const manifest = manifestFor(
    loaded.runtime,
    options.campaignId,
    options.implementationCommit,
    options.startSlot,
    options.endSlot,
  );
  const directory = await assertCampaignDirectory(options.store, options.campaignId);
  const path = resolve(directory, 'manifest.json');
  await createOrVerify(path, serialize(manifest), 'MANIFEST_CONFLICT');
  return manifest;
}

export interface LoadedOpportunityCampaign {
  directory: string;
  manifest: OpportunityCampaignManifest;
  runtime: OpportunityRuntimeConfig;
}

/** Reads a manifest and fails closed unless it is exactly what the frozen specification initializes. */
export async function loadOpportunityCampaign(
  store: string,
  campaignId: string,
  specificationPath?: string,
): Promise<LoadedOpportunityCampaign> {
  assertCampaignId(campaignId);
  const directory = await assertCampaignDirectory(store, campaignId, false);
  const path = resolve(directory, 'manifest.json');
  await assertNotSymbolicLink(path);
  const manifest = JSON.parse(await readFile(path, 'utf8')) as OpportunityCampaignManifest;
  const { runtime } = await loadOpportunitySpecification(specificationPath);
  let expected: OpportunityCampaignManifest | null = null;
  try {
    expected = manifestFor(
      runtime,
      campaignId,
      manifest.implementationCommit,
      Date.parse(manifest.startSlot),
      Date.parse(manifest.endSlot),
    );
  } catch {
    // An unparseable range is reported as an invalid manifest below.
  }
  if (
    expected === null ||
    !GIT_COMMIT.test(manifest.implementationCommit) ||
    stableSerialize(expected) !== stableSerialize(manifest) ||
    manifest.universe.some(
      (member) => scanInstrument(member.ticker) !== `BINANCE:${member.instrument}`,
    )
  ) {
    throw new OpportunityCampaignError(
      'MANIFEST_INVALID',
      'Campaign manifest does not match the frozen Opportunity Radar specification.',
    );
  }
  return { directory, manifest, runtime };
}

/** Fetches one frozen instrument's daily candles; none may open after `endTime`. */
export type FetchOpportunityCandles = (
  instrument: string,
  request: { limit: number; endTime: number },
) => Promise<readonly Candle[]>;

export const fetchOpportunityCandles: FetchOpportunityCandles = (instrument, request) =>
  fetchSymbolCandles(instrument, { interval: SCAN_TIMEFRAME, ...request });

/** A member that was never received: the slot is retried, not completed without it. */
const RETRYABLE_FETCH_CODES: ReadonlySet<string> = new Set(['FETCH_FAILED', 'RATE_LIMITED']);

export interface OpportunitySlotAttempt {
  slot: string;
  attemptNumber: number;
  startedAt: string;
  finishedAt: string;
  status: 'COMPLETED' | 'FAILED';
  /** sha256 of each member's response or recorded failure, as received by this attempt. */
  inputHashes: Record<string, string>;
  failures: Array<{
    ticker: string;
    code: ScanFetchError['code'] | 'DEADLINE_PASSED';
    detail: string;
  }>;
}

export interface OpportunitySlotArtifact {
  schemaVersion: '1';
  evidenceType: 'opportunity-radar-slot';
  campaignId: string;
  specificationId: string;
  implementationCommit: string;
  slot: string;
  candleRequest: { interval: string; limit: number; endTime: string };
  /** The calendar-previous slot transitions were judged against; null when it was not completed. */
  previous: {
    slot: string;
    sha256: string;
    status: ScanStatus;
    qualifiedTickers: string[];
  } | null;
  /** Every failed attempt of this slot, then the completing one. */
  attempts: OpportunitySlotAttempt[];
  inputHashes: Record<string, string>;
  inputs: ScanInput[];
  result: OpportunitySlotResult;
}

export type OpportunitySlotRun =
  | { status: 'NOT_DUE'; slot: null }
  | { status: 'ALREADY_COMPLETED' | 'MISSED'; slot: string }
  | {
      status: 'COMPLETED';
      slot: string;
      attempt: OpportunitySlotAttempt;
      artifact: OpportunitySlotArtifact;
    }
  | { status: 'FAILED'; slot: string; attempt: OpportunitySlotAttempt };

export function opportunitySlotDirectory(campaignDirectory: string, slot: string): string {
  return resolve(campaignDirectory, 'slots', slot.replaceAll(':', '-'));
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    await assertNotSymbolicLink(path);
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function failedAttempts(slotDirectory: string): Promise<OpportunitySlotAttempt[]> {
  const names = await readdir(slotDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const attempts = await Promise.all(
    names
      .filter((name) => /^attempt-\d+\.json$/.test(name))
      .map(
        async (name) =>
          JSON.parse(
            (await readIfPresent(resolve(slotDirectory, name))) ?? 'null',
          ) as OpportunitySlotAttempt,
      ),
  );
  return attempts.sort((a, b) => a.attemptNumber - b.attemptNumber);
}

/**
 * Collects the due logical slot once. A completed slot is never fetched again;
 * a failed attempt is kept and the same slot retried until its deadline; a slot
 * still incomplete at the deadline is MISSED and never backdated.
 */
export async function runOpportunitySlot(options: {
  campaignId: string;
  store: string;
  fetchCandles?: FetchOpportunityCandles;
  now?: () => number;
  specificationPath?: string;
}): Promise<OpportunitySlotRun> {
  const now = options.now ?? Date.now;
  const { directory, manifest, runtime } = await loadOpportunityCampaign(
    options.store,
    options.campaignId,
    options.specificationPath,
  );
  const startedAt = now();
  const due = manifest.slots.filter((entry) => Date.parse(entry.slot) <= startedAt).at(-1);
  if (!due) return { status: 'NOT_DUE', slot: null };
  const slotDirectory = opportunitySlotDirectory(directory, due.slot);
  if ((await readIfPresent(resolve(slotDirectory, 'slot.json'))) !== null) {
    return { status: 'ALREADY_COMPLETED', slot: due.slot };
  }
  const deadline = Date.parse(due.retryDeadline);
  if (startedAt >= deadline) return { status: 'MISSED', slot: due.slot };

  const slotTime = Date.parse(due.slot);
  // Pinning the newest candle to the day that closed before the slot keeps all
  // 200 candles closed (SMA(200) needs them) and makes every retry request
  // the same window.
  const request = { limit: SCAN_CANDLE_REQUEST, endTime: slotTime - (slotTime % DAY_MS) - 1 };
  const instruments = new Map(
    manifest.universe.map((member) => [member.ticker, member.instrument]),
  );
  const fetchCandles = options.fetchCandles ?? fetchOpportunityCandles;
  const inputs = normalizeInputs(
    await collectScanInputs(
      [...instruments.keys()],
      { crypto: (ticker) => fetchCandles(instruments.get(ticker)!, request) },
      { evaluationTime: slotTime },
    ),
  );
  const finishedAt = now();
  const failures: OpportunitySlotAttempt['failures'] = inputs.flatMap((input) =>
    input.error && RETRYABLE_FETCH_CODES.has(input.error.code)
      ? [{ ticker: input.ticker, code: input.error.code, detail: input.error.detail }]
      : [],
  );
  if (finishedAt >= deadline) {
    failures.push({
      ticker: '*',
      code: 'DEADLINE_PASSED',
      detail: `Collection finished at ${new Date(finishedAt).toISOString()}, not before the ${due.retryDeadline} retry deadline.`,
    });
  }
  const priorAttempts = await failedAttempts(slotDirectory);
  const inputHashes = hashInputs(inputs);
  const attempt: OpportunitySlotAttempt = {
    slot: due.slot,
    attemptNumber: priorAttempts.length + 1,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    status: failures.length === 0 ? 'COMPLETED' : 'FAILED',
    inputHashes,
    failures,
  };
  await mkdir(slotDirectory, { recursive: true });
  if (attempt.status === 'FAILED') {
    await createOrVerify(
      resolve(slotDirectory, `attempt-${attempt.attemptNumber}.json`),
      serialize(attempt),
      'EVIDENCE_CONFLICT',
    );
    return { status: 'FAILED', slot: due.slot, attempt };
  }

  const previousSlot = new Date(slotTime - DAY_MS).toISOString();
  const previousBytes = await readIfPresent(
    resolve(opportunitySlotDirectory(directory, previousSlot), 'slot.json'),
  );
  const prior =
    previousBytes === null ? null : (JSON.parse(previousBytes) as OpportunitySlotArtifact);
  const previous =
    prior === null
      ? null
      : {
          slot: previousSlot,
          sha256: createHash('sha256').update(previousBytes!).digest('hex'),
          status: prior.result.scan.status,
          qualifiedTickers: prior.result.assets
            .filter((asset) => asset.qualified)
            .map((asset) => asset.ticker),
        };
  const artifact: OpportunitySlotArtifact = {
    schemaVersion: '1',
    evidenceType: 'opportunity-radar-slot',
    campaignId: manifest.campaignId,
    specificationId: manifest.specificationId,
    implementationCommit: manifest.implementationCommit,
    slot: due.slot,
    candleRequest: {
      interval: SCAN_TIMEFRAME,
      limit: request.limit,
      endTime: new Date(request.endTime).toISOString(),
    },
    previous,
    attempts: [...priorAttempts, attempt],
    inputHashes,
    inputs,
    result: evaluateOpportunitySlot(inputs, runtime, slotTime, previous ?? undefined),
  };
  await createOrVerify(
    resolve(slotDirectory, 'slot.json'),
    serialize(artifact),
    'EVIDENCE_CONFLICT',
  );
  return { status: 'COMPLETED', slot: due.slot, attempt, artifact };
}
