// @vitest-environment node

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PrivateStorageConflictError,
  authenticateCampaignStorage,
  persistCampaign,
  restoreCampaign,
} from './privateCampaignStorage';

const campaignId = 'private-2026q4-003';
const ownerId = '00000000-0000-4000-8000-000000000001';
const bucket = 'private-campaign-evidence';
const servers: Array<ReturnType<typeof createServer>> = [];

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function fakeStorage() {
  const objects = new Map<string, Buffer>();
  const interruptOnce = new Set<string>();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/auth/v1/token') {
      json(response, 200, { access_token: 'test-token', user: { id: ownerId } });
      return;
    }
    if (url.pathname === `/storage/v1/object/list/${bucket}` && request.method === 'POST') {
      const input = JSON.parse((await body(request)).toString('utf8')) as {
        prefix: string;
        limit: number;
        offset: number;
      };
      const names = new Map<string, { id: string | null; name: string; metadata: object | null }>();
      for (const key of objects.keys()) {
        if (!key.startsWith(`${input.prefix}/`)) continue;
        const rest = key.slice(input.prefix.length + 1);
        const [name, ...remaining] = rest.split('/');
        if (!name) continue;
        names.set(
          name,
          remaining.length
            ? { id: null, name, metadata: null }
            : { id: `id-${name}`, name, metadata: {} },
        );
      }
      json(
        response,
        200,
        [...names.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(input.offset, input.offset + input.limit),
      );
      return;
    }
    const prefix = `/storage/v1/object/${bucket}/`;
    if (url.pathname.startsWith(prefix)) {
      const key = url.pathname.slice(prefix.length).split('/').map(decodeURIComponent).join('/');
      if (request.method === 'POST') {
        const content = await body(request);
        if (objects.has(key)) {
          json(response, 400, { message: 'Asset Already Exists' });
          return;
        }
        objects.set(key, content);
        if (interruptOnce.delete(key)) {
          request.socket.destroy();
          return;
        }
        json(response, 200, { Key: key });
        return;
      }
      const content = objects.get(key);
      if (!content) {
        json(response, 404, { message: 'not found' });
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      response.end(content);
      return;
    }
    json(response, 404, { message: 'unknown route' });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected test server port');
  const session = await authenticateCampaignStorage({
    baseUrl: `http://127.0.0.1:${address.port}`,
    publishableKey: 'publishable-test-key',
    email: 'campaign@example.invalid',
    password: 'test-password',
    bucket,
  });
  return { objects, interruptOnce, session };
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

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
