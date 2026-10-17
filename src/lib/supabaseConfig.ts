/**
 * Centralized Supabase endpoint + key resolution for every browser-side client
 * (M1-T1, findings F-4.2a / F-4.2b).
 *
 * Historically three modules each resolved env vars and created their own
 * client, producing duplicate GoTrueClient instances ("Multiple GoTrueClient
 * instances detected … under the same storage key") and forking configuration
 * across environments. All browser-side entry points resolve configuration
 * here and share the single canonical client in `@/lib/supabaseClient`.
 *
 * NOTE: server-only code (`client.server.ts`, service-role) intentionally does
 * NOT import this module so browser env resolution never leaks server-side.
 */

/** Whether a value is one of the newer opaque Supabase API keys (not a legacy anon JWT). */
export function isNewSupabaseApiKey(value: string): boolean {
  return value.startsWith('sb_publishable_') || value.startsWith('sb_secret_');
}

/**
 * Wraps `fetch` so opaque (`sb_publishable_` / `sb_secret_`) keys are only sent
 * in the `apikey` header — never as a redundant `Authorization: Bearer` header,
 * which newer Supabase gateways reject.
 */
export function createSupabaseFetch(supabaseKey: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(
      typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined,
    );

    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }

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

function missingEnvMessage(vars: string[]): string {
  return `Missing Supabase environment variable(s): ${vars.join(' or ')}. Connect Supabase in Lovable Cloud.`;
}

/**
 * Resolves the Supabase project URL. `import.meta.env.VITE_*` is inlined by
 * Vite at build time for the browser; the `process.env` fallbacks cover the
 * Nitro SSR runtime.
 */
export function resolveSupabaseUrl(): string {
  const url = import.meta.env['VITE_SUPABASE_URL'] || process.env['SUPABASE_URL'];
  if (!url) throw new Error(missingEnvMessage(['VITE_SUPABASE_URL']));
  return url;
}

/**
 * Resolves the browser publishable key. The legacy `*_ANON_KEY` names are
 * accepted first for backward compatibility (CI injects
 * `VITE_SUPABASE_ANON_KEY`), then the newer `*_PUBLISHABLE_KEY` names.
 */
export function resolveSupabaseKey(): string {
  const key =
    import.meta.env['VITE_SUPABASE_ANON_KEY'] ||
    import.meta.env['VITE_SUPABASE_PUBLISHABLE_KEY'] ||
    process.env['SUPABASE_ANON_KEY'] ||
    process.env['SUPABASE_PUBLISHABLE_KEY'];
  if (!key) {
    throw new Error(missingEnvMessage(['VITE_SUPABASE_ANON_KEY', 'VITE_SUPABASE_PUBLISHABLE_KEY']));
  }
  return key;
}
