import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

export class PrivateStorageError extends Error {}
export class PrivateStorageConflictError extends PrivateStorageError {}
export class PrivateStorageIntegrityError extends PrivateStorageError {}

export interface SupabaseStorageSession {
  baseUrl: string;
  publishableKey: string;
  accessToken: string;
  bucket: string;
  ownerId: string;
  fetch?: typeof fetch;
}

type ListedObject = {
  id?: string | null;
  name?: string;
  metadata?: unknown;
};

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function assertSegment(value: string, label: string): string {
  if (!value || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new PrivateStorageError(`Invalid ${label}`);
  }
  return value;
}

function safeLocalPath(root: string, relativePath: string): string {
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, relativePath);
  if (!absolute.startsWith(`${absoluteRoot}${sep}`) || relativePath.includes('\0')) {
    throw new PrivateStorageError(`Unsafe local campaign path: ${relativePath}`);
  }
  return absolute;
}

function encodedObjectPath(path: string): string {
  return path
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function requestHeaders(session: SupabaseStorageSession): Record<string, string> {
  return {
    apikey: session.publishableKey,
    Authorization: `Bearer ${session.accessToken}`,
  };
}

function storageFetch(session: SupabaseStorageSession): typeof fetch {
  return session.fetch ?? fetch;
}

export async function authenticateCampaignStorage(input: {
  baseUrl: string;
  publishableKey: string;
  email: string;
  password: string;
  bucket: string;
  fetch?: typeof fetch;
}): Promise<SupabaseStorageSession> {
  const fetcher = input.fetch ?? fetch;
  const response = await fetcher(
    `${input.baseUrl.replace(/\/$/, '')}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: {
        apikey: input.publishableKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: input.email, password: input.password }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    throw new PrivateStorageError(`Campaign storage authentication failed (${response.status})`);
  }
  const body = (await response.json()) as { access_token?: string; user?: { id?: string } };
  if (!body.access_token || !body.user?.id) {
    throw new PrivateStorageError('Campaign storage authentication returned an incomplete session');
  }
  return {
    baseUrl: input.baseUrl.replace(/\/$/, ''),
    publishableKey: input.publishableKey,
    accessToken: body.access_token,
    bucket: assertSegment(input.bucket, 'storage bucket'),
    ownerId: assertSegment(body.user.id, 'storage owner'),
    ...(input.fetch ? { fetch: input.fetch } : {}),
  };
}

function campaignPrefix(session: SupabaseStorageSession, campaignId: string): string {
  return `${session.ownerId}/${assertSegment(campaignId, 'campaign ID')}`;
}

async function listDirectory(
  session: SupabaseStorageSession,
  prefix: string,
): Promise<ListedObject[]> {
  const fetcher = storageFetch(session);
  const entries: ListedObject[] = [];
  for (let offset = 0; ; offset += 100) {
    const response = await fetcher(
      `${session.baseUrl}/storage/v1/object/list/${encodeURIComponent(session.bucket)}`,
      {
        method: 'POST',
        headers: { ...requestHeaders(session), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prefix,
          limit: 100,
          offset,
          sortBy: { column: 'name', order: 'asc' },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      throw new PrivateStorageError(`Campaign storage listing failed (${response.status})`);
    }
    const page = (await response.json()) as ListedObject[];
    entries.push(...page);
    if (page.length < 100) return entries;
  }
}

export async function listCampaignObjects(
  session: SupabaseStorageSession,
  campaignId: string,
): Promise<string[]> {
  const root = campaignPrefix(session, campaignId);
  const files: string[] = [];
  const visit = async (prefix: string): Promise<void> => {
    const entries = await listDirectory(session, prefix);
    for (const entry of entries) {
      if (!entry.name || entry.name.includes('/') || entry.name.includes('\0')) {
        throw new PrivateStorageIntegrityError('Storage listing returned an unsafe object name');
      }
      const object = `${prefix}/${entry.name}`;
      if (entry.id == null && entry.metadata == null) await visit(object);
      else files.push(object.slice(root.length + 1));
    }
  };
  await visit(root);
  return files.sort();
}

async function downloadObject(
  session: SupabaseStorageSession,
  campaignId: string,
  relativePath: string,
): Promise<Uint8Array | null> {
  const objectPath = `${campaignPrefix(session, campaignId)}/${relativePath}`;
  const response = await storageFetch(session)(
    `${session.baseUrl}/storage/v1/object/${encodeURIComponent(session.bucket)}/${encodedObjectPath(objectPath)}`,
    {
      headers: requestHeaders(session),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (response.status === 404) return null;
  if (!response.ok)
    throw new PrivateStorageError(`Campaign object download failed (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

async function atomicCreateOrVerify(
  path: string,
  content: Uint8Array,
): Promise<'CREATED' | 'UNCHANGED'> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { flag: 'wx' });
    try {
      await link(temporary, path);
      return 'CREATED';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readFile(path);
      if (sha256(existing) !== sha256(content)) {
        throw new PrivateStorageConflictError(`Local campaign artifact conflicts at ${path}`);
      }
      return 'UNCHANGED';
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function restoreCampaign(
  session: SupabaseStorageSession,
  campaignId: string,
  localCampaignRoot: string,
): Promise<{ restored: number; verified: number }> {
  const objects = await listCampaignObjects(session, campaignId);
  let restored = 0;
  let verified = 0;
  for (const relativePath of objects) {
    const content = await downloadObject(session, campaignId, relativePath);
    if (!content)
      throw new PrivateStorageIntegrityError(`Listed campaign object disappeared: ${relativePath}`);
    const before = sha256(content);
    const result = await atomicCreateOrVerify(
      safeLocalPath(localCampaignRoot, relativePath),
      content,
    );
    const after = sha256(await readFile(safeLocalPath(localCampaignRoot, relativePath)));
    if (before !== after)
      throw new PrivateStorageIntegrityError(`Restore hash mismatch: ${relativePath}`);
    if (result === 'CREATED') restored += 1;
    else verified += 1;
  }
  return { restored, verified };
}

async function localFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await localFiles(root, path)));
    else if (entry.isFile()) {
      const relativePath = relative(root, path).split(sep).join('/');
      if (relativePath.includes('.tmp-')) {
        throw new PrivateStorageIntegrityError(`Incomplete local campaign write: ${relativePath}`);
      }
      files.push(relativePath);
    }
  }
  return files.sort();
}

