import { describe, expect, it } from 'vitest';
import type { Candle } from '@/lib/binance';
import {
  evaluateOpportunityDecisions,
  evaluateOpportunitySlot,
  type OpportunityDecisionConfig,
  type OpportunitySnapshot,
} from '@/lib/opportunityRadar';

const DAY_MS = 86_400_000;
const START = Date.UTC(2025, 0, 1);
const EVALUATION_TIME = START + 200 * DAY_MS + 30 * 60_000;

const CONFIG: OpportunityDecisionConfig = {
  specificationId: 'specification-v1',
  studyId: 'opportunity-radar-v1',
  universe: [
    { ticker: 'BTC-USD', instrument: 'BTCUSDT' },
    { ticker: 'ETH-USD', instrument: 'ETHUSDT' },
  ],
  indicators: { smaFast: 50, smaSlow: 200 },
  candidate: {
    minimumScore: 78,
    minimumMomentumPercent: 0.0005,
    excludeHighVolatility: true,
    requireCloseAboveFastSma: true,
    requireFastSmaAboveSlowSma: true,
  },
  marketGate: {
    benchmark: 'BTC-USD',
    excludeHighVolatility: true,
    requireCloseAboveSlowSma: true,
    requireFastSmaAboveSlowSma: true,
  },
  opportunity: {
    entryZoneAtrBelowClose: 0.5,
    entryZoneAtrAboveClose: 0.25,
    invalidationAtrBelowClose: 2,
    validDailyOpens: 3,
    primaryHorizonDays: 20,
    secondaryHorizonDays: [5, 10, 30],
  },
};

function snapshot(overrides: Partial<OpportunitySnapshot> = {}): OpportunitySnapshot {
  return {
    ticker: 'BTC-USD',
    instrument: 'BTCUSDT',
    scannerStatus: 'EVALUATED',
    closedCandles: 200,
    rank: 1,
    close: 110,
    atr: 5,
    smaFast: 105,
    smaSlow: 100,
    score: 78,
    momentumPercent: 0.0005,
    regime: 'NEUTRAL',
    ...overrides,
  };
}

function evaluate(
  asset: OpportunitySnapshot,
  benchmark: OpportunitySnapshot = snapshot(),
  previousQualified: readonly string[] = [],
) {
  const snapshots = asset.ticker === benchmark.ticker ? [asset] : [benchmark, asset];
  return evaluateOpportunityDecisions(snapshots, CONFIG, EVALUATION_TIME, {
    status: 'COMPLETE',
    qualifiedTickers: previousQualified,
  });
}

function candle(index: number, close = 100 + index * 0.05): Candle {
  const timestamp = START + index * DAY_MS;
  return {
    timestamp,
    closeTime: timestamp + DAY_MS - 1,
    open: close - 0.1,
    high: close + 0.5,
    low: close - 0.5,
    close,
  };
}

describe('Opportunity Radar decision boundaries', () => {
  it.each([
    ['benchmark close equal to SMA200', { close: 100 }, 'MARKET_CLOSE_NOT_ABOVE_SLOW_SMA'],
    ['benchmark SMA50 equal to SMA200', { smaFast: 100 }, 'MARKET_FAST_SMA_NOT_ABOVE_SLOW_SMA'],
    ['benchmark high volatility', { regime: 'HIGH_VOLATILITY' }, 'MARKET_HIGH_VOLATILITY'],
  ] as const)('closes the market gate when %s', (_label, changes, reason) => {
    const result = evaluate(snapshot({ ticker: 'ETH-USD', instrument: 'ETHUSDT' }), {
      ...snapshot(),
      ...changes,
    });

    expect(result.marketGate).toEqual({ passed: false, reasons: [reason] });
    expect(result.assets.find((asset) => asset.ticker === 'ETH-USD')).toMatchObject({
      qualified: false,
      reasons: ['MARKET_GATE_CLOSED'],
    });
  });

  it.each([
    ['close equal to SMA50', { close: 105 }, 'CLOSE_NOT_ABOVE_FAST_SMA'],
    ['SMA50 equal to SMA200', { smaFast: 100 }, 'FAST_SMA_NOT_ABOVE_SLOW_SMA'],
    ['score below 78', { score: 77 }, 'SCORE_BELOW_MINIMUM'],
    ['momentum below 0.0005', { momentumPercent: 0.00049 }, 'MOMENTUM_BELOW_MINIMUM'],
    ['high volatility', { regime: 'HIGH_VOLATILITY' }, 'HIGH_VOLATILITY'],
    ['only 199 closed candles', { closedCandles: 199 }, 'INSUFFICIENT_HISTORY'],
  ] as const)('rejects a candidate whose %s', (_label, changes, reason) => {
    const result = evaluate(snapshot({ ticker: 'ETH-USD', instrument: 'ETHUSDT', ...changes }));

    expect(result.assets.find((asset) => asset.ticker === 'ETH-USD')).toMatchObject({
      qualified: false,
      reasons: [reason],
    });
  });

  it('accepts exact score and momentum thresholds when strict trend boundaries pass', () => {
    const result = evaluate(snapshot({ ticker: 'ETH-USD', instrument: 'ETHUSDT' }));

    expect(result.marketGate).toEqual({ passed: true, reasons: [] });
    expect(result.assets.find((asset) => asset.ticker === 'ETH-USD')).toMatchObject({
      qualified: true,
      reasons: [],
    });
  });

  it('returns every failed reason in stable contract order', () => {
    const result = evaluate(
      snapshot({
        ticker: 'ETH-USD',
        instrument: 'ETHUSDT',
        close: 100,
        smaFast: 100,
        score: 77,
        momentumPercent: 0,
        regime: 'HIGH_VOLATILITY',
      }),
    );

    expect(result.assets.find((asset) => asset.ticker === 'ETH-USD')?.reasons).toEqual([
      'CLOSE_NOT_ABOVE_FAST_SMA',
      'FAST_SMA_NOT_ABOVE_SLOW_SMA',
      'SCORE_BELOW_MINIMUM',
      'MOMENTUM_BELOW_MINIMUM',
      'HIGH_VOLATILITY',
    ]);
  });
});

