import { describe, expect, it } from 'vitest';
import { hasTriggered } from '@/lib/priceAlerts';

describe('hasTriggered', () => {
  it('triggers above alerts when the price meets or exceeds the target', () => {
    expect(hasTriggered('above', 100, 100)).toBe(true);
    expect(hasTriggered('above', 100, 101)).toBe(true);
    expect(hasTriggered('above', 100, 99.99)).toBe(false);
  });

  it('triggers below alerts when the price meets or falls under the target', () => {
    expect(hasTriggered('below', 100, 100)).toBe(true);
    expect(hasTriggered('below', 100, 99)).toBe(true);
    expect(hasTriggered('below', 100, 100.01)).toBe(false);
  });

  it('never triggers on non-finite values', () => {
    expect(hasTriggered('above', Number.NaN, 100)).toBe(false);
    expect(hasTriggered('above', 100, Number.NaN)).toBe(false);
  });
});
