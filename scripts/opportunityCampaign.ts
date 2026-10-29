import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
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
  | 'MANIFEST_CONFLICT';

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

async function assertCampaignDirectory(store: string, campaignId: string): Promise<string> {
  const root = resolve(store);
  await mkdir(root, { recursive: true });
  const canonicalRoot = await realpath(root);
  const directory = resolve(root, 'campaigns', campaignId);
  await mkdir(directory, { recursive: true });
  const canonicalDirectory = await realpath(directory);
  if (!canonicalDirectory.startsWith(`${canonicalRoot}${sep}`)) {
    throw new OpportunityCampaignError(
      'INVALID_STORAGE_PATH',
      'Campaign directory resolves outside the configured evidence store.',
    );
  }
  return directory;
}

async function createOrVerifyManifest(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new OpportunityCampaignError(
          'INVALID_STORAGE_PATH',
          'Campaign manifest must not be a symbolic link.',
        );
      }
      if ((await readFile(path, 'utf8')) !== content) {
        throw new OpportunityCampaignError(
          'MANIFEST_CONFLICT',
          'Campaign already exists with a different immutable manifest.',
        );
      }
    }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
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
  const slots = opportunitySlots(
    options.startSlot,
    options.endSlot,
    loaded.runtime.schedule,
    loaded.runtime.decisionGate.minimumCalendarSlots,
  );
  const manifest: OpportunityCampaignManifest = {
    schemaVersion: '1',
    campaignId: options.campaignId,
    studyId: loaded.runtime.studyId,
    specificationId: loaded.runtime.specificationId,
    implementationCommit: options.implementationCommit,
    universe: loaded.runtime.universe.map((member) => ({ ...member })),
    schedule: { ...loaded.runtime.schedule },
    startSlot: new Date(options.startSlot).toISOString(),
    endSlot: new Date(options.endSlot).toISOString(),
    slotCount: slots.length,
    slots,
  };
  const directory = await assertCampaignDirectory(options.store, options.campaignId);
  const path = resolve(directory, 'manifest.json');
  await createOrVerifyManifest(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
