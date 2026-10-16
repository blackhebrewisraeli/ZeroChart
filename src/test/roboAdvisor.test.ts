import { describe, expect, it, vi } from 'vitest';
import {
  buildQuantPortfolio,
  calculateAssetScore,
  computeVolatility,
  type QuantDeps,
} from '@/lib/roboAdvisor';
import type { Asset } from '@/lib/assets';

function makeAsset(ticker: string, currentPrice: number | null = 100): Asset {
  return {
    ticker,
    name: null,
    current_price: currentPrice,
    sma_50: null,
    sma_200: null,
    stable_signal: null,
    radar_signal: null,
    stable_explanation: null,
    radar_explanation: null,
    risk_pct: null,
    reward_pct: null,
    volume_spike: null,
    rsi_14: null,
    change_24h: null,
    updated_at: null,
  };
}

function makeDeps(): QuantDeps {
  return {
    fetchCloses: vi.fn(async () => Float64Array.from([90, 100, 100])),
    computeIndicators: vi.fn(async () => ({
      sma50: Float64Array.from([100]),
      sma200: Float64Array.from([50]),
      rsi14: Float64Array.from([50]),
    })),
  };
}

describe('calculateAssetScore', () => {
  it('rewards aligned uptrends with healthy RSI', () => {
    const score = calculateAssetScore({
      price: 110,
      sma50: 100,
      sma200: 90,
      rsi14: 50,
      volatility: 0.02,
    });
    expect(score).toBe(80);
  });

  it('penalizes overbought and downtrend conditions', () => {
    const score = calculateAssetScore({
      price: 90,
      sma50: 100,
      sma200: 110,
      rsi14: 75,
      volatility: 0.05,
    });
    expect(score).toBe(0);
  });

  it('clamps scores into the 0-100 range', () => {
    const high = calculateAssetScore({
      price: 120,
      sma50: 100,
      sma200: 90,
      rsi14: 50,
      volatility: 0.001,
    });
    expect(high).toBeLessThanOrEqual(100);

    const low = calculateAssetScore({
      price: 50,
      sma50: 100,
      sma200: 110,
      rsi14: 80,
      volatility: 0.5,
    });
    expect(low).toBeGreaterThanOrEqual(0);
  });
});

describe('computeVolatility', () => {
  it('returns 0 for flat or insufficient series', () => {
    expect(computeVolatility(Float64Array.from([100, 100, 100]))).toBe(0);
    expect(computeVolatility(Float64Array.from([100]))).toBe(0);
  });

  it('measures the standard deviation of returns', () => {
    expect(computeVolatility(Float64Array.from([100, 110, 100, 110]))).toBeCloseTo(0.09, 2);
  });
});

describe('buildQuantPortfolio', () => {
  it('proportionally weights allocations by quant score', async () => {
    const deps = makeDeps();
    const assets = [makeAsset('A'), makeAsset('B'), makeAsset('C'), makeAsset('D')];

    const result = await buildQuantPortfolio(
      { preferences: { totalCapital: 30000, riskProfile: 'aggressive' }, availableAssets: assets },
      deps,
    );

    expect(result).toHaveLength(3);
    for (const allocation of result) {
      expect(allocation.weight).toBeCloseTo(1 / 3, 5);
      expect(allocation.allocatedAmount).toBeCloseTo(10000, 2);
    }
  });

  it('respects excluded tickers', async () => {
    const deps = makeDeps();
    const assets = [makeAsset('A'), makeAsset('B'), makeAsset('C'), makeAsset('D')];

    const result = await buildQuantPortfolio(
      {
        preferences: { totalCapital: 30000, riskProfile: 'aggressive' },
        availableAssets: assets,
        excludeTickers: new Set(['A']),
      },
      deps,
    );

    expect(result.map((a) => a.ticker)).toEqual(['B', 'C', 'D']);
  });

  it('falls back to the static signal score for non-crypto assets', async () => {
    const deps = makeDeps();
    const stock = makeAsset('AAPL');

    const result = await buildQuantPortfolio(
      { preferences: { totalCapital: 1000, riskProfile: 'aggressive' }, availableAssets: [stock] },
      deps,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.ticker).toBe('AAPL');
    expect(result[0]?.weight).toBeCloseTo(1, 5);
    expect(deps.fetchCloses).not.toHaveBeenCalled();
    expect(deps.computeIndicators).not.toHaveBeenCalled();
  });
});
