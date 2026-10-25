import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fetchHistoricalCandles } from '@/lib/binance';
import {
  DAILY_TIMEFRAME,
  DEFAULT_MAX_DATA_AGE_MS,
  DEFAULT_TOTAL_CAPITAL,
  EVALUATION_STRATEGY_VERSION,
  evaluateInput,
  type EvaluationAssetInput,
  type EvaluationCandle,
  type EvaluationConfig,
  type EvaluationInput,
  type EvaluationRun,
} from '@/lib/evaluationLab';
import { CANONICAL_MODEL_VERSION } from '@/lib/canonicalModel';
import type { RiskProfile } from '@/lib/portfolioBuilder';

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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function configFor(riskProfile: RiskProfile, universe: readonly string[]): EvaluationConfig {
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
  };
  const configurationId = createHash('sha256').update(stableJson(withoutId)).digest('hex');
  return { ...withoutId, configurationId };
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function storePath(args: string[]): string {
  return resolve(option(args, '--store') ?? STORE_DIR);
}

async function saveRun(run: EvaluationRun, store: string): Promise<void> {
  const decisionsDir = join(store, 'decisions');
  const contractsDir = join(store, 'contracts');
  await mkdir(decisionsDir, { recursive: true });
  await mkdir(contractsDir, { recursive: true });
  await writeFile(
    join(contractsDir, `${run.configuration.configurationId}.json`),
    `${JSON.stringify(run.configuration, null, 2)}\n`,
    { flag: 'wx' },
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  for (const decision of run.decisions) {
    const path = join(decisionsDir, `${decision.logicalKey.replaceAll(':', '_')}.json`);
    await writeFile(path, `${JSON.stringify(decision, null, 2)}\n`, { flag: 'wx' }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      },
    );
  }
}

async function loadDecisions(store: string): Promise<unknown[]> {
  const directory = join(store, 'decisions');
  const names = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith('.json'));
  return Promise.all(
    names.map(async (name) => JSON.parse(await readFile(join(directory, name), 'utf8'))),
  );
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
  const run = evaluateInput(input, config);
  await saveRun(run, storePath(args));
  console.log(JSON.stringify(run, null, 2));
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
  const run = evaluateInput({ evaluationTime, assets }, configFor(profile, tickers));
  await saveRun(run, storePath(args));
  console.log(JSON.stringify(run, null, 2));
}

async function report(args: string[]): Promise<void> {
  const decisions = await loadDecisions(storePath(args));
  const eligible = decisions.filter(
    (decision) => (decision as { status?: string }).status === 'ELIGIBLE',
  );
  const rejected = decisions.length - eligible.length;
  const reasons = decisions.flatMap(
    (decision) =>
      (decision as { rejectionReasons?: Array<{ code: string }> }).rejectionReasons ?? [],
  );
  const rejectionBreakdown = Object.fromEntries(
    [...new Set(reasons.map((reason) => reason.code))]
      .sort()
      .map((code) => [code, reasons.filter((reason) => reason.code === code).length]),
  );
  console.log(
    JSON.stringify(
      {
        store: storePath(args),
        decisionCount: decisions.length,
        missingRuns: 'not determinable: no production schedule is installed',
        eligibleCount: eligible.length,
        rejectedCount: rejected,
        rejectionBreakdown,
        performanceMetrics: 'not reported: no complete executable exit contract',
      },
      null,
      2,
    ),
  );
}

async function reproduce(logicalKey: string, args: string[]): Promise<void> {
  const decisions = await loadDecisions(storePath(args));
  const decision = decisions.find(
    (candidate) => (candidate as { logicalKey?: string }).logicalKey === logicalKey,
  );
  if (!decision) throw new Error(`No decision found for ${logicalKey}`);
  console.log(JSON.stringify(decision, null, 2));
}

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
