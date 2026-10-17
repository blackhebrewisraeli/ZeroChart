import { useSyncExternalStore } from 'react';

/**
 * Cloud-portfolio hydration state machine (M1-T1, finding F-4.1b).
 *
 * A signed-in user's cloud row must finish loading before anything may write
 * it back ("Save to Cloud"), otherwise a slow `loadPortfolio` can race a save
 * and overwrite the user's cloud row with another account's leftover local
 * positions. This module is the single source of truth for that barrier:
 *
 * - `authStore` drives the transitions (`beginHydration` → `completeHydration`,
 *   `resetHydration` on sign-out).
 * - `db.savePortfolio` consults `isCloudWriteAllowed` as a defense-in-depth
 *   guard so no code path can bypass the barrier.
 * - UI (the dashboard's Save button) subscribes via `useHydrationState`.
 *
 * The default `idle` state means "no auth flow has engaged the barrier yet"
 * (guest sessions, legacy call sites, unit tests) and allows writes; once a
 * hydration begins for a user, writes for that user are blocked until the
 * attempt settles (`ready` or `error`).
 */

export type HydrationStatus = 'idle' | 'hydrating' | 'ready' | 'error';

export interface HydrationState {
  status: HydrationStatus;
  /** The user the current hydration attempt belongs to; null when idle/guest. */
  userId: string | null;
}

const INITIAL_STATE: HydrationState = { status: 'idle', userId: null };

let state: HydrationState = INITIAL_STATE;
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

export function getHydrationState(): HydrationState {
  return state;
}

/** Marks that `userId`'s cloud portfolio load has started. */
export function beginHydration(userId: string): void {
  state = { status: 'hydrating', userId };
  emit();
}

/**
 * Marks `userId`'s load attempt as settled. Stale completions (belonging to a
 * user that is no longer active) are ignored so an in-flight response can
 * never flip the barrier for the wrong account.
 */
export function completeHydration(userId: string, outcome: 'ready' | 'error'): void {
  if (state.userId !== userId) return;
  state = { status: outcome, userId };
  emit();
}

/** Returns the barrier to its initial state (sign-out / guest scope). */
export function resetHydration(): void {
  state = INITIAL_STATE;
  emit();
}

/**
 * Whether a cloud write for `userId` may proceed. Blocked while that user's
 * hydration is in flight, and blocked for any other user while a hydration is
 * active. `idle` (no auth flow engaged) is permissive for guest/legacy paths.
 */
export function isCloudWriteAllowed(userId: string): boolean {
  if (state.status === 'idle' && state.userId === null) return true;
  return state.userId === userId && state.status !== 'hydrating';
}

/** React subscription for UI consumers (Save button gating, status copy). */
export function useHydrationState(): HydrationState {
  return useSyncExternalStore(subscribe, getHydrationState, () => INITIAL_STATE);
}
