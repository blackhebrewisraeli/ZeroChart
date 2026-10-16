import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RISK_PERCENT,
  formatShares,
  maxDrawdown,
  recommendPositionSize,
  sharpeRatio,
} from '@/lib/risk';

describe('maxDrawdown', () => {
  it('measures the percentage drop from the highest peak', () => {
    expect(maxDrawdown([100, 120, 60, 90])).toBeCloseTo(0.5, 10);
    expect(maxDrawdown([100, 80, 120, 60])).toBeCloseTo(0.5, 10);
    expect(maxDrawdown([100, 90, 95, 85])).toBeCloseTo(0.15, 10);
  });

  it('reports 0 for rising, flat, or too-short curves', () => {
    expect(maxDrawdown([100, 110, 120])).toBe(0);
    expect(maxDrawdown([100, 100, 100])).toBe(0);
    expect(maxDrawdown([100])).toBe(0);
    expect(maxDrawdown([])).toBe(0);
  });
});

describe('sharpeRatio', () => {
  it('annualizes the mean/volatility of period returns', () => {
    // Returns: +20%, −50%, +50% → mean 6.67%, σ 41.9%, ×√365 ≈ 3.04.
    const result = sharpeRatio([10000, 12000, 6000, 9000]);
    expect(result).toBeCloseTo(3.04, 2);
  });

  it('is negative for a steadily declining curve', () => {
    expect(sharpeRatio([120, 100, 80, 60])).toBeLessThan(0);
  });

  it('returns 0 for flat or too-short curves (no divide-by-zero)', () => {
    expect(sharpeRatio([100, 100, 100, 100])).toBe(0);
    expect(sharpeRatio([100, 110])).toBe(0);
    expect(sharpeRatio([])).toBe(0);
    expect(sharpeRatio([100, 120, 60, 90], 0)).toBe(0);
  });
});

describe('recommendPositionSize', () => {
  it('sizes the position so a 1×ATR stop loses exactly 2% of capital', () => {
    const size = recommendPositionSize({ capital: 10000, price: 100, atr: 8 });

    expect(DEFAULT_RISK_PERCENT).toBe(0.02);
    expect(size.riskAmount).toBeCloseTo(200, 10);
    expect(size.shares).toBe(25);
    expect(size.shares * 8).toBeCloseTo(200, 6); // shares × ATR = amount risked
    expect(size.stopPrice).toBeCloseTo(92, 10);
    expect(size.notional).toBeCloseTo(2500, 6);
  });

  it('supports fractional shares and a custom risk percent', () => {
    const fractional = recommendPositionSize({ capital: 10000, price: 100, atr: 3 });
    expect(fractional.shares).toBeCloseTo(66.6667, 4);
    expect(fractional.shares * 3).toBeCloseTo(200, 3);

    const conservative = recommendPositionSize({
      capital: 5000,
      price: 50,
      atr: 5,
      riskPercent: 0.01,
    });
    expect(conservative.riskAmount).toBeCloseTo(50, 10);
    expect(conservative.shares).toBe(10);
    expect(conservative.stopPrice).toBeCloseTo(45, 10);
  });

  it('sizes to zero when market data or capital is unusable', () => {
    expect(recommendPositionSize({ capital: 10000, price: 100, atr: 0 }).shares).toBe(0);
    expect(recommendPositionSize({ capital: 10000, price: 0, atr: 8 }).shares).toBe(0);
    expect(recommendPositionSize({ capital: -1, price: 100, atr: 8 })).toMatchObject({
      shares: 0,
      riskAmount: 0,
      notional: 0,
    });
  });
});

describe('formatShares', () => {
  it('formats share quantities at sensible precision', () => {
    expect(formatShares(25)).toBe('25');
    expect(formatShares(66.6667)).toBe('66.67');
    expect(formatShares(1234.567)).toBe('1,234.6');
    expect(formatShares(0.5)).toBe('0.5');
    expect(formatShares(0)).toBe('—');
    expect(formatShares(Number.NaN)).toBe('—');
  });
});
