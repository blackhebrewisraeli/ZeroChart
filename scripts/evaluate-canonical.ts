import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fetchHistoricalCandles } from '@/lib/binance';
import {
  DAILY_TIMEFRAME,
  DEFAULT_MAX_DATA_AGE_MS,
  DEFAULT_TOTAL_CAPITAL,
  EVALUATION_STRATEGY_VERSION,
  evaluateInput,
  assertSupportedEvaluationVersion,
  normalizeEvaluationInput,
  type EvaluationAssetInput,
  type EvaluationCandle,
  type EvaluationConfig,
  type EvaluationInput,
  type EvaluationRun,
} from '@/lib/evaluationLab';
import {
  ATR_PERIOD,
  CANONICAL_MODEL_VERSION,
  MACD_FAST,
  MACD_SIGNAL,
  MACD_SLOW,
  MIN_CANDLES,
  RSI_PERIOD,
} from '@/lib/canonicalModel';
import {
  RISK_PROFILE_POLICIES,
  ASSET_COUNT_BY_RISK,
  type RiskProfile,
} from '@/lib/portfolioBuilder';
import {
  comparableOutputs,
  assertConfigurationIntegrity,
  hashEvaluationConfig,
  hashEvaluationInput,
  loadEvaluationRun,
  loadEvaluationRuns,
  saveEvaluationRun,
  stableSerialize,
} from './evaluationStore';

const STORE_DIR = '.zerochart-evaluations';
const USAGE = `Usage:
  npm run evaluate -- replay <fixture.json> [--store DIR]
  npm run evaluate -- observe TICKER[,TICKER...] [--store DIR] [--risk-profile PROFILE]
  npm run evaluate -- report [--store DIR]
  npm run evaluate -- reproduce LOGICAL_KEY [--store DIR]`;

type Fixture = {
  evaluationTime: string | number;
  assets: Array<{
    ticker: string;
    source?: string;
    timeframe?: '1d';
    candles: EvaluationCandle[];
  }>;
};

