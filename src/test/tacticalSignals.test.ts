import { describe, expect, it } from 'vitest';
import {
  buildSignalFeed,
  generateTacticalSignals,
  type TacticalSignal,
} from '@/lib/tacticalSignals';
import { evaluateCandles, type CanonicalResult } from '@/lib/canonicalModel';
import { okResult, STRONG_INPUTS, WEAK_INPUTS } from './canonicalFixtures';
import type { TriggeredAlert } from '@/lib/alertsStore';
import type { Asset } from '@/lib/assets';
import type { Position } from '@/lib/portfolioAccounting';

function asset(ticker: string): Asset {
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
    // Static provider columns are ignored: only the canonical result counts.
    risk_pct: 0.02,
    reward_pct: 0.5,
    volume_spike: 3,
    rsi_14: 50,
    change_24h: 0.01,
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

const STRONG_RESULT = okResult(STRONG_INPUTS);
const WEAK_RESULT = okResult(WEAK_INPUTS);
const SCORES = new Map<string, CanonicalResult>([
  ['STRONG', STRONG_RESULT],
  ['IDEA', STRONG_RESULT],
  ['WEAK', WEAK_RESULT],
  ['NODATA', evaluateCandles([])],
]);
const STRONG = asset('STRONG');
const WEAK = asset('WEAK');
const NODATA = asset('NODATA');

describe('generateTacticalSignals', () => {
  it('uses the canonical score and carries its regime and rationale', () => {
    const [signal] = generateTacticalSignals([], [STRONG], 1000, SCORES);

    expect(STRONG_RESULT.signal_score).toBeGreaterThanOrEqual(85);
    expect(signal).toEqual({
      type: 'BUY',
      ticker: 'STRONG',
      score: STRONG_RESULT.signal_score,
      regime: STRONG_RESULT.regime,
      rationale: STRONG_RESULT.rationale,
      asOf: null,
    });
  });

  it('sells weak holdings, never an asset without enough data, and lists sells first', () => {
    const signals = generateTacticalSignals(
      [held('WEAK'), held('NODATA'), held('LOADING'), held('STRONG')],
      [STRONG, NODATA, WEAK, asset('LOADING'), asset('IDEA')],
      1000,
      SCORES,
    );

    expect(WEAK_RESULT.signal_score).toBeLessThan(50);
    expect(signals.map((signal) => `${signal.type} ${signal.ticker}`)).toEqual([
      'SELL WEAK',
      'BUY IDEA',
    ]);
  });

  it('suggests no buys without cash to deploy', () => {
    expect(generateTacticalSignals([held('WEAK')], [STRONG, WEAK], 0, SCORES)).toMatchObject([
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
    expect(generateTacticalSignals([], [dated], 1000, SCORES)[0]?.asOf).toBe(T);
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
