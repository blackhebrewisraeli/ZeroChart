// @vitest-environment node

import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  OpportunityCampaignError,
  campaignManifestPath,
  initializeOpportunityCampaign,
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
