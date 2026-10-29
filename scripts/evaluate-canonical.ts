import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CandleProviderDataError, fetchHistoricalCandles } from '@/lib/binance';
import {
  DAILY_TIMEFRAME,
  DEFAULT_MAX_DATA_AGE_MS,
  DEFAULT_TOTAL_CAPITAL,
  EVALUATION_STRATEGY_VERSION,
  evaluateInput,
  normalizeEvaluationInput,
  type EvaluationAssetInput,
  type EvaluationCandle,
  type EvaluationConfig,
  type EvaluationInput,
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
  hashEvaluationConfig,
  hashEvaluationInput,
  loadEvaluationRuns,
  reproduceEvaluationRun,
  saveEvaluationRun,
} from './evaluationStore';
import {
  campaignReport,
  initializeCampaign,
  reproduceCampaignRun,
  runDueCampaign,
} from './observationCampaign';
import {
  buildCampaignReportModel,
  buildSyntheticReportModel,
  writeDecisionsReport,
} from './decisionsReport';
import { collectCampaignOutcomes } from './outcomeMeasurement';
import { BINANCE_DAILY_CANDLE_POLICY_VERSION } from '@/lib/candleValidation';
import { SCAN_CANDLE_REQUEST, SCAN_TIMEFRAME } from '@/lib/marketScanner';
import {
  fetchAssetsStatusUniverse,
  reproduceScan,
  runScan,
  SCAN_STORE,
  ScanSnapshotConflictError,
  scanSummary,
} from './marketScanStore';
import { importTradingViewScan } from './tradingViewImport';

const STORE_DIR = '.zerochart-evaluations';
const USAGE = `Usage:
  npm run evaluate -- replay <fixture.json> [--store DIR]
  npm run evaluate -- observe TICKER[,TICKER...] [--store DIR] [--risk-profile PROFILE]
  npm run evaluate -- report [--store DIR]
  npm run evaluate -- reproduce LOGICAL_KEY [--store DIR]
  npm run evaluate -- campaign-init CAMPAIGN_ID --start ISO --end ISO [--store DIR]
  npm run evaluate -- campaign-run CAMPAIGN_ID [--store DIR]
  npm run evaluate -- campaign-report CAMPAIGN_ID [--store DIR]
  npm run evaluate -- campaign-reproduce CAMPAIGN_ID [--slot ISO] [--store DIR] [--block-network]
  npm run evaluate -- outcome-collect CAMPAIGN_ID [--store DIR]
  npm run evaluate -- decisions-report CAMPAIGN_ID [--store DIR] [--output FILE]
  npm run evaluate -- decisions-demo [--output FILE]
  npx tsx --env-file=.env scripts/evaluate-canonical.ts scan [--store DIR]
  npm run evaluate -- scan-reproduce SCAN_ID [--store DIR]
  npm run evaluate -- tradingview-import EXPORT.json [--store DIR]`;

