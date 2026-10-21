// Single canonical browser-side Supabase client (M1-T1, F-4.2a).
//
// Every browser consumer — auth (`authStore`, `AuthModal`), persistence
// (`db`, `priceAlerts`), public market data (`assets`), and the serverFn auth
// middleware (`integrations/supabase/client`) — imports THIS instance so
// exactly one GoTrueClient exists per browser context. Do not add another
// `createClient` call for browser code; re-export from this module instead.
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { createSupabaseFetch, resolveSupabaseKey, resolveSupabaseUrl } from '@/lib/supabaseConfig';

const SUPABASE_URL = resolveSupabaseUrl();
const SUPABASE_KEY = resolveSupabaseKey();

// "Keep me signed in" (AuthModal). The choice itself lives in localStorage so it
// outlasts the tab; the session goes to localStorage when remembered (Supabase's
// default) or to sessionStorage, which the browser drops when the tab closes.
const REMEMBER_ME_KEY = 'zerochart:remember-me';

/** Call before any sign-in so the session it creates lands in the right store. */
export function setRememberMe(remember: boolean): void {
  localStorage.setItem(REMEMBER_ME_KEY, String(remember));
}

function sessionStore(): Storage {
  return localStorage.getItem(REMEMBER_ME_KEY) === 'false' ? sessionStorage : localStorage;
}

export const authStorage = {
  getItem: (key: string) => sessionStore().getItem(key),
  setItem: (key: string, value: string) => {
    const store = sessionStore();
    store.setItem(key, value);
    // Never leave a stale copy in the other store, or it would outlive the choice.
    (store === localStorage ? sessionStorage : localStorage).removeItem(key);
  },
  removeItem: (key: string) => {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  },
};

// Typed with the generated `Database` schema so `.from(...)` calls in `db.ts`
// and `priceAlerts.ts` are strictly typed instead of relying on manual casts.
export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_KEY, {
  global: {
    fetch: createSupabaseFetch(SUPABASE_KEY),
  },
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // SSR has no Web Storage; leave Supabase on its in-memory default there.
    storage: typeof window === 'undefined' ? undefined : authStorage,
  },
});
