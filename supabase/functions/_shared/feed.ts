// Shared plumbing for the cron-only feed functions (crypto-price-feed,
// equity-forex-price-feed, market-analytics). Deno-only, unlike telemetry.ts.
import { createClient } from 'npm:@supabase/supabase-js@2';

// Service role bypasses RLS: clients lost write access in 20261020230000.
export const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
);

export const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

// The platform's verify_jwt only understands legacy JWT keys, so it is off
// (supabase/config.toml) and the caller must present a project secret key, which
// only the cron job holds (Vault). Anyone else could burn our Binance and Yahoo
// rate limits.
const secretKeys: unknown[] = Object.values(
  JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}'),
);

/** Serves `run` to POSTs from a secret-key holder only. */
export function serveFeed(run: () => Promise<Response>): void {
  Deno.serve((req) => {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const apikey = req.headers.get('apikey');
    if (!apikey || !secretKeys.includes(apikey)) return json({ error: 'Unauthorized' }, 401);
    return run();
  });
}
