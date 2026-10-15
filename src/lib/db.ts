import { supabase } from '@/lib/supabaseClient';
import type { Position } from '@/lib/portfolioManager';

/**
 * Persists the user's portfolio as a single JSONB row. The table has a unique
 * constraint on `user_id`, so repeated saves upsert (update) the same row.
 */
export async function savePortfolio(userId: string, positions: Position[]): Promise<void> {
  const { error } = await supabase
    .from('user_portfolios')
    .upsert(
      { user_id: userId, positions, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' },
    );

  if (error) throw error;
}

/**
 * Fetches the user's saved portfolio, or `null` when they have not saved one
 * yet. Row Level Security restricts the query to the caller's own row.
 */
export async function loadPortfolio(userId: string): Promise<Position[] | null> {
  const { data, error } = await supabase
    .from('user_portfolios')
    .select('positions')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;

  const positions = data?.positions;
  if (!Array.isArray(positions)) return null;
  return positions as Position[];
}
