import { describe, expect, it } from 'vitest';
import {
  calculatePortfolioStats,
  generateSuggestions,
  type Position,
} from '@/lib/portfolioManager';
import type { Asset } from '@/lib/assets';

function makeAsset(
  ticker: string,
  rewardPct: number,
  riskPct: number,
  currentPrice: number | null = null,
): Asset {
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
    risk_pct: riskPct,
    reward_pct: rewardPct,
    volume_spike: null,
    rsi_14: null,
    change_24h: null,
    updated_at: null,
  };
}

function makePosition(overrides: Partial<Position> & { id: string }): Position {
  return {
    id: overrides.id,
    ticker: overrides.ticker ?? 'AAPL',
    buyPrice: overrides.buyPrice ?? 100,
    shares: overrides.shares ?? 10,
    isSimulation: overrides.isSimulation ?? false,
    dateAdded: overrides.dateAdded ?? '2026-01-01',
  };
}

describe('calculatePortfolioStats', () => {
  it('computes value, invested capital, and PnL for profitable and losing positions', () => {
    const positions = [
      makePosition({ id: 'win', ticker: 'WIN', buyPrice: 100, shares: 10 }),
      makePosition({ id: 'lose', ticker: 'LOSE', buyPrice: 50, shares: 20 }),
    ];
    const assets = [makeAsset('WIN', 0.1, 0.1, 150), makeAsset('LOSE', 0.1, 0.1, 40)];

    const stats = calculatePortfolioStats(positions, assets);

    expect(stats.totalInvested).toBe(2000);
    expect(stats.totalValue).toBe(2300);
    expect(stats.unrealizedPnL).toBe(300);
    expect(stats.pnlPercent).toBeCloseTo(15, 5);
  });

  it('weights the health score by current market value', () => {
    const positions = [
      makePosition({ id: 'a', ticker: 'A', buyPrice: 100, shares: 1 }),
      makePosition({ id: 'b', ticker: 'B', buyPrice: 100, shares: 3 }),
    ];
    const assets = [
      makeAsset('A', 0.1, 0.1, 100), // Signal Score 40
      makeAsset('B', 0.3, 0.1, 100), // Signal Score 80
    ];

    const stats = calculatePortfolioStats(positions, assets);

    // (40 * 100 + 80 * 300) / 400 = 70
    expect(stats.healthScore).toBeCloseTo(70, 5);
  });

  it('falls back to buy price when a position has no live price', () => {
    const positions = [makePosition({ id: 'x', ticker: 'MISSING', buyPrice: 100, shares: 5 })];
    const stats = calculatePortfolioStats(positions, []);

    expect(stats.totalInvested).toBe(500);
    expect(stats.totalValue).toBe(500);
    expect(stats.unrealizedPnL).toBe(0);
    expect(stats.pnlPercent).toBe(0);
    expect(stats.healthScore).toBe(0);
  });

  it('excludes unresolved assets from the health score but still values them at cost', () => {
    const positions = [
      makePosition({ id: 'a', ticker: 'A', buyPrice: 100, shares: 1 }),
      makePosition({ id: 'ghost', ticker: 'GHOST', buyPrice: 50, shares: 4 }),
    ];
    const assets = [makeAsset('A', 0.3, 0.1, 100)]; // Signal Score 80

    const stats = calculatePortfolioStats(positions, assets);

    expect(stats.totalInvested).toBe(300);
    expect(stats.totalValue).toBe(300);
    expect(stats.unrealizedPnL).toBe(0);
    expect(stats.healthScore).toBe(80);
  });

  it('returns zeroed stats for an empty portfolio', () => {
    expect(calculatePortfolioStats([], [])).toEqual({
      totalValue: 0,
      totalInvested: 0,
      unrealizedPnL: 0,
      pnlPercent: 0,
      healthScore: 0,
    });
  });
});

describe('generateSuggestions', () => {
  it('flags held assets whose signal score drops below 50 for selling', () => {
    const positions = [
      makePosition({ id: 'weak', ticker: 'WEAK' }),
      makePosition({ id: 'ok', ticker: 'OK' }),
    ];
    const assets = [
      makeAsset('WEAK', 0.1, 0.1, 100), // 40
      makeAsset('OK', 0.3, 0.1, 100), // 80
      makeAsset('STRONG', 0.35, 0.1, 100), // 90
    ];

    const suggestions = generateSuggestions(positions, assets, 0);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ type: 'SELL', ticker: 'WEAK', score: 40 });
  });

  it('suggests buying non-held assets scoring 85+ when cash is available', () => {
    const positions = [makePosition({ id: 'held', ticker: 'HELD' })];
    const assets = [
      makeAsset('HELD', 0.35, 0.1, 100), // 90 (held, skipped)
      makeAsset('BUY_HIGH', 0.35, 0.1, 100), // 90
      makeAsset('BUY_EDGE', 0.325, 0.1, 100), // 85
      makeAsset('SKIP', 0.32, 0.1, 100), // 84
    ];

    const suggestions = generateSuggestions(positions, assets, 5000);

    expect(suggestions.map((suggestion) => suggestion.ticker).sort()).toEqual([
      'BUY_EDGE',
      'BUY_HIGH',
    ]);
    expect(suggestions.every((suggestion) => suggestion.type === 'BUY')).toBe(true);
  });

  it('does not suggest buys when there is no available cash', () => {
    const positions = [makePosition({ id: 'held', ticker: 'HELD' })];
    const assets = [
      makeAsset('HELD', 0.1, 0.1, 100), // 40
      makeAsset('STRONG', 0.35, 0.1, 100), // 90 (non-held)
    ];

    const suggestions = generateSuggestions(positions, assets, 0);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ type: 'SELL', ticker: 'HELD', score: 40 });
  });

  it('respects the exact score thresholds (49 vs 50, 84 vs 85)', () => {
    const positions = [
      makePosition({ id: 'at50', ticker: 'AT50' }),
      makePosition({ id: 'at49', ticker: 'AT49' }),
    ];
    const assets = [
      makeAsset('AT50', 0.15, 0.1, 100), // 50 (not below 50)
      makeAsset('AT49', 0.145, 0.1, 100), // 49 (below 50)
      makeAsset('AT84', 0.32, 0.1, 100), // 84 (not strong enough)
      makeAsset('AT85', 0.325, 0.1, 100), // 85 (strong enough)
    ];

    const suggestions = generateSuggestions(positions, assets, 1000);

    expect(
      suggestions.filter((suggestion) => suggestion.type === 'SELL').map((s) => s.ticker),
    ).toEqual(['AT49']);
    expect(
      suggestions.filter((suggestion) => suggestion.type === 'BUY').map((s) => s.ticker),
    ).toEqual(['AT85']);
  });

  it('collapses multiple lots of the same ticker into a single sell suggestion', () => {
    const positions = [
      makePosition({ id: 'lot-1', ticker: 'DUP' }),
      makePosition({ id: 'lot-2', ticker: 'DUP' }),
    ];
    const assets = [makeAsset('DUP', 0.1, 0.1, 100)]; // 40

    const suggestions = generateSuggestions(positions, assets, 0);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ type: 'SELL', ticker: 'DUP', score: 40 });
  });
});
