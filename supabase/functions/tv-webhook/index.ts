// TradingView alert webhook → trading_signals (PENDING). TradingView can't send
// a Supabase JWT, so verify_jwt is off (supabase/config.toml) and the body's
// secret_token, minted by rotate_signal_webhook_token(), identifies the user.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { parseSignal, readToken, sha256Hex } from './payload.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
);

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // TradingView posts JSON alerts as text/plain unless the message parses, so read text.
  let body: unknown;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return json({ error: 'Body must be JSON' }, 400);
  }

  // Authenticate before validating the rest, so unknown callers learn nothing about the schema.
  const token = readToken(body);
  if (!token) return json({ error: 'secret_token is missing or still the placeholder' }, 401);
  const { data: owner, error: lookupError } = await supabase
    .from('signal_webhook_tokens')
    .select('user_id')
    .eq('token_hash', await sha256Hex(token))
    .maybeSingle();
  if (lookupError) return json({ error: 'Token lookup failed' }, 500);
  if (!owner) return json({ error: 'Invalid secret_token' }, 401);

  const parsed = parseSignal(body);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  const { error: insertError } = await supabase
    .from('trading_signals')
    .insert({ user_id: owner.user_id, ...parsed.signal });
  // trading_signals_event_idx: TradingView delivered this alert already.
  if (insertError?.code === '23505') return json({ ok: true, duplicate: true }, 200);
  if (insertError) return json({ error: 'Could not record signal' }, 500);

  return json({ ok: true }, 201);
});