function configFor(riskProfile: RiskProfile, universe: readonly string[]): EvaluationConfig {
  const policy = RISK_PROFILE_POLICIES[riskProfile];
  const withoutId: Omit<EvaluationConfig, 'configurationId'> = {
    strategyVersion: EVALUATION_STRATEGY_VERSION,
    modelVersion: CANONICAL_MODEL_VERSION,
    universe,
    timeframe: DAILY_TIMEFRAME,
    riskProfile,
    totalCapital: DEFAULT_TOTAL_CAPITAL,
    maxDataAgeMs: DEFAULT_MAX_DATA_AGE_MS,
    executionTiming: 'next_observation_after_closed_candle' as const,
    costs: { feeBps: 25, slippageBps: 0 },
    exitBehavior: 'none_in_evaluation_lab' as const,
    benchmark: 'not_applicable_without_executable_exits' as const,
    assumptions: [
      'Only closed daily candles are eligible.',
      'The score and allocation are proposals, not executed trades.',
      'Paper Trading planned ATR stops are not modeled as automated exits.',
    ],
    limitations: [
      'No performance metrics are reported because the current executable exit contract is incomplete.',
      'The historical universe is provider- and availability-dependent; survivorship bias is not removed.',
    ],
    modelParameters: {
      rsiPeriod: RSI_PERIOD,
      macdFast: MACD_FAST,
      macdSlow: MACD_SLOW,
      macdSignal: MACD_SIGNAL,
      atrPeriod: ATR_PERIOD,
      minimumCandles: MIN_CANDLES,
    },
    eligibility: {
      minimumScore: policy.minimumScore,
      excludeHighVolatility: policy.excludeHighVolatility,
      requirePositiveMomentum: policy.requirePositiveMomentum,
    },
    allocation: {
      maxAllocation: policy.maxAllocation,
      maxHoldings: ASSET_COUNT_BY_RISK[riskProfile],
      method: 'score_proportional',
    },
  };
  const configurationId = hashEvaluationConfig({ ...withoutId, configurationId: '' });
  return { ...withoutId, configurationId };
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function storePath(args: string[]): string {
  return resolve(option(args, '--store') ?? STORE_DIR);
}

function toInput(fixture: Fixture): EvaluationInput {
  return {
    evaluationTime: new Date(fixture.evaluationTime).getTime(),
    assets: fixture.assets.map((asset) => ({
      ticker: asset.ticker,
      source: asset.source ?? 'fixture',
      timeframe: asset.timeframe ?? DAILY_TIMEFRAME,
      candles: asset.candles,
    })),
  };
}

async function replay(fixturePath: string, args: string[]): Promise<void> {
  const fixture = JSON.parse(await readFile(resolve(fixturePath), 'utf8')) as Fixture;
  const input = toInput(fixture);
  const config = configFor(
    'moderate',
    input.assets.map((asset) => asset.ticker),
  );
  const normalizedInput = normalizeEvaluationInput(input);
  const inputHash = hashEvaluationInput(normalizedInput);
  const savedRun = evaluateInput(normalizedInput, config, inputHash);
  await saveEvaluationRun(savedRun, storePath(args));
  console.log(JSON.stringify(savedRun, null, 2));
}

async function observe(tickers: string[], args: string[]): Promise<void> {
  const evaluationTime = Date.now();
  const assets: EvaluationAssetInput[] = await Promise.all(
    tickers.map(async (ticker) => {
      try {
        const candles = await fetchHistoricalCandles(ticker, DAILY_TIMEFRAME, 200);
        return {
          ticker,
          source: 'binance-rest',
          timeframe: DAILY_TIMEFRAME,
          candles: candles.map((candle) => ({
            ...candle,
            closeTime: candle.timestamp + 24 * 60 * 60 * 1000,
          })),
        };
      } catch (error) {
        return {
          ticker,
          source: 'binance-rest',
          timeframe: DAILY_TIMEFRAME,
          candles: [],
          error: error instanceof Error ? error.message : 'Unknown market-data error',
        };
      }
    }),
  );
  const profile = (option(args, '--risk-profile') ?? 'moderate') as RiskProfile;
  const input = { evaluationTime, assets };
  const normalizedInput = normalizeEvaluationInput(input);
  const run = evaluateInput(
    normalizedInput,
    configFor(profile, tickers),
    hashEvaluationInput(normalizedInput),
  );
  await saveEvaluationRun(run, storePath(args));
  console.log(JSON.stringify(run, null, 2));
}

async function report(args: string[]): Promise<void> {
  const runs = await loadEvaluationRuns(storePath(args));
  const groups = new Map<
    string,
    {
      runs: number;
      assets: number;
      selected: number;
      eligible: number;
      rejected: number;
      rejectionReasons: Record<string, number>;
    }
  >();
  for (const { run } of runs) {
    const key = [
      run.configuration.strategyVersion,
      run.configuration.modelVersion,
      run.configuration.configurationId,
      `${run.observationPeriod.start ?? 'none'}-${run.observationPeriod.end ?? 'none'}`,
    ].join('/');
    const current = groups.get(key) ?? {
      runs: 0,
      assets: 0,
      selected: 0,
      eligible: 0,
      rejected: 0,
      rejectionReasons: {},
    };
    current.runs += 1;
    current.assets += run.coverage.assets;
    current.selected += run.coverage.selected;
    current.eligible += run.coverage.eligible;
    current.rejected += run.coverage.rejected;
    for (const [reason, count] of Object.entries(run.coverage.rejectionReasons)) {
      current.rejectionReasons[reason] = (current.rejectionReasons[reason] ?? 0) + count;
    }
    groups.set(key, current);
  }
  console.log(
    JSON.stringify(
      {
        store: storePath(args),
        runCount: runs.length,
        missingRuns: 'not determinable: no production schedule is installed',
        groups: [...groups.entries()].map(([configuration, summary]) => ({
          configuration,
          ...summary,
        })),
        performanceMetrics: 'not reported: no complete executable exit contract',
      },
      null,
      2,
    ),
  );
}

async function reproduce(logicalKey: string, args: string[]): Promise<void> {
  const stored = await loadEvaluationRun(logicalKey, storePath(args));
  assertSupportedEvaluationVersion(stored.contract);
  assertConfigurationIntegrity(stored.contract);
  const actualHash = hashEvaluationInput(stored.run.input);
  if (actualHash !== stored.run.inputHash) {
    console.log(
      JSON.stringify(
        {
          status: 'MISMATCH',
          reason: 'INPUT_HASH_MISMATCH',
          expected: stored.run.inputHash,
          actual: actualHash,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }
  const recalculated = evaluateInput(stored.run.input, stored.contract, stored.run.inputHash);
  const expected = stableSerialize(comparableOutputs(stored.run));
  const actual = stableSerialize(comparableOutputs(recalculated));
  const status = expected === actual ? 'MATCH' : 'MISMATCH';
  console.log(JSON.stringify({ status, runKey: logicalKey, expected, actual }, null, 2));
  if (status === 'MISMATCH') process.exitCode = 1;
}

async function main(): Promise<void> {
  const [, , command, value, ...args] = process.argv;
  if (command === 'replay' && value) await replay(value, args);
  else if (command === 'observe' && value) await observe(value.split(',').filter(Boolean), args);
  else if (command === 'report')
    await report([value, ...args].filter((item): item is string => Boolean(item)));
  else if (command === 'reproduce' && value) await reproduce(value, args);
  else {
    console.error(USAGE);
    process.exitCode = 1;
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
