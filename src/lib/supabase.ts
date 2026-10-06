import { createClient } from '@supabase/supabase-js';

// Publishable (anon) credentials are safe to ship in browser code; row access is enforced by RLS.
const SUPABASE_URL = 'https://tldvgvlswananoxafocw.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_LTJ-AVLmxCdjWtWE_y58Zg_W7N4vVzZ';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
