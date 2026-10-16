import { describe, expect, it, vi } from 'vitest';
import { buildQuantPortfolio, type QuantDeps } from '@/lib/roboAdvisor';
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
    // Static Multi-Factor inputs: mid RSI, +1% momentum, 2% daily risk.
    risk_pct: 0.02,
    reward_pct: null,
    volume_spike: null,
    rsi_14: 50,
    change_24h: 0.01,
    updated_at: null,
  };
}

function makeDeps(): QuantDeps {
  return {
    fetchHistory: vi.fn(async () => ({
      closes: Float64Array.from([90, 100, 110]),
      highs: Float64Array.from([92, 102, 112]),
      lows: Float64Array.from([88, 98, 108]),
    })),
    computeIndicators: vi.fn(async () => ({
      rsi14: Float64Array.from([25]),
      macd: {
        macd: Float64Array.from([NaN]),
        signal: Float64Array.from([NaN]),
        // Histogram of 1.0 on a $100 price = +1% momentum (saturating).
        histogram: Float64Array.from([1]),
      },
      // ATR of 5 on a $100 price = 5% daily range (blown-out regime).
      atr14: Float64Array.from([5]),
    })),
  };
}

describe('buildQuantPortfolio', () => {
  it('ranks allocations by Multi-Factor score and sizes positions at 2% risk', async () => {
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
      // Static path: RSI 50 → 55, +1% momentum → 100, 2% risk → 70;
      // 0.4×55 + 0.4×100 + 0.2×70 = 76.
      expect(allocation.score).toBe(76);
      // ATR proxy = 100 × 0.02 = 2 → risk 2% × 30,000 = 600 → 300 shares.
      expect(allocation.suggestedShares).toBe(300);
    }
    expect(deps.fetchHistory).not.toHaveBeenCalled();
    expect(deps.computeIndicators).not.toHaveBeenCalled();
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

  it('uses worker indicators for crypto and applies the ATR sizing model', async () => {
    const deps = makeDeps();
    const btc = { ...makeAsset('BTC-USD'), rsi_14: null, change_24h: null, risk_pct: null };

    const result = await buildQuantPortfolio(
      { preferences: { totalCapital: 10000, riskProfile: 'aggressive' }, availableAssets: [btc] },
      deps,
    );

    expect(deps.fetchHistory).toHaveBeenCalledTimes(1);
    expect(deps.computeIndicators).toHaveBeenCalledTimes(1);

    const allocation = result[0];
    expect(allocation).toBeDefined();
    // RSI 25 → 95.83, MACD +1% → 100, ATR 5% → 10 → 80.33 → 80.
    expect(allocation?.score).toBe(80);
    // Risk = 2% × 10,000 = $200; shares = 200 / ATR 5 = 40 (stop at 100 − 5).
    expect(allocation?.suggestedShares).toBe(40);
  });

  it('falls back to the static multi-factor inputs for non-crypto assets', async () => {
    const deps = makeDeps();
    const stock = makeAsset('AAPL');

    const result = await buildQuantPortfolio(
      { preferences: { totalCapital: 1000, riskProfile: 'aggressive' }, availableAssets: [stock] },
      deps,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.ticker).toBe('AAPL');
    expect(result[0]?.weight).toBeCloseTo(1, 5);
    expect(result[0]?.score).toBe(76);
    expect(deps.fetchHistory).not.toHaveBeenCalled();
    expect(deps.computeIndicators).not.toHaveBeenCalled();
  });

  it('treats signed provider risk as a volatility magnitude for sizing', async () => {
    const deps = makeDeps();
    const asset = { ...makeAsset('WEAK'), risk_pct: -0.02 };

    const result = await buildQuantPortfolio(
      { preferences: { totalCapital: 10000, riskProfile: 'aggressive' }, availableAssets: [asset] },
      deps,
    );

    const allocation = result[0];
    // |−0.02| behaves exactly like +0.02: same factor inputs, same score…
    expect(allocation?.score).toBe(76);
    // …and sizing still works: 2% × 10,000 = $200 ÷ (100 × 0.02) = 100 shares.
    expect(allocation?.suggestedShares).toBe(100);
  });

  it('drops assets with no usable signal data', async () => {
    const deps: QuantDeps = {
      fetchHistory: vi.fn(async () => ({
        closes: Float64Array.from([100]),
        highs: Float64Array.from([100]),
        lows: Float64Array.from([100]),
      })),
      computeIndicators: vi.fn(),
    };
    const asset = { ...makeAsset('ETH-USD'), rsi_14: null, change_24h: null, risk_pct: null };

    const result = await buildQuantPortfolio(
      { preferences: { totalCapital: 1000, riskProfile: 'aggressive' }, availableAssets: [asset] },
      deps,
    );

    // A single close skips the worker bundle and the static path has no
    // factor data → score 0 → filtered out.
    expect(result).toEqual([]);
    expect(deps.computeIndicators).not.toHaveBeenCalled();
  });
});
