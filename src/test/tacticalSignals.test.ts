import { describe, expect, it } from 'vitest';
import {
  buildSignalFeed,
  generateTacticalSignals,
  type TacticalSignal,
} from '@/lib/tacticalSignals';
import { scoreAssetStatic } from '@/lib/roboAdvisor';
import type { TriggeredAlert } from '@/lib/alertsStore';
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
      asOf: null,
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

describe('buildSignalFeed', () => {
  const T = Date.parse('2026-10-18T12:00:00Z');
  const MIN = 60_000;

  function quant(ticker: string, type: 'BUY' | 'SELL', asOf: number | null): TacticalSignal {
    return { type, ticker, score: 50, regime: 'NEUTRAL', rationale: '', asOf };
  }

  function fired(id: string, triggeredAt: number): TriggeredAlert {
    const alert = {
      id,
      ticker: 'BTC-USD',
      targetPrice: 100,
      condition: 'above' as const,
      createdAt: 0,
      scope: 'session' as const,
    };
    return { alert, price: 101, triggeredAt };
  }

  const label = (feed: ReturnType<typeof buildSignalFeed>) =>
    feed.map((item) =>
      item.kind === 'alert' ? `alert ${item.trigger.alert.id}` : item.signal.ticker,
    );

  it('stamps quant signals with their market snapshot time', () => {
    const dated = { ...STRONG, updated_at: new Date(T).toISOString() };
    expect(generateTacticalSignals([], [dated], 1000)[0]?.asOf).toBe(T);
  });

  it('interleaves both signal types newest first', () => {
    const feed = buildSignalFeed(
      [quant('OLDQ', 'BUY', T - 10 * MIN), quant('NEWQ', 'SELL', T)],
      [fired('a1', T - 20 * MIN), fired('a2', T - 5 * MIN), fired('a3', T + MIN)],
    );
    expect(label(feed)).toEqual(['alert a3', 'NEWQ', 'alert a2', 'OLDQ', 'alert a1']);
    expect(feed.map((item) => item.at)).toEqual([
      T + MIN,
      T,
      T - 5 * MIN,
      T - 10 * MIN,
      T - 20 * MIN,
    ]);
  });

  it('keeps same-snapshot quant priority and sinks undated signals', () => {
    const feed = buildSignalFeed(
      [quant('SELL1', 'SELL', T), quant('BUY1', 'BUY', T), quant('NODATE', 'BUY', null)],
      [fired('a1', T - MIN)],
    );
    expect(label(feed)).toEqual(['SELL1', 'BUY1', 'alert a1', 'NODATE']);
  });

  it('shows fired alerts on their own when there is no quant signal', () => {
    expect(label(buildSignalFeed([], [fired('a1', T), fired('a2', T + MIN)]))).toEqual([
      'alert a2',
      'alert a1',
    ]);
  });
});
