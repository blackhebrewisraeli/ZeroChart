import { supabase } from '@/lib/supabaseClient';
import type { Database } from '@/integrations/supabase/types';
import type { AlertCondition } from '@/lib/alertsStore';

// The alert CONDITION type is canonical in `@/lib/alertsStore` (unified model,
// M1-T4); re-exported here for backward compatibility with existing imports.
export type { AlertCondition };

/** Strict row shape from the generated schema (M1-T1, F-3.1b). */
type UserAlertRow = Database['public']['Tables']['user_alerts']['Row'];

export interface UserAlert {
  id: string;
  user_id: string;
  ticker: string;
  target_price: number;
  condition: AlertCondition;
  is_active: boolean;
  created_at: string;
}

export interface NewAlertInput {
  ticker: string;
  targetPrice: number;
  condition: AlertCondition;
}

/**
 * Pure predicate for whether a live price has crossed an alert's threshold.
 * Kept free of Supabase/React so it can be unit-tested in isolation.
 */
export function hasTriggered(
  condition: AlertCondition,
  targetPrice: number,
  price: number,
): boolean {
  if (!Number.isFinite(targetPrice) || !Number.isFinite(price)) return false;
  return condition === 'above' ? price >= targetPrice : price <= targetPrice;
}

/** Coerces a raw PostgREST row into the app's `UserAlert` shape. */
function mapAlert(row: UserAlertRow): UserAlert {
  return {
    id: row.id,
    user_id: row.user_id,
    ticker: row.ticker,
    target_price: row.target_price,
    condition: row.condition === 'below' ? 'below' : 'above',
    is_active: row.is_active !== false,
    created_at: row.created_at,
  };
}

/** Fetches the user's currently active alerts, newest first. */
export async function fetchActiveAlerts(userId: string): Promise<UserAlert[]> {
  const { data, error } = await supabase
    .from('user_alerts')
    .select('*')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data ?? []).map(mapAlert);
}

/** Inserts a new active alert and returns the persisted row. */
export async function createAlert(userId: string, input: NewAlertInput): Promise<UserAlert> {
  const { data, error } = await supabase
    .from('user_alerts')
    .insert({
      user_id: userId,
      ticker: input.ticker,
      target_price: input.targetPrice,
      condition: input.condition,
      is_active: true,
    })
    .select('*')
    .single();

  if (error) throw error;
  if (!data) throw new Error('Created alert row missing from response');
  return mapAlert(data);
}

/**
 * Claims a fired alert server-side: stamps fired_at and deactivates the row,
 * but only while it is unclaimed. True for exactly one caller across tabs and
 * reloads, false once anyone has claimed it. Throws on a DB error.
 */
export async function claimAlert(id: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('user_alerts')
    .update({ fired_at: new Date().toISOString(), is_active: false })
    .eq('id', id)
    .is('fired_at', null)
    .eq('is_active', true)
    .select('id');
  if (error) throw error;
  return data.length > 0;
}

/** Permanently removes an alert. */
export async function deleteAlert(id: string): Promise<void> {
  const { error } = await supabase.from('user_alerts').delete().eq('id', id);
  if (error) throw error;
}
