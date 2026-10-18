import { beforeEach, describe, expect, it } from 'vitest';
import {
  AD_ACTION_INTERVAL,
  AD_COOLDOWN_MS,
  dismissAd,
  recordHeavyAction,
  resetAdManager,
} from '@/lib/adManager';

function actions(count: number, isPro: boolean, now: number): boolean[] {
  return Array.from({ length: count }, () => recordHeavyAction(isPro, now));
}

beforeEach(resetAdManager);

describe('adManager frequency cap', () => {
  it('never shows an ad to a Pro user, and Pro actions do not count', () => {
    expect(actions(10, true, 0)).not.toContain(true);
    // A Basic session after those Pro actions still starts from zero.
    expect(actions(AD_ACTION_INTERVAL - 1, false, 0)).not.toContain(true);
  });

  it('shows a Free user an ad on every third heavy action', () => {
    expect(actions(AD_ACTION_INTERVAL, false, 0)).toEqual([false, false, true]);
  });

  it('holds the next ad until the cooldown has passed, even after three actions', () => {
    actions(AD_ACTION_INTERVAL, false, 0);
    dismissAd();

    expect(actions(5, false, AD_COOLDOWN_MS - 1)).not.toContain(true);
    expect(recordHeavyAction(false, AD_COOLDOWN_MS)).toBe(true);
  });

  it('needs three actions after the cooldown too', () => {
    actions(AD_ACTION_INTERVAL, false, 0);
    dismissAd();

    const later = AD_COOLDOWN_MS * 10;
    expect(actions(AD_ACTION_INTERVAL, false, later)).toEqual([false, false, true]);
  });
});