type Fixture = {
  evaluationTime: string | number;
  assets: Array<{
    ticker: string;
    source?: string;
    timeframe?: '1d';
    candles: EvaluationCandle[];
  }>;
};

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function buildConfig(
  riskProfile: RiskProfile,
  universe: readonly string[],
  includeValidation: boolean,
): EvaluationConfig {
  const policy = RISK_PROFILE_POLICIES[riskProfile];
  const withoutId: Omit<EvaluationConfig, 'configurationId'> = {
    strategyVersion: EVALUATION_STRATEGY_VERSION,
    modelVersion: CANONICAL_MODEL_VERSION,
    universe,
    timeframe: DAILY_TIMEFRAME,
    riskProfile,
    totalCapital: DEFAULT_TOTAL_CAPITAL,
    maxDataAgeMs: DEFAULT_MAX_DATA_AGE_MS,
    ...(includeValidation
      ? {
          candleValidation: {
            policyVersion: BINANCE_DAILY_CANDLE_POLICY_VERSION,
            modelWindow: 200,
          },
        }
      : {}),
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

export function configFor(riskProfile: RiskProfile, universe: readonly string[]): EvaluationConfig {
  return buildConfig(riskProfile, universe, true);
}

/** Exact pre-policy contract, used only to identify and reproduce legacy evidence. */
export function legacyConfigFor(
  riskProfile: RiskProfile,
  universe: readonly string[],
): EvaluationConfig {
  return buildConfig(riskProfile, universe, false);
}

export function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function storePath(args: string[], defaultStore = STORE_DIR): string {
  return safeCliPath(option(args, '--store') ?? defaultStore, '--store');
}

export function safeCliPath(value: string, optionName: string): string {
  if (!value || value.includes('\0')) throw new Error(`Invalid ${optionName} path`);
  const candidate = resolve(value);
  const relativePath = relative(process.cwd(), candidate);
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new Error(`${optionName} must be inside the current workspace`);
  }
  return candidate;
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
  const fixture = JSON.parse(
    await readFile(safeCliPath(fixturePath, 'fixture'), 'utf8'),
  ) as Fixture;
  const input = toInput(fixture);
  const config = configFor(
    'moderate',
    input.assets.map((asset) => asset.ticker),
  );
  const normalizedInput = normalizeEvaluationInput(input);
  const inputHash = hashEvaluationInput(normalizedInput);
  const savedRun = evaluateInput(normalizedInput, config, inputHash);
  await saveEvaluationRun(savedRun, storePath(args));
  printJson(savedRun);
}

async function observe(tickers: string[], args: string[]): Promise<void> {
  const evaluationTime = Date.now();
  const assets = await fetchObservationAssets(tickers);
  const profile = (option(args, '--risk-profile') ?? 'moderate') as RiskProfile;
  const input = { evaluationTime, assets };
  const normalizedInput = normalizeEvaluationInput(input);
  const run = evaluateInput(
    normalizedInput,
    configFor(profile, tickers),
    hashEvaluationInput(normalizedInput),
  );
  await saveEvaluationRun(run, storePath(args));
  printJson(run);
}

export async function fetchObservationAssets(
  tickers: readonly string[],
  fetchCandles = fetchHistoricalCandles,
): Promise<EvaluationAssetInput[]> {
  return Promise.all(
    tickers.map(async (ticker) => {
      try {
        const candles = await fetchCandles(ticker, DAILY_TIMEFRAME, 200);
        return {
          ticker,
          source: 'binance-rest',
          timeframe: DAILY_TIMEFRAME,
          candles: candles.map((candle) => ({
            ...candle,
          })),
        };
      } catch (error) {
        if (error instanceof CandleProviderDataError) {
          return {
            ticker,
            source: 'binance-rest',
            timeframe: DAILY_TIMEFRAME,
            candles: [],
            validationIssues: [
              {
                code: 'MALFORMED_PROVIDER_ROW' as const,
                index: -1,
                timestamp: null,
                detail: error.message,
              },
            ],
          };
        }
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
  printJson({
    store: storePath(args),
    runCount: runs.length,
    missingRuns: 'not determinable: no production schedule is installed',
    groups: [...groups.entries()].map(([configuration, summary]) => ({
      configuration,
      ...summary,
    })),
    performanceMetrics: 'not reported: no complete executable exit contract',
  });
}

async function reproduce(logicalKey: string, args: string[]): Promise<void> {
  const result = await reproduceEvaluationRun(logicalKey, storePath(args));
  printJson(result);
  if (result.status === 'MISMATCH') process.exitCode = 1;
}

const execFileAsync = promisify(execFile);

async function repositoryCommit(): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD']);
  return stdout.trim();
}

async function worktreeDirty(): Promise<boolean> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain']);
  return stdout.trim() !== '';
}

function requiredValue(command: string, value?: string): string {
  if (!value) throw new Error(`${command} requires a value`);
  return value;
}

type CommandHandler = (value: string | undefined, args: string[]) => Promise<void>;

const commandHandlers: Record<string, CommandHandler> = {
  scan: async (value, args) => {
    const allArgs = [value, ...args].filter((item): item is string => Boolean(item));
    const { path, snapshot } = await runScan({
      universe: await fetchAssetsStatusUniverse(),
      universeSource: 'assets_status',
      // No equity provider: none is licensed for this use yet (docs/EQUITY_DATA.md).
      sources: {
        crypto: (ticker) => fetchHistoricalCandles(ticker, SCAN_TIMEFRAME, SCAN_CANDLE_REQUEST),
      },
      // A scan run from uncommitted code says so rather than claiming the commit.
      repositoryCommit: `${await repositoryCommit()}${(await worktreeDirty()) ? '-dirty' : ''}`,
      store: storePath(allArgs, SCAN_STORE),
    });
    printJson(scanSummary(path, snapshot));
    if (snapshot.scan.status !== 'COMPLETE') process.exitCode = 1;
  },
  'scan-reproduce': async (value, args) => {
    const result = await reproduceScan(
      requiredValue('scan-reproduce', value),
      storePath(args, SCAN_STORE),
    );
    printJson(result);
    if (result.status === 'MISMATCH') process.exitCode = 1;
  },
  // Development only: bars the owner's agent session fetched through TradingView's MCP server.
  'tradingview-import': async (value, args) => {
    try {
      const result = await importTradingViewScan({
        file: safeCliPath(requiredValue('tradingview-import', value), 'EXPORT'),
        store: storePath(args, SCAN_STORE),
        repositoryCommit: `${await repositoryCommit()}${(await worktreeDirty()) ? '-dirty' : ''}`,
      });
      printJson({
        ...scanSummary(result.path, result.snapshot),
        importStatus: result.status,
        snapshotStatus: result.snapshotStatus,
        viewStatus: result.viewStatus,
        viewPath: result.viewPath,
      });
      if (result.snapshot.scan.status !== 'COMPLETE') process.exitCode = 1;
    } catch (error) {
      if (!(error instanceof ScanSnapshotConflictError)) throw error;
      printJson({
        importStatus: 'CONFLICT',
        code: error.code,
        scanId: error.scanId,
        path: error.path,
        differences: error.differences,
      });
      process.exitCode = 1;
    }
  },
  replay: (value, args) => replay(requiredValue('replay', value), args),
  observe: (value, args) =>
    observe(requiredValue('observe', value).split(',').filter(Boolean), args),
  report: (value, args) => report([value, ...args].filter((item): item is string => Boolean(item))),
  reproduce: (value, args) => reproduce(requiredValue('reproduce', value), args),
  'campaign-init': async (value, args) => {
    const campaignId = requiredValue('campaign-init', value);
    const start = option(args, '--start');
    const end = option(args, '--end');
    if (!start || !end) throw new Error('campaign-init requires --start and --end');
    printJson(
      await initializeCampaign({
        campaignId,
        start,
        end,
        repositoryCommit: await repositoryCommit(),
        store: storePath(args, '.zerochart-campaigns'),
      }),
    );
  },
  'campaign-run': async (value, args) => {
    const result = await runDueCampaign(
      requiredValue('campaign-run', value),
      storePath(args, '.zerochart-campaigns'),
    );
    printJson(result);
    if (result.attempt.status === 'FAILED') process.exitCode = 1;
  },
  'campaign-report': async (value, args) => {
    printJson(
      await campaignReport(
        requiredValue('campaign-report', value),
        storePath(args, '.zerochart-campaigns'),
      ),
    );
  },
  'campaign-reproduce': async (value, args) => {
    const result = await reproduceCampaignRun(
      requiredValue('campaign-reproduce', value),
      storePath(args, '.zerochart-campaigns'),
      option(args, '--slot'),
      args.includes('--block-network'),
    );
    printJson(result);
    if (result.status === 'MISMATCH') process.exitCode = 1;
  },
  'outcome-collect': async (value, args) => {
    const result = await collectCampaignOutcomes(
      requiredValue('outcome-collect', value),
      storePath(args, '.zerochart-campaigns'),
      { maturedOnly: args.includes('--matured-only') },
    );
    printJson(result);
    if (result.results.some((item) => item.status === 'CONFLICT')) process.exitCode = 1;
  },
  'decisions-report': async (value, args) => {
    const campaignId = requiredValue('decisions-report', value);
    const output = safeCliPath(
      option(args, '--output') ?? `.zerochart-reports/${campaignId}.html`,
      '--output',
    );
    const model = await buildCampaignReportModel(
      campaignId,
      storePath(args, '.zerochart-campaigns'),
    );
    printJson({ output: await writeDecisionsReport(model, output), errors: model.errors });
    if (model.errors.length) process.exitCode = 1;
  },
  'decisions-demo': async (value, args) => {
    const allArgs = [value, ...args].filter((item): item is string => Boolean(item));
    const output = safeCliPath(
      option(allArgs, '--output') ?? '.zerochart-reports/synthetic-demo.html',
      '--output',
    );
    printJson({ output: await writeDecisionsReport(buildSyntheticReportModel(), output) });
  },
};

export async function main(argv = process.argv): Promise<void> {
  const [, , command, value, ...args] = argv;
  const handler = command ? commandHandlers[command] : undefined;
  if (!handler) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  await handler(value, args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
