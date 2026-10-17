// M1-T1 (F-4.2a): consolidated onto the single canonical browser client.
// This file historically created its own lazily-initialized client (a SECOND
// GoTrueClient in the browser via `auth-attacher`). Keep this re-export so
// generated imports (`import { supabase } from './client'`) resolve to the
// canonical instance instead of resurrecting a duplicate client. Server-only
// code must keep using `./client.server` (service-role, isolated).
export { supabase } from '@/lib/supabaseClient';
