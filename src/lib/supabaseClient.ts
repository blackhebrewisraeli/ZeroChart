import { createClient } from '@supabase/supabase-js';
import { brokeredPreviewStorage } from '@/integrations/supabase/previewAuthStorage';

// A Supabase project may expose either a legacy "anon" JWT key or one of the
// newer opaque publishable keys (prefixed `sb_publishable_`). This project uses
// publishable keys, so we accept both env vars and prefer the anon key when it
// is present for backward compatibility.
function isNewSupabaseApiKey(value: string): boolean {
  return value.startsWith('sb_publishable_') || value.startsWith('sb_secret_');
}

function createSupabaseFetch(supabaseKey: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(
      typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined,
    );

    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }

    // New Supabase API keys are opaque strings, not bearer JWTs.
    if (
      isNewSupabaseApiKey(supabaseKey) &&
      headers.get('Authorization') === `Bearer ${supabaseKey}`
    ) {
      headers.delete('Authorization');
    }

    headers.set('apikey', supabaseKey);
    return fetch(input, { ...init, headers });
  };
}

// Client-side env vars (Vite statically replaces `import.meta.env.VITE_*`);
// `process.env` covers server-side rendering in the Nitro runtime.
const SUPABASE_URL = import.meta.env['VITE_SUPABASE_URL'] || process.env['SUPABASE_URL'];
const SUPABASE_KEY =
  import.meta.env['VITE_SUPABASE_ANON_KEY'] ||
  import.meta.env['VITE_SUPABASE_PUBLISHABLE_KEY'] ||
  process.env['SUPABASE_ANON_KEY'] ||
  process.env['SUPABASE_PUBLISHABLE_KEY'];

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error(
    'Missing Supabase environment variables. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (or VITE_SUPABASE_PUBLISHABLE_KEY).',
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  global: {
    fetch: createSupabaseFetch(SUPABASE_KEY),
  },
  auth: {
    storage: brokeredPreviewStorage(),
    persistSession: true,
    autoRefreshToken: true,
  },
});
