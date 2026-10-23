import { describe, expect, it, vi } from 'vitest';
import {
  RISK_PROFILE_POLICIES,
  buildQuantPortfolio,
  qualifiesForRiskProfile,
  scoreTicker,
  type QuantDeps,
} from '@/lib/roboAdvisor';
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

/**
 * Deterministic daily candles from $100 with a ±`range` intraday spread. The
 * default slow decline is oversold enough to score 82, above every profile's
 * minimum.
 */
function makeCandles(count: number, range = 0.5, drift = -0.1): EngineCandle[] {
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
  it('enforces the hard conservative and aggressive risk policies', () => {
    expect(RISK_PROFILE_POLICIES.conservative.maxAllocation).toBe(0.1);
    expect(
      qualifiesForRiskProfile('conservative', {
        signal_score: 90,
        regime: 'HIGH_VOLATILITY',
        components: { momentumScore: 90 },
      }),
    ).toBe(false);
    expect(
      qualifiesForRiskProfile('aggressive', {
        signal_score: 70,
        regime: 'TRENDING',
        components: { momentumScore: 90 },
      }),
    ).toBe(false);
    expect(
      qualifiesForRiskProfile('aggressive', {
        signal_score: 90,
        regime: 'TRENDING',
        components: { momentumScore: 50 },
      }),
    ).toBe(false);
    expect(
      qualifiesForRiskProfile('aggressive', {
        signal_score: 71,
        regime: 'TRENDING',
        components: { momentumScore: 51 },
      }),
    ).toBe(true);
  });

  it('keeps conservative and moderate portfolios out of weak scores', () => {
    for (const profile of ['conservative', 'moderate'] as const) {
      const candidate = (signal_score: number) =>
        qualifiesForRiskProfile(profile, {
          signal_score,
          regime: 'NEUTRAL',
          components: { momentumScore: 40 },
        });
      // The model's own BUY band starts at 60; a score above 0 is not enough.
      expect(candidate(1)).toBe(false);
      expect(candidate(59)).toBe(false);
      expect(candidate(60)).toBe(true);
    }
  });

  it('retains cash instead of buying weak assets when too few qualify', async () => {
    const strong = makeCandles(200);
    // A steady climb is overbought: the engine scores it well under 60.
    const weak = makeCandles(200, 0.5, 0.1);
    const result = await buildQuantPortfolio(
      {
        preferences: { totalCapital: 10000, riskProfile: 'conservative' },
        availableAssets: [makeAsset('STRONG'), makeAsset('WEAK')],
      },
      depsFor({ STRONG: strong, WEAK: weak }),
    );

    expect(engineScore(weak).signal_score).toBeLessThan(60);
    expect(result.map((allocation) => allocation.ticker)).toEqual(['STRONG']);
    // One qualifying holding at the 10% cap: the other 90% stays Paper Cash.
    expect(result[0]?.allocatedAmount).toBe(1000);
  });

  it('ranks by the canonical score and caps the 2%-risk size at the allocation', async () => {
    const candles = makeCandles(200);
    const engine = engineScore(candles);
    const deps = depsFor({ A: candles, B: candles, C: candles, D: candles });
    const assets = [makeAsset('A'), makeAsset('B'), makeAsset('C'), makeAsset('D')];

    const result = await buildQuantPortfolio(
      { preferences: { totalCapital: 30000, riskProfile: 'moderate' }, availableAssets: assets },
      deps,
    );

    expect(result).toHaveLength(4);
    for (const allocation of result) {
      expect(allocation.weight).toBeCloseTo(0.25, 5);
      expect(allocation.allocatedAmount).toBeCloseTo(7500, 2);
      // The exact engine score — never a static-table proxy.
      expect(allocation.score).toBe(engine.signal_score);
      expect(allocation.regime).toBe(engine.regime);
      // ATR ≈ 1 on $100: 2% × 30,000 = $600 risk → ~600 risk-optimal shares
      // ($60,000 notional) — capped at the $7,500 allocation → 75 shares.
      expect(allocation.suggestedShares).toBe(75);
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
    expect(result[0]?.weight).toBeCloseTo(0.1, 5);
    expect(deps.fetchCandles).toHaveBeenCalledTimes(4);
  });

  it('reports isolated eligibility, missing-data, and network outcomes', async () => {
    const strong = makeCandles(200);
    const weak = makeCandles(200, 0.5, 0.1);
    const onDiagnostics = vi.fn();

    await buildQuantPortfolio(
      {
        preferences: { totalCapital: 10000, riskProfile: 'moderate' },
        availableAssets: [
          makeAsset('STRONG'),
          makeAsset('WEAK'),
          makeAsset('SHORT'),
          makeAsset('DOWN'),
        ],
        onDiagnostics,
      },
      depsFor({
        STRONG: strong,
        WEAK: weak,
        SHORT: makeCandles(MIN_CANDLES - 1),
        DOWN: new Error('network down'),
      }),
    );

    expect(onDiagnostics).toHaveBeenCalledWith({
      totalCandidates: 4,
      eligible: 1,
      insufficientData: 1,
      networkFailures: 1,
      belowMinimumScore: 1,
      highVolatility: 0,
      nonPositiveMomentum: 0,
    });
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
        preferences: { totalCapital: 30000, riskProfile: 'moderate' },
        availableAssets: assets,
        excludeTickers: new Set(['A']),
      },
      deps,
    );

    expect(result.map((a) => a.ticker)).toEqual(['B', 'C', 'D']);
  });

  it('sizes on the engine ATR, at the live price or else the last close', async () => {
    const candles = makeCandles(200);
    const engine = engineScore(candles);
    const deps = depsFor({ LIVE: candles, CLOSE: candles });

    const [live] = await buildQuantPortfolio(
      {
        preferences: { totalCapital: 10000, riskProfile: 'moderate' },
        availableAssets: [makeAsset('LIVE', 120)],
      },
      deps,
    );
    const [close] = await buildQuantPortfolio(
      {
        preferences: { totalCapital: 10000, riskProfile: 'moderate' },
        availableAssets: [makeAsset('CLOSE', null)],
      },
      deps,
    );

    const size = (price: number) =>
      recommendPositionSize({ capital: 10000, price, atr: engine.atr, allocatedCapital: 2500 })
        .shares;
    expect(live?.suggestedShares).toBe(size(120));
    expect(close?.suggestedShares).toBe(size(engine.close));
  });

  it('attaches the engine breakdown (components, regime, rationale) to each row', async () => {
    const candles = makeCandles(200);
    const engine = engineScore(candles);

    const [allocation] = await buildQuantPortfolio(
      {
        preferences: { totalCapital: 10000, riskProfile: 'moderate' },
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
