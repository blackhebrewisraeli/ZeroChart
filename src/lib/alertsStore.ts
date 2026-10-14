import { useSyncExternalStore } from 'react';

export type AlertDirection = 'above' | 'below';

export interface PriceAlert {
  id: string;
  ticker: string;
  targetPrice: number;
  direction: AlertDirection;
  createdAt: number;
}

let alerts: PriceAlert[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAlerts(): PriceAlert[] {
  return alerts;
}

export function addAlert(input: {
  ticker: string;
  targetPrice: number;
  direction: AlertDirection;
}): PriceAlert {
  const alert: PriceAlert = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    ...input,
  };
  alerts = [...alerts, alert];
  emit();
  return alert;
}

export function removeAlert(id: string): void {
  alerts = alerts.filter((alert) => alert.id !== id);
  emit();
}

/** Whether a price tick has crossed an alert's threshold. */
export function hasCrossed(alert: PriceAlert, price: number): boolean {
  return alert.direction === 'above' ? price >= alert.targetPrice : price <= alert.targetPrice;
}

/** React hook that re-renders subscribers whenever the alert list changes. */
export function useAlerts(): PriceAlert[] {
  return useSyncExternalStore(subscribe, getAlerts, getAlerts);
}
