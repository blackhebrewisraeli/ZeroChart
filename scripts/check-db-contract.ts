// Release gate. `npm run build` runs this before `vite build`, and on a Vercel
// production build it exits 1 unless the database the build points at already
// has everything src/lib/dbContract.ts needs. The deployment then fails and
// Vercel keeps serving the current one. Preview builds only warn: a PR's own
// migrations aren't applied until just before it merges. Outside Vercel (CI,
// local builds) it skips. It reads with the publishable key only.
import { readdirSync } from 'node:fs';
import process from 'node:process';
import { contractGaps, DB_CONTRACT, type ReleaseCatalog } from '../src/lib/dbContract.ts';

const target = process.env['VERCEL_ENV'];
if (target !== 'production' && target !== 'preview') {
  console.log('Database contract: not a Vercel build, skipped.');
  process.exit(0);
}

const url = process.env['VITE_SUPABASE_URL'];
const key = process.env['VITE_SUPABASE_ANON_KEY'] || process.env['VITE_SUPABASE_PUBLISHABLE_KEY'];
const migrations = readdirSync('supabase/migrations').flatMap(
  (file) => /^(\d{14})_\w+\.sql$/.exec(file)?.[1] ?? [],
);

async function gaps(): Promise<string[]> {
  if (!url || !key) return ['VITE_SUPABASE_URL or its publishable key is not set'];
  const response = await fetch(`${url}/rest/v1/rpc/release_contract`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ migrations, functions: Object.keys(DB_CONTRACT) }),
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const { code, message } = body as { code?: string; message?: string };
    return [`release_contract() failed: ${response.status} ${code ?? ''} ${message ?? ''}`.trim()];
  }
  return contractGaps(body as ReleaseCatalog);
}

// Unreachable counts as incompatible: a release nobody could check stays out.
const found = await gaps().catch((error: unknown) => [`could not ask ${url}: ${String(error)}`]);
if (found.length === 0) {
  console.log(
    `Database contract: ${url} has all ${migrations.length} migrations and every RPC this frontend calls.`,
  );
  process.exit(0);
}
const blocking = target === 'production';
console.error(
  [
    `${blocking ? 'Release blocked' : 'Warning'}: the database at ${url} can't serve this frontend yet.`,
    ...found.map((gap) => `  - ${gap}`),
    "Apply this commit's migrations (supabase db push), then redeploy. See docs/RELEASE.md.",
  ].join('\n'),
);
process.exit(blocking ? 1 : 0);