describe('Opportunity Radar transitions and payload', () => {
  it.each([
    ['first slot', undefined, false],
    ['failed previous slot', { status: 'FAILED', qualifiedTickers: [] }, false],
    ['partial previous slot', { status: 'PARTIAL', qualifiedTickers: [] }, false],
    ['false to true', { status: 'COMPLETE', qualifiedTickers: [] }, true],
    ['true to true', { status: 'COMPLETE', qualifiedTickers: ['ETH-USD'] }, false],
  ] as const)(
    '%s emits a new opportunity only for a known false→true transition',
    (_label, previous, expected) => {
      const asset = snapshot({ ticker: 'ETH-USD', instrument: 'ETHUSDT' });
      const result = evaluateOpportunityDecisions(
        [snapshot(), asset],
        CONFIG,
        EVALUATION_TIME,
        previous,
      );

      expect(result.assets.find((item) => item.ticker === 'ETH-USD')?.newTransition).toBe(expected);
      expect(result.opportunities.some((item) => item.ticker === 'ETH-USD')).toBe(expected);
    },
  );

  it('builds the complete entry, invalidation, expiry and horizon payload', () => {
    const asset = snapshot({
      ticker: 'ETH-USD',
      instrument: 'ETHUSDT',
      close: 110,
      atr: 4,
      rank: 2,
    });
    const result = evaluateOpportunityDecisions([snapshot(), asset], CONFIG, EVALUATION_TIME, {
      status: 'COMPLETE',
      qualifiedTickers: [],
    });

    expect(result.opportunities.find((item) => item.ticker === 'ETH-USD')).toEqual({
      id: `${new Date(EVALUATION_TIME).toISOString()}|ETH-USD`,
      specificationId: 'specification-v1',
      evaluationTime: EVALUATION_TIME,
      ticker: 'ETH-USD',
      instrument: 'ETHUSDT',
      rank: 2,
      score: 78,
      regime: 'NEUTRAL',
      momentumPercent: 0.0005,
      anchorClose: 110,
      atr: 4,
      entryZone: { low: 108, high: 111 },
      invalidation: 102,
      validDailyOpens: 3,
      expiresAt: EVALUATION_TIME + 3 * DAY_MS,
      primaryHorizonDays: 20,
      secondaryHorizonDays: [5, 10, 30],
    });
  });
});

describe('evaluateOpportunitySlot', () => {
  it('keeps a 199-candle scanner result visible but ineligible', () => {
    const candles = Array.from({ length: 199 }, (_, index) => candle(index));
    const result = evaluateOpportunitySlot(
      [{ ticker: 'BTC-USD', instrument: 'BINANCE:BTCUSDT', candles }],
      CONFIG,
      EVALUATION_TIME,
    );

    expect(result.scan.results[0]?.status).toBe('EVALUATED');
    expect(result.assets[0]).toMatchObject({
      scannerStatus: 'EVALUATED',
      closedCandles: 199,
      qualified: false,
      reasons: ['INSUFFICIENT_HISTORY'],
    });
  });

  it('is byte-identical when input after the logical slot is changed', () => {
    const closed = Array.from({ length: 200 }, (_, index) => candle(index));
    const first = evaluateOpportunitySlot(
      [{ ticker: 'BTC-USD', instrument: 'BINANCE:BTCUSDT', candles: closed }],
      CONFIG,
      EVALUATION_TIME,
    );
    const withFuture = evaluateOpportunitySlot(
      [
        {
          ticker: 'BTC-USD',
          instrument: 'BINANCE:BTCUSDT',
          candles: [...closed, candle(200, 1_000_000)],
        },
      ],
      CONFIG,
      EVALUATION_TIME,
    );

    expect(JSON.stringify(withFuture)).toBe(JSON.stringify(first));
  });
});
