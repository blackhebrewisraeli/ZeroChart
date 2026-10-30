import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { authenticateCampaignStorage } from '../../scripts/privateCampaignStorage';

export const STORAGE_OWNER_ID = '00000000-0000-4000-8000-000000000001';
const ownerId = STORAGE_OWNER_ID;
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

/** An in-memory Supabase Storage API: create-only uploads, nested listing, injectable failures. */
export async function startCampaignStorageFake() {
  const objects = new Map<string, Buffer>();
  const interruptOnce = new Set<string>();
  /** While true, every upload answers 500 and stores nothing. */
  const failUploads = { value: false };
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
        if (failUploads.value) {
          json(response, 500, { message: 'storage unavailable' });
          return;
        }
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
  return { objects, interruptOnce, failUploads, session };
}

/** Closes every fake started so far; call from afterEach. */
export async function stopCampaignStorageFakes(): Promise<void> {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
}
