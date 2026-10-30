// @vitest-environment node

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  startCampaignStorageFake as fakeStorage,
  STORAGE_OWNER_ID as ownerId,
  stopCampaignStorageFakes,
} from '@/test/campaignStorageFake';
import {
  PrivateStorageConflictError,
  persistCampaign,
  restoreCampaign,
} from './privateCampaignStorage';

const campaignId = 'private-2026q4-003';

afterEach(stopCampaignStorageFakes);

describe('private campaign storage', () => {
  it('imports immutable artifacts, restores them on a fresh runner, and stays idempotent', async () => {
    const { session } = await fakeStorage();
    const source = await mkdtemp(join(tmpdir(), 'campaign-source-'));
    const root = join(source, campaignId);
    await writeFile(join(source, 'unused'), 'not uploaded');
    await import('node:fs/promises').then(({ mkdir }) =>
      mkdir(join(root, 'attempts'), { recursive: true }),
    );
    await writeFile(join(root, 'manifest.json'), '{"campaignId":"private-2026q4-003"}\n');
    await writeFile(join(root, 'attempts', 'one.json'), '{"status":"COMPLETED"}\n');

    await expect(persistCampaign(session, campaignId, root)).resolves.toEqual({
      created: 2,
      verified: 0,
    });
    await expect(persistCampaign(session, campaignId, root)).resolves.toEqual({
      created: 0,
      verified: 2,
    });

    const fresh = join(await mkdtemp(join(tmpdir(), 'campaign-fresh-')), campaignId);
    await expect(restoreCampaign(session, campaignId, fresh)).resolves.toEqual({
      restored: 2,
      verified: 0,
    });
    await expect(readFile(join(fresh, 'attempts', 'one.json'), 'utf8')).resolves.toContain(
      'COMPLETED',
    );
  });

  it('recovers safely when an upload commits but its response is interrupted', async () => {
    const { session, interruptOnce } = await fakeStorage();
    const root = join(await mkdtemp(join(tmpdir(), 'campaign-interrupted-')), campaignId);
    await import('node:fs/promises').then(({ mkdir }) => mkdir(root, { recursive: true }));
    await writeFile(join(root, 'manifest.json'), '{"ok":true}\n');
    interruptOnce.add(`${ownerId}/${campaignId}/manifest.json`);
    await expect(persistCampaign(session, campaignId, root)).resolves.toEqual({
      created: 0,
      verified: 1,
    });
  });

  it('detects conflicting remote content and never overwrites it', async () => {
    const { session, objects } = await fakeStorage();
    const root = join(await mkdtemp(join(tmpdir(), 'campaign-conflict-')), campaignId);
    await import('node:fs/promises').then(({ mkdir }) => mkdir(root, { recursive: true }));
    await writeFile(join(root, 'manifest.json'), '{"local":true}\n');
    objects.set(`${ownerId}/${campaignId}/manifest.json`, Buffer.from('{"remote":true}\n'));
    await expect(persistCampaign(session, campaignId, root)).rejects.toBeInstanceOf(
      PrivateStorageConflictError,
    );
    expect(objects.get(`${ownerId}/${campaignId}/manifest.json`)?.toString()).toContain('remote');
  });
});
