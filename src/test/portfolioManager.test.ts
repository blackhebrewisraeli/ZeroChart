import { describe, expect, it } from 'vitest';
import {
  calculatePortfolioStats,
  deriveRiskLabel,
  generateShareText,
  type Position,
} from '@/lib/portfolioManager';
import type { Asset } from '@/lib/assets';
import { evaluateCandles, type CanonicalResult } from '@/lib/canonicalModel';
import { okResult, STRONG_INPUTS } from './canonicalFixtures';

/** A canonical OK result carrying `score` (the factor detail is irrelevant here). */
const scored = (score: number): CanonicalResult => ({
  ...okResult(STRONG_INPUTS),
  signal_score: score,
});

const NO_SCORES = new Map<string, CanonicalResult>();

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

    const stats = calculatePortfolioStats(positions, assets, NO_SCORES);

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
    const assets = [makeAsset('A', 0.1, 0.1, 100), makeAsset('B', 0.3, 0.1, 100)];
    const scores = new Map([
      ['A', scored(40)],
      ['B', scored(80)],
    ]);

    const stats = calculatePortfolioStats(positions, assets, scores);

    // (40 * 100 + 80 * 300) / 400 = 70
    expect(stats.healthScore).toBeCloseTo(70, 5);
  });

  it('falls back to buy price when a position has no live price', () => {
    const positions = [makePosition({ id: 'x', ticker: 'MISSING', buyPrice: 100, shares: 5 })];
    const stats = calculatePortfolioStats(positions, [], NO_SCORES);

    expect(stats.totalInvested).toBe(500);
    expect(stats.totalValue).toBe(500);
    expect(stats.unrealizedPnL).toBe(0);
    expect(stats.pnlPercent).toBe(0);
    // No canonical score anywhere → no health reading, never a fake 0.
    expect(stats.healthScore).toBeNull();
  });

  it('leaves unscored holdings out of the health score but still values them at cost', () => {
    const positions = [
      makePosition({ id: 'a', ticker: 'A', buyPrice: 100, shares: 1 }),
      makePosition({ id: 'ghost', ticker: 'GHOST', buyPrice: 50, shares: 4 }),
      makePosition({ id: 'new', ticker: 'NEW', buyPrice: 50, shares: 4 }),
    ];
    const assets = [makeAsset('A', 0.3, 0.1, 100)];
    const scores = new Map([
      ['A', scored(80)],
      ['NEW', evaluateCandles([])], // INSUFFICIENT_DATA
    ]);

    const stats = calculatePortfolioStats(positions, assets, scores);

    expect(stats.totalInvested).toBe(500);
    expect(stats.totalValue).toBe(500);
    expect(stats.unrealizedPnL).toBe(0);
    expect(stats.healthScore).toBe(80);
  });

  it('returns zeroed stats for an empty portfolio', () => {
    expect(calculatePortfolioStats([], [], NO_SCORES)).toEqual({
      totalValue: 0,
      totalInvested: 0,
      unrealizedPnL: 0,
      pnlPercent: 0,
      healthScore: null,
    });
  });
});

describe('generateShareText', () => {
  it('formats allocation, risk label, and footer sorted by descending weight', () => {
    const positions = [
      makePosition({ id: 'btc', ticker: 'BTC-USD', buyPrice: 100, shares: 4 }),
      makePosition({ id: 'eth', ticker: 'ETH-USD', buyPrice: 100, shares: 3 }),
      makePosition({ id: 'aapl', ticker: 'AAPL', buyPrice: 100, shares: 3 }),
    ];
    const assets = [
      makeAsset('BTC-USD', 0.1, 0.05, 100),
      makeAsset('ETH-USD', 0.1, 0.06, 100),
      makeAsset('AAPL', 0.1, 0.02, 100),
    ];

    const text = generateShareText(positions, assets);

    expect(text).toBe(
      [
        'My ZeroChart Portfolio 🚀',
        'Risk: Moderate',
        '• 40% BTC-USD',
        '• 30% ETH-USD',
        '• 30% AAPL',
        'Simulated with ZeroChart.',
      ].join('\n'),
    );
  });

  it('falls back to buy price and a neutral risk label when live data is missing', () => {
    const positions = [makePosition({ id: 'x', ticker: 'X', buyPrice: 50, shares: 2 })];

    const text = generateShareText(positions, []);

    expect(text).toBe(
      ['My ZeroChart Portfolio 🚀', 'Risk: Moderate', '• 100% X', 'Simulated with ZeroChart.'].join(
        '\n',
      ),
    );
  });

  it('reports an empty portfolio without fabricating allocations', () => {
    expect(generateShareText([], [])).toBe(
      [
        'My ZeroChart Portfolio 🚀',
        'Risk: Moderate',
        '• No positions yet',
        'Simulated with ZeroChart.',
      ].join('\n'),
    );
  });
});

describe('deriveRiskLabel', () => {
  it('maps value-weighted risk into conservative, moderate, and aggressive bands', () => {
    expect(deriveRiskLabel(0.02)).toBe('Conservative');
    expect(deriveRiskLabel(0.04)).toBe('Moderate');
    expect(deriveRiskLabel(0.08)).toBe('Moderate');
    expect(deriveRiskLabel(0.12)).toBe('Aggressive');
    expect(deriveRiskLabel(null)).toBe('Moderate');
  });
});
