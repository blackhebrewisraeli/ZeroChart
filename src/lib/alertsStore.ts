import { useSyncExternalStore } from 'react';

/**
 * Unified price-alert store (M1-T4, F-5.1a–d).
 *
 * One alert model for the entire app: guest alerts live in memory for the
 * session (`scope: 'session'`), signed-in users' alerts are mirrored from the
 * Supabase `user_alerts` table (`scope: 'cloud'`, id = the row id). Evaluation
 * happens in ONE place — `runAlertPass` driven by `useAlertEngine` — so a
 * threshold can never fire twice or through divergent pipelines. Firing claims
 * the alert atomically in this tab via `takeAlert`; a cloud alert then needs
 * its server-side claim (`claimAlert`) before it notifies, which holds across
 * tabs and reloads. Fired cloud ids stay suppressed for the user's session, so
 * a refetch during or after a failed claim never re-adds them.
 */

export type AlertCondition = 'above' | 'below';

/** 'session' = guest in-memory only; 'cloud' = synced to `user_alerts`. */
export type AlertScope = 'session' | 'cloud';

export interface PriceAlert {
  id: string;
  ticker: string;
  targetPrice: number;
  condition: AlertCondition;
  createdAt: number;
  scope: AlertScope;
}

/** A fired alert, kept for the session so the Lab signal feed can show it. */
export interface TriggeredAlert {
  alert: PriceAlert;
  price: number;
  triggeredAt: number;
}

export interface NewPriceAlert {
  ticker: string;
  targetPrice: number;
  condition: AlertCondition;
  /** Explicit id — REQUIRED for cloud alerts (the `user_alerts.id`). */
  id?: string;
  createdAt?: number;
}

export interface AlertsSyncState {
  /** User whose cloud alerts are loaded; null = guest session mode. */
  syncedUserId: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
}

export interface AlertsState {
  alerts: PriceAlert[];
  sync: AlertsSyncState;
  /** Cloud alert ids already fired this session — suppresses refires. */
  firedCloudIds: ReadonlySet<string>;
  /** Alerts fired this session, oldest first. */
  triggered: TriggeredAlert[];
}

function guestState(): AlertsState {
  return {
    alerts: [],
    sync: { syncedUserId: null, status: 'ready' },
    firedCloudIds: new Set<string>(),
    triggered: [],
  };
}

const SERVER_SNAPSHOT: AlertsState = guestState();

let state: AlertsState = guestState();
/** Cloud alerts created while a sync was in flight (merged on completion). */
let addedDuringSync = new Set<string>();
const listeners = new Set<() => void>();

function setState(next: AlertsState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAlertsState(): AlertsState {
  return state;
}

/** React subscription over the unified alert state. */
export function useAlerts(): AlertsState {
  return useSyncExternalStore(subscribe, getAlertsState, () => SERVER_SNAPSHOT);
}

/**
 * Enters guest session mode. A no-op when already in guest mode (so a
 * remount never wipes the guest's session alerts); leaving a signed-in
 * session clears every cloud alert and suppression mark (account isolation).
 */
export function resetToGuestSession(): void {
  if (state.sync.syncedUserId === null) return;
  addedDuringSync = new Set();
  setState(guestState());
}

/**
 * Starts loading `userId`'s cloud alerts. Switching users clears the previous
 * account's data; re-syncing the SAME user keeps the current list and the
 * fired-id suppression set so a refetch can never resurrect a fired alert.
 */
export function beginCloudSync(userId: string): void {
  const sameUser = state.sync.syncedUserId === userId;
  addedDuringSync = new Set();
  setState({
    alerts: sameUser ? state.alerts : [],
    sync: { syncedUserId: userId, status: 'loading' },
    firedCloudIds: sameUser ? state.firedCloudIds : new Set<string>(),
    triggered: sameUser ? state.triggered : [],
  });
}

/**
 * Completes a cloud sync. Stale responses (user changed mid-flight) are
 * dropped; alerts fired this session stay suppressed even if the server
 * deactivation failed and the row comes back active (F-5.1c); alerts created
 * while the fetch was in flight are preserved.
 */
export function completeCloudSync(userId: string, alerts: PriceAlert[]): void {
  if (state.sync.syncedUserId !== userId) return;
  const fired = state.firedCloudIds;
  const fetched = alerts.filter((alert) => !fired.has(alert.id));
  const fetchedIds = new Set(fetched.map((alert) => alert.id));
  const createdMeanwhile = state.alerts.filter(
    (alert) => addedDuringSync.has(alert.id) && !fetchedIds.has(alert.id),
  );
  addedDuringSync = new Set();
  setState({
    alerts: [...fetched, ...createdMeanwhile],
    sync: { syncedUserId: userId, status: 'ready' },
    firedCloudIds: fired,
    triggered: state.triggered,
  });
}

/** Marks a cloud sync as failed (alerts stay as-is; UI can retry on remount). */
export function failCloudSync(userId: string): void {
  if (state.sync.syncedUserId !== userId) return;
  setState({ ...state, sync: { syncedUserId: userId, status: 'error' } });
}

function nextAlertId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Adds an alert to the unified list. Cloud alerts MUST carry the persisted
 * row id so deactivation/deletion target the right row; session alerts get a
 * local id. Adding an id that already exists is a no-op (idempotent).
 */
export function addAlert(input: NewPriceAlert, scope: AlertScope): PriceAlert {
  if (scope === 'cloud' && !input.id) {
    throw new Error('Cloud alerts require the persisted user_alerts id');
  }
  const existing = input.id
    ? state.alerts.find((candidate) => candidate.id === input.id)
    : undefined;
  if (existing) return existing;

  const alert: PriceAlert = {
    id: input.id ?? nextAlertId(),
    ticker: input.ticker,
    targetPrice: input.targetPrice,
    condition: input.condition,
    createdAt: input.createdAt ?? Date.now(),
    scope,
  };
  if (state.sync.status === 'loading') addedDuringSync.add(alert.id);
  setState({ ...state, alerts: [...state.alerts, alert] });
  return alert;
}

/**
 * Atomically claims an alert for firing: removes it from the list and returns
 * it, or null if it was already claimed/removed — the anti-double-fire
 * primitive (F-5.1a). Cloud claims are recorded in the suppression set in the
 * same state transition, so no refetch can ever re-add them (F-5.1c).
 */
export function takeAlert(id: string): PriceAlert | null {
  const alert = state.alerts.find((candidate) => candidate.id === id);
  if (!alert) return null;
  let firedCloudIds = state.firedCloudIds;
  if (alert.scope === 'cloud') {
    const next = new Set(firedCloudIds);
    next.add(id);
    firedCloudIds = next;
  }
  setState({
    ...state,
    alerts: state.alerts.filter((candidate) => candidate.id !== id),
    firedCloudIds,
  });
  return alert;
}

/** Records alerts a pass just fired (see `runAlertPass`). */
export function recordTriggered(fired: TriggeredAlert[]): void {
  if (fired.length === 0) return;
  setState({ ...state, triggered: [...state.triggered, ...fired] });
}

/** Removes an alert without claiming it (user deletes). */
export function removeAlert(id: string): void {
  if (!state.alerts.some((candidate) => candidate.id === id)) return;
  setState({ ...state, alerts: state.alerts.filter((candidate) => candidate.id !== id) });
}

/** Test-only: restore the pristine guest state. */
export function __resetAlertsStoreForTests(): void {
  addedDuringSync = new Set();
  setState(guestState());
}
