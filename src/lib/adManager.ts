import { useSyncExternalStore } from 'react';

/**
 * Interstitial-ad frequency cap for Basic users; Pro users never see ads.
 *
 * Heavy actions (Robo-Advisor build, backtest run) report in through
 * `recordHeavyAction`. An ad is due on every `AD_ACTION_INTERVAL`-th action,
 * and never sooner than `AD_COOLDOWN_MS` after the previous one, so the first
 * couple of actions in a session are always ad-free.
 */
export const AD_COOLDOWN_MS = 3 * 60 * 1000;
export const AD_ACTION_INTERVAL = 3;

let actionsSinceAd = 0;
let lastAdAt = Number.NEGATIVE_INFINITY;
let adOpen = false;
const listeners = new Set<() => void>();

function setAdOpen(next: boolean): void {
  if (adOpen === next) return;
  adOpen = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Counts a heavy action; opens the interstitial and returns true when one is due. */
export function recordHeavyAction(isPro: boolean, now = Date.now()): boolean {
  if (isPro) return false;
  actionsSinceAd += 1;
  if (actionsSinceAd < AD_ACTION_INTERVAL || now - lastAdAt < AD_COOLDOWN_MS) return false;
  actionsSinceAd = 0;
  lastAdAt = now;
  setAdOpen(true);
  return true;
}

export function dismissAd(): void {
  setAdOpen(false);
}

export function useAdOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => adOpen,
    () => false,
  );
}

/** Test helper: back to a fresh session. */
export function resetAdManager(): void {
  actionsSinceAd = 0;
  lastAdAt = Number.NEGATIVE_INFINITY;
  setAdOpen(false);
}
