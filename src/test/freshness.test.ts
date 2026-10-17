import { describe, expect, it } from 'vitest';
import {
  assetFreshness,
  classifyFreshness,
  FRESHNESS_MAX_AGE_MS,
  isAlertableFreshness,
  SIMULATED_MARKER,
} from '@/lib/freshness';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe('classifyFreshness (M1-T4, F-3.2b)', () => {
  it('reports Live only for a real tick on a connected stream', () => {
    expect(classifyFreshness({ updatedAt: iso(0), price: 10, hasLivePrice: true, now: NOW })).toBe(
      'Live',
    );
    expect(
      classifyFreshness({
        updatedAt: iso(0),
        price: 10,
        hasLivePrice: true,
        streamConnected: false,
        now: NOW,
      }),
    ).toBe('Delayed');
  });

  it('applies the snapshot-age boundary inclusively', () => {
    const base = { price: 10, hasLivePrice: false, now: NOW };
    expect(classifyFreshness({ ...base, updatedAt: iso(FRESHNESS_MAX_AGE_MS) })).toBe('Delayed');
    expect(classifyFreshness({ ...base, updatedAt: iso(FRESHNESS_MAX_AGE_MS + 1) })).toBe('Stale');
  });

  it('treats undatable snapshots as Stale', () => {
    const base = { price: 10, hasLivePrice: false, now: NOW };
    expect(classifyFreshness({ ...base, updatedAt: null })).toBe('Stale');
    expect(classifyFreshness({ ...base, updatedAt: undefined })).toBe('Stale');
    expect(classifyFreshness({ ...base, updatedAt: 'not-a-date' })).toBe('Stale');
  });

  it('reports Unavailable for missing, zero, negative, or non-finite prices', () => {
    for (const price of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(classifyFreshness({ updatedAt: iso(0), price, hasLivePrice: false, now: NOW })).toBe(
        'Unavailable',
      );
    }
  });

  it('labels sample rows Simulated unless a genuine tick is overlaid', () => {
    const sample = { current_price: 100, updated_at: SIMULATED_MARKER };
    expect(assetFreshness(sample, undefined, { now: NOW })).toBe('Simulated');
    expect(assetFreshness(sample, { price: 101 }, { now: NOW })).toBe('Live');
  });

  it('classifies the displayed (live) price rather than the stale DB price', () => {
    const row = { current_price: null, updated_at: iso(0) };
    expect(assetFreshness(row, undefined, { now: NOW })).toBe('Unavailable');
    expect(assetFreshness(row, { price: 5 }, { now: NOW })).toBe('Live');
  });

  it('only lets Live/Delayed prices drive alerts', () => {
    expect(isAlertableFreshness('Live')).toBe(true);
    expect(isAlertableFreshness('Delayed')).toBe(true);
    expect(isAlertableFreshness('Stale')).toBe(false);
    expect(isAlertableFreshness('Unavailable')).toBe(false);
    expect(isAlertableFreshness('Simulated')).toBe(false);
  });
});
