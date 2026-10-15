import { supabase } from '@/lib/supabaseClient';

export type AlertCondition = 'above' | 'below';

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
function mapAlert(row: Record<string, unknown>): UserAlert {
  return {
    id: String(row['id']),
    user_id: String(row['user_id'] ?? ''),
    ticker: String(row['ticker']),
    target_price: Number(row['target_price']),
    condition: row['condition'] === 'below' ? 'below' : 'above',
    is_active: row['is_active'] !== false,
    created_at: String(row['created_at'] ?? ''),
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
  return ((data ?? []) as Array<Record<string, unknown>>).map(mapAlert);
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
  return mapAlert(data as Record<string, unknown>);
}

/** Marks an alert as inactive so it stops firing. */
export async function deactivateAlert(id: string): Promise<void> {
  const { error } = await supabase.from('user_alerts').update({ is_active: false }).eq('id', id);
  if (error) throw error;
}

/** Permanently removes an alert. */
export async function deleteAlert(id: string): Promise<void> {
  const { error } = await supabase.from('user_alerts').delete().eq('id', id);
  if (error) throw error;
}
