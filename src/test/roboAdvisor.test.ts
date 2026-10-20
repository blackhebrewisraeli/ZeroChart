import { describe, expect, it, vi } from 'vitest';
import { buildQuantPortfolio, scoreTicker, type QuantDeps } from '@/lib/roboAdvisor';
import type { Asset } from '@/lib/assets';
import { evaluateCandles, MIN_CANDLES, type EngineCandle } from '@/lib/canonicalModel';
import { recommendPositionSize } from '@/lib/risk';

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
    // Static provider columns the old proxy path read — the engine must ignore them.
    risk_pct: 0.5,
    reward_pct: 9,
    volume_spike: 9,
    rsi_14: 1,
    change_24h: 0.5,
    updated_at: null,
  };
}

/** Deterministic daily candles around $100 with a ±`range` intraday spread. */
function makeCandles(count: number, range = 0.5, drift = 0.1): EngineCandle[] {
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + Math.sin(i / 5) + drift * i;
    return { high: close + range, low: close - range, close };
  });
}

function depsFor(candlesByTicker: Record<string, EngineCandle[] | Error>): QuantDeps {
  return {
    fetchCandles: vi.fn(async (ticker: string) => {
      const candles = candlesByTicker[ticker] ?? [];
      if (candles instanceof Error) throw candles;
      return candles;
    }),
  };
}

function engineScore(candles: EngineCandle[]) {
  const result = evaluateCandles(candles);
  if (result.status !== 'OK') throw new Error('fixture must be scoreable');
  return result;
}

describe('scoreTicker', () => {
  it('returns the canonical result for the fetched candles', async () => {
    const candles = makeCandles(200);
    expect(await scoreTicker('BTC', depsFor({ BTC: candles }))).toEqual(evaluateCandles(candles));
  });

  it('never rejects: a failed fetch is INSUFFICIENT_DATA with zero candles', async () => {
    const result = await scoreTicker('BTC', depsFor({ BTC: new Error('network down') }));
    expect(result).toMatchObject({ status: 'INSUFFICIENT_DATA', received: 0 });
  });
});

describe('buildQuantPortfolio', () => {
  it('ranks by the canonical score and caps the 2%-risk size at the allocation', async () => {
    const candles = makeCandles(200);
    const engine = engineScore(candles);
    const deps = depsFor({ A: candles, B: candles, C: candles, D: candles });
    const assets = [makeAsset('A'), makeAsset('B'), makeAsset('C'), makeAsset('D')];

    const result = await buildQuantPortfolio(
      { preferences: { totalCapital: 30000, riskProfile: 'aggressive' }, availableAssets: assets },
      deps,
    );

    expect(result).toHaveLength(3);
    for (const allocation of result) {
      expect(allocation.weight).toBeCloseTo(1 / 3, 5);
      expect(allocation.allocatedAmount).toBeCloseTo(10000, 2);
      // The exact engine score — never a static-table proxy.
      expect(allocation.score).toBe(engine.signal_score);
      expect(allocation.regime).toBe(engine.regime);
      // ATR ≈ 1 on $100: 2% × 30,000 = $600 risk → ~600 risk-optimal shares
      // ($60,000 notional) — capped at the $10,000 allocation → 100 shares.
      expect(allocation.suggestedShares).toBe(100);
      expect((allocation.suggestedShares ?? 0) * 100).toBeLessThanOrEqual(
        allocation.allocatedAmount,
      );
    }
  });

  it('skips assets the engine reports as INSUFFICIENT_DATA', async () => {
    const candles = makeCandles(200);
    const deps = depsFor({
      BTC: candles,
      NEW: makeCandles(MIN_CANDLES - 1),
      DOWN: new Error('network down'),
      // AAPL: no candle source → []
    });
    const assets = [makeAsset('BTC'), makeAsset('NEW'), makeAsset('DOWN'), makeAsset('AAPL')];

    const result = await buildQuantPortfolio(
      { preferences: { totalCapital: 1000, riskProfile: 'conservative' }, availableAssets: assets },
      deps,
    );

    expect(result.map((allocation) => allocation.ticker)).toEqual(['BTC']);
    expect(result[0]?.weight).toBeCloseTo(1, 5);
    expect(deps.fetchCandles).toHaveBeenCalledTimes(4);
  });

  it('returns no portfolio when no asset has enough data', async () => {
    const deps = depsFor({ ETH: makeCandles(10) });
    const result = await buildQuantPortfolio(
      {
        preferences: { totalCapital: 1000, riskProfile: 'aggressive' },
        availableAssets: [makeAsset('ETH'), makeAsset('AAPL')],
      },
      deps,
    );
    expect(result).toEqual([]);
  });

  it('respects excluded tickers', async () => {
    const candles = makeCandles(200);
    const deps = depsFor({ A: candles, B: candles, C: candles, D: candles });
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

  it('sizes on the engine ATR, at the live price or else the last close', async () => {
    const candles = makeCandles(200, 5);
    const engine = engineScore(candles);
    const deps = depsFor({ LIVE: candles, CLOSE: candles });

    const [live] = await buildQuantPortfolio(
      {
        preferences: { totalCapital: 10000, riskProfile: 'aggressive' },
        availableAssets: [makeAsset('LIVE', 120)],
      },
      deps,
    );
    const [close] = await buildQuantPortfolio(
      {
        preferences: { totalCapital: 10000, riskProfile: 'aggressive' },
        availableAssets: [makeAsset('CLOSE', null)],
      },
      deps,
    );

    const size = (price: number) =>
      recommendPositionSize({ capital: 10000, price, atr: engine.atr, allocatedCapital: 10000 })
        .shares;
    expect(live?.suggestedShares).toBe(size(120));
    expect(close?.suggestedShares).toBe(size(engine.close));
  });

  it('attaches the engine breakdown (components, regime, rationale) to each row', async () => {
    const candles = makeCandles(200, 3);
    const engine = engineScore(candles);

    const [allocation] = await buildQuantPortfolio(
      {
        preferences: { totalCapital: 10000, riskProfile: 'aggressive' },
        availableAssets: [makeAsset('BTC')],
      },
      depsFor({ BTC: candles }),
    );

    expect(allocation).toMatchObject({
      score: engine.signal_score,
      components: engine.components,
      regime: engine.regime,
      rationale: engine.rationale,
    });
  });
});
