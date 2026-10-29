// @vitest-environment node

import { mkdtemp, mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertConfigurationIntegrity,
  EvaluationConflictError,
  IncompleteEvaluationError,
  hashEvaluationConfig,
  hashEvaluationInput,
  loadEvaluationRun,
  loadEvaluationRuns,
  reproduceEvaluationRun,
  saveEvaluationRun,
} from './evaluationStore';
import {
  DAILY_TIMEFRAME,
  EVALUATION_STRATEGY_VERSION,
  assertSupportedEvaluationVersion,
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
  const withoutId: Omit<EvaluationConfig, 'configurationId'> = {
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
  };
  return {
    ...withoutId,
    configurationId: hashEvaluationConfig({ ...withoutId, configurationId: '' }),
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

  it('refuses to read a run through a symlink that leads out of the store', async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), 'zerochart-store-'));
    const saved = run();
    await saveEvaluationRun(saved, elsewhere);
    const [file] = await readdir(join(elsewhere, 'runs'));
    if (!file) throw new Error('Expected a saved run file');

    const store = await mkdtemp(join(tmpdir(), 'zerochart-store-'));
    await mkdir(join(store, 'runs'));
    await symlink(join(elsewhere, 'runs', file), join(store, 'runs', file));

    await expect(loadEvaluationRun(saved.runKey, store)).rejects.toThrow('Invalid storage path');
    await expect(reproduceEvaluationRun(saved.runKey, store)).rejects.toThrow(
      'Invalid storage path',
    );
  });

  it('reproduces unversioned schema-1 evidence under its original contract', async () => {
    const store = await mkdtemp(join(tmpdir(), 'zerochart-store-'));
    const legacy = run();
    expect(legacy.schemaVersion).toBe('1');
    await saveEvaluationRun(legacy, store);
    await expect(reproduceEvaluationRun(legacy.runKey, store)).resolves.toEqual({
      status: 'MATCH',
      runKey: legacy.runKey,
    });
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

  it('allows identical simultaneous saves and leaves one complete run', async () => {
    const store = await mkdtemp(join(tmpdir(), 'zerochart-store-'));
    const saved = run();
    await Promise.all([saveEvaluationRun(saved, store), saveEvaluationRun(saved, store)]);
    const loaded = await loadEvaluationRun(saved.runKey, store);
    expect(loaded.run).toEqual(saved);
    await expect(readdir(join(store, 'runs'))).resolves.toEqual([
      `${encodeURIComponent(saved.runKey)}.json`,
    ]);
    await expect(
      readdir(join(store, 'runs')).then((names) => names.filter((name) => name.includes('.tmp-'))),
    ).resolves.toEqual([]);
    await expect(
      readdir(join(store, 'contracts')).then((names) =>
        names.filter((name) => name.includes('.tmp-')),
      ),
    ).resolves.toEqual([]);
  });

  it('rejects the conflicting writer during simultaneous saves', async () => {
    const store = await mkdtemp(join(tmpdir(), 'zerochart-store-'));
    const saved = run();
    const conflicting = structuredClone(saved);
    conflicting.inputHash = 'different';
    const results = await Promise.allSettled([
      saveEvaluationRun(saved, store),
      saveEvaluationRun(conflicting, store),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')?.reason).toBeInstanceOf(
      EvaluationConflictError,
    );
    const loaded = await loadEvaluationRun(saved.runKey, store);
    expect([saved.inputHash, conflicting.inputHash]).toContain(loaded.run.inputHash);
  });

  it('rejects tampered configuration parameters and hashes', async () => {
    const saved = run();
    const incompatible = structuredClone(saved);
    incompatible.configuration.modelParameters.rsiPeriod = 7;
    expect(() => assertSupportedEvaluationVersion(incompatible.configuration)).toThrow(
      'Incompatible model parameters',
    );
    const invalidHash = {
      ...saved.configuration,
      configurationId: 'wrong',
    };
    expect(() => assertConfigurationIntegrity(invalidHash)).toThrow(
      'Evaluation configuration hash mismatch',
    );
    expect(hashEvaluationConfig(saved.configuration)).toBe(saved.configuration.configurationId);
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
