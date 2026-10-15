import { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import type { Asset } from '@/lib/assets';
import {
  createAlert as insertAlert,
  deactivateAlert,
  deleteAlert as removeAlert,
  fetchActiveAlerts,
  hasTriggered,
  type AlertCondition,
  type UserAlert,
} from '@/lib/priceAlerts';

const NOTIFICATION_TTL_MS = 6500;

export interface PriceAlertNotification {
  id: string;
  ticker: string;
  condition: AlertCondition;
  targetPrice: number;
  price: number;
}

export interface UsePriceAlertsResult {
  alerts: UserAlert[];
  loading: boolean;
  notifications: PriceAlertNotification[];
  createAlert: (input: {
    ticker: string;
    targetPrice: number;
    condition: AlertCondition;
  }) => Promise<void>;
  deleteAlert: (id: string) => Promise<void>;
  dismissNotification: (id: string) => void;
}

/**
 * Loads the user's active alerts from Supabase, then continuously evaluates the
 * existing live price stream (the `assets` already merged by `useBinanceWebSocket`)
 * against them. When a threshold is crossed it surfaces a neon notification and
 * deactivates the alert in Supabase so it only fires once.
 */
export function usePriceAlerts(assets: Asset[], user: User | null): UsePriceAlertsResult {
  const [alerts, setAlerts] = useState<UserAlert[]>([]);
  const [loading, setLoading] = useState(false);
  const [notifications, setNotifications] = useState<PriceAlertNotification[]>([]);

  const alertsRef = useRef<UserAlert[]>([]);
  const timersRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    alertsRef.current = alerts;
  }, [alerts]);

  const dismissNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((notification) => notification.id !== id));
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  // Fetch active alerts whenever the authenticated user changes.
  useEffect(() => {
    if (!user) {
      setAlerts([]);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    fetchActiveAlerts(user.id)
      .then((rows) => {
        if (active) setAlerts(rows);
      })
      .catch(() => {
        if (active) setAlerts([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [user]);

  const triggerAlert = useCallback(
    (alert: UserAlert, price: number) => {
      // Optimistically drop the alert from the local list so it never re-fires.
      setAlerts((prev) => prev.filter((item) => item.id !== alert.id));
      setNotifications((prev) => [
        ...prev,
        {
          id: alert.id,
          ticker: alert.ticker,
          condition: alert.condition,
          targetPrice: alert.target_price,
          price,
        },
      ]);
      const timer = window.setTimeout(() => dismissNotification(alert.id), NOTIFICATION_TTL_MS);
      timersRef.current.set(alert.id, timer);

      deactivateAlert(alert.id).catch(() => {
        // Non-fatal: the alert is already gone from the local list.
      });
    },
    [dismissNotification],
  );

  // Evaluate every live-price update against the active alerts.
  useEffect(() => {
    if (!user || alertsRef.current.length === 0) return;

    const priceByTicker = new Map<string, number>();
    for (const asset of assets) {
      if (
        asset.current_price !== null &&
        Number.isFinite(asset.current_price) &&
        asset.current_price > 0
      ) {
        priceByTicker.set(asset.ticker, asset.current_price);
      }
    }

    for (const alert of alertsRef.current) {
      const price = priceByTicker.get(alert.ticker);
      if (price === undefined) continue;
      if (hasTriggered(alert.condition, alert.target_price, price)) {
        triggerAlert(alert, price);
      }
    }
  }, [assets, user, triggerAlert]);

  // Clear any pending notification timers on unmount.
  useEffect(
    () => () => {
      for (const timer of timersRef.current.values()) window.clearTimeout(timer);
      timersRef.current.clear();
    },
    [],
  );

  const createAlert = useCallback(
    async (input: { ticker: string; targetPrice: number; condition: AlertCondition }) => {
      if (!user) return;
      const created = await insertAlert(user.id, input);
      setAlerts((prev) => [created, ...prev]);
    },
    [user],
  );

  const deleteAlert = useCallback(async (id: string) => {
    setAlerts((prev) => prev.filter((item) => item.id !== id));
    await removeAlert(id);
  }, []);

  return { alerts, loading, notifications, createAlert, deleteAlert, dismissNotification };
}
