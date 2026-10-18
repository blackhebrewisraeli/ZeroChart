import { describe, expect, it } from 'vitest';
import { generateTacticalSignals } from '@/lib/tacticalSignals';
import { scoreAssetStatic } from '@/lib/roboAdvisor';
import type { Asset } from '@/lib/assets';
import type { Position } from '@/lib/portfolioAccounting';

function asset(
  ticker: string,
  rsi: number | null,
  change: number | null,
  risk: number | null,
): Asset {
  return {
    ticker,
    name: null,
    current_price: 100,
    sma_50: null,
    sma_200: null,
    stable_signal: null,
    radar_signal: null,
    stable_explanation: null,
    radar_explanation: null,
    risk_pct: risk,
    reward_pct: null,
    volume_spike: null,
    rsi_14: rsi,
    change_24h: change,
    updated_at: null,
  };
}

function held(ticker: string): Position {
  return {
    id: ticker,
    ticker,
    shares: 1,
    buyPrice: 100,
    isSimulation: true,
    dateAdded: '2026-01-01',
  };
}

// Oversold + bullish + quiet → top of the Multi-Factor scale; the mirror image → bottom.
const STRONG = asset('STRONG', 25, 0.02, 0.004);
const WEAK = asset('WEAK', 85, -0.02, 0.08);
const NODATA = asset('NODATA', null, null, null);

describe('generateTacticalSignals', () => {
  it('scores with the Multi-Factor engine and carries its regime and rationale', () => {
    const [signal] = generateTacticalSignals([], [STRONG], 1000);
    const { breakdown } = scoreAssetStatic(STRONG);

    expect(breakdown.score).toBeGreaterThanOrEqual(85);
    expect(signal).toEqual({
      type: 'BUY',
      ticker: 'STRONG',
      score: breakdown.score,
      regime: breakdown.regime,
      rationale: breakdown.rationale,
    });
  });

  it('sells weak holdings, never an asset with no factor data, and lists sells first', () => {
    const signals = generateTacticalSignals(
      [held('WEAK'), held('NODATA'), held('STRONG')],
      [STRONG, NODATA, WEAK, asset('IDEA', 25, 0.02, 0.004)],
      1000,
    );

    expect(scoreAssetStatic(WEAK).breakdown.score).toBeLessThan(50);
    expect(signals.map((signal) => `${signal.type} ${signal.ticker}`)).toEqual([
      'SELL WEAK',
      'BUY IDEA',
    ]);
  });

  it('suggests no buys without cash to deploy', () => {
    expect(generateTacticalSignals([held('WEAK')], [STRONG, WEAK], 0)).toMatchObject([
      { type: 'SELL', ticker: 'WEAK' },
    ]);
  });
});
