import { describe, expect, it } from 'vitest';
import {
  DAILY_TIMEFRAME,
  EVALUATION_STRATEGY_VERSION,
  evaluateInput,
  type EvaluationConfig,
  type EvaluationCandle,
  type EvaluationInput,
} from '@/lib/evaluationLab';
import { CANONICAL_MODEL_VERSION, MIN_CANDLES } from '@/lib/canonicalModel';

const day = 24 * 60 * 60 * 1000;
const evaluationTime = Date.UTC(2026, 0, 1);

function candles(count: number, offset = 0): EvaluationCandle[] {
  return Array.from({ length: count }, (_, index) => {
    const timestamp = evaluationTime - (count - index) * day + offset;
    const close = 100 + index;
    return {
      timestamp,
      closeTime: timestamp + day,
      high: close + 2,
      low: close - 2,
      close,
    };
  });
}

function config(): EvaluationConfig {
  return {
    strategyVersion: EVALUATION_STRATEGY_VERSION,
    modelVersion: CANONICAL_MODEL_VERSION,
    universe: ['BTC-USD', 'ETH-USD'],
    timeframe: DAILY_TIMEFRAME,
    riskProfile: 'moderate',
    totalCapital: 100_000,
    maxDataAgeMs: 2 * day,
    executionTiming: 'next_observation_after_closed_candle',
    costs: { feeBps: 25, slippageBps: 0 },
    exitBehavior: 'none_in_evaluation_lab',
    benchmark: 'not_applicable_without_executable_exits',
    assumptions: [],
    limitations: [],
    configurationId: 'fixture-config-v1',
  };
}

describe('evaluation lab', () => {
  it('replays the same closed inputs deterministically', () => {
    const input: EvaluationInput = {
      evaluationTime,
      assets: [
        {
          ticker: 'BTC-USD',
          source: 'fixture',
          timeframe: DAILY_TIMEFRAME,
          candles: candles(40),
        },
      ],
    };
    expect(evaluateInput(input, config())).toEqual(evaluateInput(input, config()));
  });

  it('excludes the open candle and preserves model attribution', () => {
    const input: EvaluationInput = {
      evaluationTime,
      assets: [
        {
          ticker: 'BTC-USD',
          source: 'fixture',
          timeframe: DAILY_TIMEFRAME,
          candles: candles(40).map((candle, index, all) =>
            index === all.length - 1 ? { ...candle, closeTime: evaluationTime + day } : candle,
          ),
        },
      ],
    };
    const run = evaluateInput(input, config());
    expect(run.decisions[0]?.observedInputCount).toBe(39);
    expect(run.decisions[0]?.modelVersion).toBe(CANONICAL_MODEL_VERSION);
    expect(run.decisions[0]?.configurationId).toBe('fixture-config-v1');
  });

  it('records stale, insufficient-history, and no-data outcomes', () => {
    const input: EvaluationInput = {
      evaluationTime,
      assets: [
        {
          ticker: 'STALE',
          source: 'fixture',
          timeframe: DAILY_TIMEFRAME,
          candles: candles(40, -5 * day),
        },
        {
          ticker: 'SHORT',
          source: 'fixture',
          timeframe: DAILY_TIMEFRAME,
          candles: candles(MIN_CANDLES - 1),
        },
        { ticker: 'EMPTY', source: 'fixture', timeframe: DAILY_TIMEFRAME, candles: [] },
      ],
    };
    const run = evaluateInput(input, config());
    expect(run.decisions.map((decision) => decision.status)).toEqual([
      'STALE_DATA',
      'INSUFFICIENT_HISTORY',
      'DATA_UNAVAILABLE',
    ]);
  });

  it('records a failed market-data fetch without substituting synthetic values', () => {
    const run = evaluateInput(
      {
        evaluationTime,
        assets: [
          {
            ticker: 'FAILED',
            source: 'binance-rest',
            timeframe: DAILY_TIMEFRAME,
            candles: [],
            error: 'request timed out',
          },
        ],
      },
      config(),
    );
    expect(run.decisions[0]?.status).toBe('DATA_FETCH_FAILED');
    expect(run.decisions[0]?.rejectionReasons[0]?.detail).toContain('request timed out');
    expect(run.decisions[0]?.inputSnapshot).toEqual([]);
  });

  it('is idempotent at the logical decision-key level', () => {
    const input: EvaluationInput = {
      evaluationTime,
      assets: [
        { ticker: 'BTC-USD', source: 'fixture', timeframe: DAILY_TIMEFRAME, candles: candles(40) },
      ],
    };
    const first = evaluateInput(input, config());
    const second = evaluateInput(input, config());
    expect(first.decisions.map((decision) => decision.logicalKey)).toEqual(
      second.decisions.map((decision) => decision.logicalKey),
    );
  });

  it('never exposes a trading mutation surface', () => {
    const input: EvaluationInput = {
      evaluationTime,
      assets: [
        {
          ticker: 'BTC-USD',
          source: 'fixture',
          timeframe: DAILY_TIMEFRAME,
          candles: candles(40).map((candle, index, all) =>
            index === all.length - 1 ? { ...candle, closeTime: evaluationTime + day } : candle,
          ),
        },
      ],
    };
    const run = evaluateInput(input, config());
    expect(run.decisions[0]?.proposedAction).toMatch(/PROPOSE_ALLOCATION|REJECT/);
    expect(run.decisions[0]).not.toHaveProperty('fill');
    expect(run.decisions[0]).not.toHaveProperty('transaction');
  });
});
