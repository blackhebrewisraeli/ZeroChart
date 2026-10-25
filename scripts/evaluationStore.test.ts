import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EvaluationConflictError,
  IncompleteEvaluationError,
  hashEvaluationInput,
  loadEvaluationRun,
  loadEvaluationRuns,
  saveEvaluationRun,
} from './evaluationStore';
import {
  DAILY_TIMEFRAME,
  EVALUATION_STRATEGY_VERSION,
  evaluateInput,
  type EvaluationConfig,
  type EvaluationCandle,
  type EvaluationInput,
  type EvaluationRun,
} from '@/lib/evaluationLab';
import { CANONICAL_MODEL_VERSION } from '@/lib/canonicalModel';

const day = 24 * 60 * 60 * 1000;
const evaluationTime = Date.UTC(2026, 0, 1);

function config(): EvaluationConfig {
  return {
    strategyVersion: EVALUATION_STRATEGY_VERSION,
    modelVersion: CANONICAL_MODEL_VERSION,
    universe: ['BTC-USD'],
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
    modelParameters: {
      rsiPeriod: 14,
      macdFast: 12,
      macdSlow: 26,
      macdSignal: 9,
      atrPeriod: 14,
      minimumCandles: 34,
    },
    eligibility: {
      minimumScore: 60,
      excludeHighVolatility: false,
      requirePositiveMomentum: false,
    },
    allocation: {
      maxAllocation: 0.25,
      maxHoldings: 5,
      method: 'score_proportional',
    },
    configurationId: 'store-test-config',
  };
}

function input(): EvaluationInput {
  const candles: EvaluationCandle[] = Array.from({ length: 40 }, (_, index) => {
    const timestamp = evaluationTime - (40 - index) * day;
    return { timestamp, closeTime: timestamp + day, high: 102, low: 98, close: 100 };
  });
  return {
    evaluationTime,
    assets: [{ ticker: 'BTC-USD', source: 'fixture', timeframe: DAILY_TIMEFRAME, candles }],
  };
}

function run(): EvaluationRun {
  const normalized = input();
  return evaluateInput(normalized, config(), hashEvaluationInput(normalized));
}

describe('evaluation store', () => {
  it('persists and reloads a complete run snapshot', async () => {
    const store = await mkdtemp(join(tmpdir(), 'zerochart-store-'));
    const saved = run();
    await saveEvaluationRun(saved, store);
    const loaded = await loadEvaluationRun(saved.runKey, store);
    expect(loaded.run.input.assets).toHaveLength(1);
    expect(loaded.run.decisions).toEqual(saved.decisions);
    expect(loaded.contract).toEqual(saved.configuration);
  });

  it('detects tampered inputs through the stored hash', async () => {
    const saved = run();
    const tampered = structuredClone(saved);
    const firstAsset = tampered.input.assets[0];
    if (!firstAsset) throw new Error('Expected fixture asset');
    const firstCandle = firstAsset.candles[0];
    if (!firstCandle) throw new Error('Expected fixture candle');
    tampered.input = {
      ...tampered.input,
      assets: [
        {
          ...firstAsset,
          candles: [
            { ...firstCandle, close: firstCandle.close + 1 },
            ...firstAsset.candles.slice(1),
          ],
        },
        ...tampered.input.assets.slice(1),
      ],
    };
    expect(hashEvaluationInput(tampered.input)).not.toBe(tampered.inputHash);
  });

  it('rejects a conflicting retry instead of overwriting a run', async () => {
    const store = await mkdtemp(join(tmpdir(), 'zerochart-store-'));
    const saved = run();
    await saveEvaluationRun(saved, store);
    const conflicting = structuredClone(saved);
    conflicting.inputHash = 'different';
    await expect(saveEvaluationRun(conflicting, store)).rejects.toBeInstanceOf(
      EvaluationConflictError,
    );
  });

  it('detects incomplete temporary artifacts', async () => {
    const store = await mkdtemp(join(tmpdir(), 'zerochart-store-'));
    await mkdir(join(store, 'runs'));
    await writeFile(join(store, 'runs', 'orphan.tmp-interrupted'), 'partial');
    await expect(loadEvaluationRun('missing', store)).rejects.toBeInstanceOf(
      IncompleteEvaluationError,
    );
  });

  it('detects an unreferenced contract after an interrupted write', async () => {
    const store = await mkdtemp(join(tmpdir(), 'zerochart-store-'));
    await mkdir(join(store, 'contracts'));
    await writeFile(
      join(store, 'contracts', 'orphan.json'),
      JSON.stringify({ configurationId: 'orphan' }),
    );
    await expect(loadEvaluationRuns(store)).rejects.toBeInstanceOf(IncompleteEvaluationError);
  });
});
