import { useCallback, useEffect } from 'react';
import type { User } from '@supabase/supabase-js';
import { toast } from 'sonner';
import { formatPrice, type Asset } from '@/lib/assets';
import { toDisplayTicker } from '@/lib/ticker';
import {
  addAlert,
  beginCloudSync,
  completeCloudSync,
  failCloudSync,
  getAlertsState,
  removeAlert,
  resetToGuestSession,
  useAlerts,
  type AlertCondition,
  type AlertsSyncState,
  type PriceAlert,
} from '@/lib/alertsStore';
import { runAlertPass, withRetry, type AlertFiring } from '@/lib/alertEngine';
import { useConnectionState, useLivePrices } from '@/lib/livePriceStore';
import {
  claimAlert,
  createAlert as insertCloudAlert,
  deleteAlert as deleteCloudAlert,
  fetchActiveAlerts,
  type UserAlert,
} from '@/lib/priceAlerts';

/** Maps a Supabase row to the unified alert model (id = row id). */
export function fromCloudRow(row: UserAlert): PriceAlert {
  const createdAt = Date.parse(row.created_at);
  return {
    id: row.id,
    ticker: row.ticker,
    targetPrice: row.target_price,
    condition: row.condition,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    scope: 'cloud',
  };
}

/**
 * The single alert pipeline (M1-T4, F-5.1a–d). Mounted ONCE at the page
 * level, it:
 *  1. syncs cloud alerts for the signed-in user (guests stay session-only),
 *     keyed on the user id so token refreshes never re-sync, with a
 *     stale-response guard when the user changes mid-flight;
 *  2. runs one evaluation pass (`runAlertPass`) over BOTH scopes against the
 *     live-merged price stream, skipping non-alertable freshness states;
 *  3. notifies through one channel (sonner). A cloud alert notifies only
 *     after its server-side claim (`claimAlert`) wins, so a reload or a
 *     second tab that sees the same crossing stays silent.
 *
 * WebSocket downtime degrades gracefully: the 60s provider refetch still
 * feeds `baseAssets`, so alerts keep evaluating against Delayed data instead
 * of going dead (F-5.1b).
 */
export function useAlertEngine(baseAssets: Asset[], user: User | null): void {
  const livePrices = useLivePrices();
  const streamConnected = useConnectionState() === 'connected';
  const { alerts, sync } = useAlerts();
  const userId = user?.id ?? null;

  // Cloud sync lifecycle — depends on the id, not the (re-created) User object.
  useEffect(() => {
    if (userId === null) {
      resetToGuestSession();
      return;
    }
    beginCloudSync(userId);
    let cancelled = false;
    fetchActiveAlerts(userId)
      .then((rows) => {
        if (!cancelled) completeCloudSync(userId, rows.map(fromCloudRow));
      })
      .catch(() => {
        if (!cancelled) failCloudSync(userId);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // One evaluation pass per price/alert change.
  useEffect(() => {
    for (const firing of runAlertPass({ assets: baseAssets, livePrices, streamConnected })) {
      if (firing.alert.scope === 'session') notify(firing);
      else void claimThenNotify(firing);
    }
  }, [baseAssets, livePrices, streamConnected, alerts, sync.status]);
}

function notify({ alert, price, freshness }: AlertFiring): void {
  toast.success(`${toDisplayTicker(alert.ticker)} reached ${formatPrice(alert.targetPrice)}!`, {
    description: `${
      alert.condition === 'above' ? 'Price rose to your target' : 'Price fell to your target'
    } (${formatPrice(price)} · ${freshness}).`,
  });
}

/**
 * Notifies only when this tab's server claim wins. A claim that keeps failing
 * stays suppressed for the session (the store's fired-id set) and the row
 * stays unclaimed, so it fires after the next reload. A retry after a claim
 * that committed but lost its response reads as lost: one missed toast
 * rather than a duplicate.
 */
async function claimThenNotify(firing: AlertFiring): Promise<void> {
  let claimed = false;
  await withRetry(async () => {
    claimed = await claimAlert(firing.alert.id);
  });
  if (claimed) notify(firing);
}

export interface AlertsController {
  /** Unified alert list (session + cloud). */
  alerts: PriceAlert[];
  /** Cloud sync lifecycle state. */
  sync: AlertsSyncState;
  /** Creates a cloud alert when signed in, a session alert when guest. */
  createAlert: (input: {
    ticker: string;
    targetPrice: number;
    condition: AlertCondition;
  }) => Promise<PriceAlert>;
  /** Deletes an alert (server first for cloud alerts, then locally). */
  deleteAlert: (id: string) => Promise<void>;
}

/**
 * UI controller for the unified alert store. Persistence decisions (cloud vs
 * session) live here so every alert entry point shares one code path (F-5.1a).
 */
export function useAlertController(user: User | null): AlertsController {
  const { alerts, sync } = useAlerts();
  const userId = user?.id ?? null;

  const createAlert = useCallback(
    async (input: { ticker: string; targetPrice: number; condition: AlertCondition }) => {
      if (userId === null) return addAlert(input, 'session');
      // The persisted row id becomes the store id, so firing/deleting always
      // targets the right `user_alerts` row.
      return addAlert(fromCloudRow(await insertCloudAlert(userId, input)), 'cloud');
    },
    [userId],
  );

  const deleteAlert = useCallback(async (id: string) => {
    // Latest-state read so the lookup never uses a stale closure.
    const alert = getAlertsState().alerts.find((candidate) => candidate.id === id);
    if (!alert) return;
    // Server first: if the delete fails the alert stays visible (and the
    // caller surfaces an error) instead of silently reappearing on refetch.
    if (alert.scope === 'cloud') await deleteCloudAlert(id);
    removeAlert(id);
  }, []);

  return { alerts, sync, createAlert, deleteAlert };
}
