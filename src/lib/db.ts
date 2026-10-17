import type { Position } from '@/lib/portfolioManager';
import type { PortfolioPersistedState, PortfolioStateV3 } from '@/lib/portfolioStore';
import { isCloudWriteAllowed } from '@/lib/hydrationStore';
import { supabase } from '@/lib/supabaseClient';
import type { Json } from '@/integrations/supabase/types';

/**
 * Thrown when a cloud write is attempted before the signed-in user's cloud
 * portfolio finished hydrating (M1-T1, F-4.1b). Callers surface this as a
 * transient "still syncing" state rather than a generic failure.
 */
export class PortfolioNotHydratedError extends Error {
  constructor(userId: string) {
    super(
      `Cloud portfolio for user ${userId} has not finished hydrating; refusing write to prevent cross-account overwrite.`,
    );
    this.name = 'PortfolioNotHydratedError';
  }
}

/**
 * Persists the user's portfolio as a single JSONB row. The table has a unique
 * constraint on `user_id`, so repeated saves upsert (update) the same row.
 *
 * Guarded by the hydration barrier (M1-T1, F-4.1b): the write is rejected
 * while this user's `loadPortfolio` is still in flight, so a slow hydration
 * can never be clobbered by (or clobber) another session's state.
 */
type PortfolioCloudPayload = PortfolioPersistedState;

async function savePortfolioPayload(userId: string, payload: PortfolioCloudPayload): Promise<void> {
  if (!isCloudWriteAllowed(userId)) throw new PortfolioNotHydratedError(userId);

  const { error } = await supabase.from('user_portfolios').upsert(
    {
      user_id: userId,
      // `Position` is an interface, so it has no implicit index signature to
      // satisfy the recursive `Json` type — one documented cast at the
      // persistence boundary (values are plain string/number/booleans).
      positions: payload as unknown as Json,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );

  if (error) throw error;
}

export async function savePortfolio(userId: string, positions: Position[]): Promise<void> {
  await savePortfolioPayload(userId, positions);
}

/** Persists the complete v3 envelope while the legacy array API stays intact. */
export async function savePortfolioStateV3(userId: string, state: PortfolioStateV3): Promise<void> {
  await savePortfolioPayload(userId, state);
}

async function loadPortfolioPayload(userId: string): Promise<unknown | null> {
  const { data, error } = await supabase
    .from('user_portfolios')
    .select('positions')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return data?.positions ?? null;
}

/**
 * Fetches the user's saved portfolio, or `null` when they have not saved one
 * yet (an explicit empty `[]` row comes back as `[]`, distinct from `null`).
 * Row Level Security restricts the query to the caller's own row.
 */
export async function loadPortfolio(userId: string): Promise<PortfolioCloudPayload | null> {
  const payload = await loadPortfolioPayload(userId);
  if (Array.isArray(payload)) return payload as unknown as Position[];
  if (payload === null || typeof payload !== 'object') return null;
  if ('version' in payload && payload.version === 3 && 'portfolios' in payload) {
    return payload as unknown as PortfolioStateV3;
  }
  if ('positions' in payload && Array.isArray(payload.positions)) {
    return payload as unknown as PortfolioCloudPayload;
  }
  return null;
}

/**
 * Loads either the legacy position array or the v3 multi-portfolio envelope.
 * Shape normalization and v1/v2 migration remain owned by `portfolioStore`.
 */
export async function loadPortfolioState(userId: string): Promise<PortfolioCloudPayload | null> {
  return loadPortfolio(userId);
}
