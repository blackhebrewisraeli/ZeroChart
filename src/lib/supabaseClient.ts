// Single canonical browser-side Supabase client (M1-T1, F-4.2a).
//
// Every browser consumer — auth (`authStore`, `AuthModal`), persistence
// (`db`, `priceAlerts`), public market data (`assets`), and the serverFn auth
// middleware (`integrations/supabase/client`) — imports THIS instance so
// exactly one GoTrueClient exists per browser context. Do not add another
// `createClient` call for browser code; re-export from this module instead.
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { brokeredPreviewStorage } from '@/integrations/supabase/previewAuthStorage';
import { createSupabaseFetch, resolveSupabaseKey, resolveSupabaseUrl } from '@/lib/supabaseConfig';

const SUPABASE_URL = resolveSupabaseUrl();
const SUPABASE_KEY = resolveSupabaseKey();

// Typed with the generated `Database` schema so `.from(...)` calls in `db.ts`
// and `priceAlerts.ts` are strictly typed instead of relying on manual casts.
export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_KEY, {
  global: {
    fetch: createSupabaseFetch(SUPABASE_KEY),
  },
  auth: {
    storage: brokeredPreviewStorage(),
    persistSession: true,
    autoRefreshToken: true,
  },
});