async function uploadCreateOrVerify(
  session: SupabaseStorageSession,
  campaignId: string,
  relativePath: string,
  content: Uint8Array,
): Promise<'CREATED' | 'UNCHANGED'> {
  const objectPath = `${campaignPrefix(session, campaignId)}/${relativePath}`;
  const response = await storageFetch(session)(
    `${session.baseUrl}/storage/v1/object/${encodeURIComponent(session.bucket)}/${encodedObjectPath(objectPath)}`,
    {
      method: 'POST',
      headers: {
        ...requestHeaders(session),
        'Content-Type': 'application/octet-stream',
        'x-upsert': 'false',
      },
      body: Buffer.from(content),
      signal: AbortSignal.timeout(30_000),
    },
  ).catch(() => null);
  const remote = await downloadObject(session, campaignId, relativePath);
  if (!remote) {
    throw new PrivateStorageError(`Campaign object upload did not persist: ${relativePath}`);
  }
  if (sha256(remote) !== sha256(content)) {
    throw new PrivateStorageConflictError(`Remote campaign artifact conflicts at ${relativePath}`);
  }
  if (!response || !response.ok) return 'UNCHANGED';
  return 'CREATED';
}

export async function persistCampaign(
  session: SupabaseStorageSession,
  campaignId: string,
  localCampaignRoot: string,
): Promise<{ created: number; verified: number }> {
  const files = await localFiles(resolve(localCampaignRoot));
  if (!files.includes('manifest.json')) {
    throw new PrivateStorageIntegrityError(
      'Campaign manifest is missing from the local artifact set',
    );
  }
  let created = 0;
  let verified = 0;
  for (const relativePath of files) {
    const path = safeLocalPath(localCampaignRoot, relativePath);
    const content = await readFile(path);
    const before = sha256(content);
    const result = await uploadCreateOrVerify(session, campaignId, relativePath, content);
    const after = sha256(await readFile(path));
    if (before !== after)
      throw new PrivateStorageIntegrityError(`Local hash changed during upload: ${relativePath}`);
    if (result === 'CREATED') created += 1;
    else verified += 1;
  }
  return { created, verified };
}
