// M1-T1 (F-4.2a / F-4.2b): this module previously created a SECOND Supabase
// client from a hardcoded URL + publishable key (no env resolution), causing
// duplicate GoTrueClient instances in the browser. It now re-exports the single
// canonical client so `assets.ts` and its test doubles keep working unchanged.
export { supabase } from '@/lib/supabaseClient';
