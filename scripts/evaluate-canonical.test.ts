// @vitest-environment node

import { copyFile, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { CandleProviderDataError, type Candle } from '@/lib/binance';
import { evaluateScan } from '@/lib/marketScanner';

const mocks = vi.hoisted(() => ({
  candles: vi.fn(),
  symbolCandles: vi.fn(),
  /** `git status --porcelain` output; null runs the real command. */
  gitStatus: { value: null as string | null },
  universe: vi.fn(),
  initializeCampaign: vi.fn(),
  runDueCampaign: vi.fn(),
  campaignReport: vi.fn(),
  reproduceCampaignRun: vi.fn(),
  collectCampaignOutcomes: vi.fn(),
  buildCampaignReportModel: vi.fn(),
  buildSyntheticReportModel: vi.fn(),
  writeDecisionsReport: vi.fn(),
  importTradingViewScan: vi.fn(),
  runScannerResearch: vi.fn(),
  runScannerResearchV2: vi.fn(),
}));

// Network edges are stubbed; the evaluation store and the scanner run for real.
vi.mock('@/lib/binance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/binance')>()),
  fetchHistoricalCandles: mocks.candles,
  fetchSymbolCandles: mocks.symbolCandles,
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (
      file: string,
      args: readonly string[],
      callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      if (file === 'git' && args[0] === 'status' && mocks.gitStatus.value !== null) {
        callback(null, { stdout: mocks.gitStatus.value, stderr: '' });
        return;
      }
      actual.execFile(file, args, (error, stdout, stderr) =>
        callback(error, { stdout: String(stdout), stderr: String(stderr) }),
      );
    },
  };
});
vi.mock('./marketScanStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./marketScanStore')>()),
  fetchAssetsStatusUniverse: mocks.universe,
}));
// Campaign, outcome and report modules have their own suites; here only the CLI wiring matters.
vi.mock('./observationCampaign', () => ({
  initializeCampaign: mocks.initializeCampaign,
  runDueCampaign: mocks.runDueCampaign,
  campaignReport: mocks.campaignReport,
  reproduceCampaignRun: mocks.reproduceCampaignRun,
}));
vi.mock('./outcomeMeasurement', () => ({
  collectCampaignOutcomes: mocks.collectCampaignOutcomes,
}));
vi.mock('./decisionsReport', () => ({
  buildCampaignReportModel: mocks.buildCampaignReportModel,
  buildSyntheticReportModel: mocks.buildSyntheticReportModel,
  writeDecisionsReport: mocks.writeDecisionsReport,
}));
vi.mock('./tradingViewImport', () => ({ importTradingViewScan: mocks.importTradingViewScan }));
vi.mock('./scannerResearch', () => ({
  RESEARCH_OUTPUT_DIR: '.zerochart-reports',
  runScannerResearch: mocks.runScannerResearch,
  researchSummary: () => ({ specificationId: 'spec' }),
}));
vi.mock('./scannerResearchV2', () => ({
  runScannerResearchV2: mocks.runScannerResearchV2,
  researchSummaryV2: () => ({ specificationId: 'spec-v2' }),
}));

const { main } = await import('./evaluate-canonical');

const DAY = 86_400_000;
const TODAY = Date.UTC(2026, 9, 28);
const NOW = TODAY + 17 * 60 * 60_000;

/** Labeled fixture: 199 closed daily candles plus today's open one. */
function series(path: (i: number) => number): Candle[] {
  const first = TODAY - 199 * DAY;
  return Array.from({ length: 200 }, (_, i) => {
    const close = path(i);
    return {
      timestamp: first + i * DAY,
      closeTime: first + i * DAY + DAY - 1,
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
    };
  });
}

let workspace: string;
let stdout: MockInstance<typeof process.stdout.write>;
let stderr: MockInstance<typeof console.error>;

function cli(...args: string[]): Promise<void> {
  return main(['node', 'evaluate-canonical.ts', ...args]);
}

/** The JSON object printed by the most recent command. */
function printed<T = Record<string, unknown>>(): T {
  const output = stdout.mock.calls.at(-1)?.[0];
  return JSON.parse(String(output)) as T;
}

beforeEach(async () => {
  // Store paths must sit inside the working directory, so the test owns one.
  workspace = await mkdtemp(join(tmpdir(), 'zerochart-cli-'));
  vi.spyOn(process, 'cwd').mockReturnValue(workspace);
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  mocks.gitStatus.value = null;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
  process.exitCode = undefined;
});

describe('evaluate-canonical CLI', () => {
  it('prints usage and fails without a known command', async () => {
    await cli();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    await cli('unknown');
    expect(process.exitCode).toBe(1);
  });

  it.each([
    'replay',
    'observe',
    'reproduce',
    'scan-reproduce',
    'campaign-run',
    'outcome-collect',
    'tradingview-import',
    'scanner-research',
    'scanner-research-v2',
  ])('%s requires a value', async (command) => {
    await expect(cli(command)).rejects.toThrow(`${command} requires a value`);
  });

  it('imports a TradingView export into the scan store and fails unless every ticker scored', async () => {
    const scan = evaluateScan([], { evaluationTime: NOW, universeSource: 'tradingview-dev-scan' });
    mocks.importTradingViewScan.mockResolvedValue({
      path: 'scans/s.json',
      snapshot: {
        scanId: 's',
        startedAt: '',
        completedAt: '',
        universeVersion: 'u',
        repositoryCommit: 'c',
        scan,
      },
    });

    await cli('tradingview-import', 'exports/x.json', '--store', 'scans');
    expect(mocks.importTradingViewScan).toHaveBeenCalledWith({
      file: join(workspace, 'exports/x.json'),
      store: join(workspace, 'scans'),
      repositoryCommit: expect.stringMatching(/^[0-9a-f]{40}(-dirty)?$/),
    });
    expect(printed()).toMatchObject({ scanId: 's', status: 'FAILED' });
    expect(process.exitCode).toBe(1);
    await expect(cli('tradingview-import', '../outside.json')).rejects.toThrow(
      'EXPORT must be inside the current workspace',
    );
  });

  it('runs the frozen scanner study and fails when a rerun departs from its results', async () => {
    mocks.runScannerResearch.mockResolvedValue({
      status: 'CONFLICT',
      resultHash: 'h',
      resultsPath: 'reports/r.json',
      reportPath: 'reports/r.html',
      results: {},
    });

    await cli('scanner-research', 'exports/x.json', '--output-dir', 'reports');
    expect(mocks.runScannerResearch).toHaveBeenCalledWith({
      file: join(workspace, 'exports/x.json'),
      outputDir: join(workspace, 'reports'),
      repositoryCommit: expect.stringMatching(/^[0-9a-f]{40}(-dirty)?$/),
    });
    expect(printed()).toMatchObject({
      status: 'CONFLICT',
      reportPath: null,
      specificationId: 'spec',
    });
    expect(process.exitCode).toBe(1);
  });

  it('runs the frozen v2 study and prints its aggregate summary', async () => {
    mocks.runScannerResearchV2.mockResolvedValue({
      status: 'CREATED',
      resultHash: 'h',
      resultsPath: 'reports/r.json',
      reportPath: 'reports/r.html',
      results: {},
    });

    await cli('scanner-research-v2', 'exports/x.json');
    expect(mocks.runScannerResearchV2).toHaveBeenCalledWith(
      expect.objectContaining({
        file: join(workspace, 'exports/x.json'),
        outputDir: join(workspace, '.zerochart-reports'),
      }),
    );
    expect(printed()).toMatchObject({
      status: 'CREATED',
      reportPath: 'reports/r.html',
      specificationId: 'spec-v2',
    });
    expect(process.exitCode).toBeUndefined();
  });

  it('refuses a store outside the workspace', async () => {
    await expect(cli('report', '--store', '../elsewhere')).rejects.toThrow(
      '--store must be inside the current workspace',
    );
  });

  it('replays a fixture, reports it and reproduces it offline', async () => {
    await copyFile(
      new URL('../docs/strategy-validation-fixture.json', import.meta.url),
      join(workspace, 'fixture.json'),
    );

    await cli('replay', 'fixture.json', '--store', 'evals');
    const run = printed<{ runKey: string; configuration: { riskProfile: string } }>();
    expect(run.configuration.riskProfile).toBe('moderate');

    await cli('report', '--store', 'evals');
    expect(printed()).toMatchObject({ store: join(workspace, 'evals'), runCount: 1 });

    await cli('reproduce', run.runKey, '--store', 'evals');
    expect(printed()).toMatchObject({ status: 'MATCH', runKey: run.runKey });
    expect(process.exitCode).toBeUndefined();
  });

  it('observes tickers and records each provider failure on its asset', async () => {
    mocks.candles.mockImplementation(async (ticker: string) => {
      if (ticker === 'BTC-USD') return series((i) => 100 + i);
      if (ticker === 'ETH-USD') throw new CandleProviderDataError('row 3 is malformed');
      throw new Error('HTTP 503');
    });

    await cli(
      'observe',
      'BTC-USD,ETH-USD,SOL-USD',
      '--store',
      'evals',
      '--risk-profile',
      'aggressive',
    );

    const run = printed<{
      configuration: { riskProfile: string; universe: string[] };
      coverage: { assets: number };
    }>();
    expect(mocks.candles).toHaveBeenCalledWith('BTC-USD', '1d', 200);
    expect(run.configuration).toMatchObject({
      riskProfile: 'aggressive',
      universe: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
    });
    expect(run.coverage.assets).toBe(3);
    expect(await readdir(join(workspace, 'evals', 'runs'))).toHaveLength(1);
  });

  it('scans the universe, then reproduces the scan without the network', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    mocks.universe.mockResolvedValue(['AAPL', 'BTC-USD', 'ETH-USD']);
    mocks.candles.mockImplementation(async (ticker: string) =>
      ticker === 'BTC-USD' ? series((i) => 100 + Math.sin(i / 6) * 8) : series((i) => 50 + i * 0.4),
    );

    await cli('scan', '--store', 'scans');
    const summary = printed<{
      scanId: string;
      status: string;
      versions: { repositoryCommit: string };
    }>();
    expect(summary.status).toBe('COMPLETE');
    expect(summary.versions.repositoryCommit).toMatch(/^[0-9a-f]{40}(-dirty)?$/);
    expect(process.exitCode).toBeUndefined();

    mocks.candles.mockClear();
    await cli('scan-reproduce', summary.scanId, '--store', 'scans');
    expect(printed()).toMatchObject({ status: 'MATCH', scanId: summary.scanId });
    expect(mocks.candles).not.toHaveBeenCalled();
  });

  it('fails a scan that could not evaluate every supported asset', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    mocks.universe.mockResolvedValue(['BTC-USD', 'ETH-USD']);
    mocks.candles.mockImplementation(async (ticker: string) => {
      if (ticker === 'ETH-USD') throw new Error('HTTP 503');
      return series((i) => 100 + i);
    });

    await cli('scan', '--store', 'scans');
    expect(printed()).toMatchObject({ status: 'PARTIAL' });
    expect(process.exitCode).toBe(1);
  });

  it('initializes a campaign at the current commit in the default store', async () => {
    mocks.initializeCampaign.mockResolvedValue({ campaignId: 'c-1' });

    await expect(cli('campaign-init', 'c-1', '--start', '2026-11-01')).rejects.toThrow(
      'campaign-init requires --start and --end',
    );
    await cli('campaign-init', 'c-1', '--start', '2026-11-01', '--end', '2026-11-30');

    expect(mocks.initializeCampaign).toHaveBeenCalledWith({
      campaignId: 'c-1',
      start: '2026-11-01',
      end: '2026-11-30',
      repositoryCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
      store: join(workspace, '.zerochart-campaigns'),
    });
    expect(printed()).toEqual({ campaignId: 'c-1' });
  });

  it('fails a campaign run whose observation failed', async () => {
    mocks.runDueCampaign.mockResolvedValue({
      alreadyCompleted: false,
      attempt: { status: 'FAILED' },
    });
    await cli('campaign-run', 'c-1', '--store', 'campaigns');
    expect(mocks.runDueCampaign).toHaveBeenCalledWith('c-1', join(workspace, 'campaigns'));
    expect(process.exitCode).toBe(1);
  });

  it('prints a campaign report', async () => {
    mocks.campaignReport.mockResolvedValue({ campaignId: 'c-1', runs: 3 });
    await cli('campaign-report', 'c-1');
    expect(mocks.campaignReport).toHaveBeenCalledWith(
      'c-1',
      join(workspace, '.zerochart-campaigns'),
    );
    expect(printed()).toEqual({ campaignId: 'c-1', runs: 3 });
  });

  it('passes the slot and network block to campaign reproduction and fails a mismatch', async () => {
    mocks.reproduceCampaignRun.mockResolvedValue({ status: 'MISMATCH' });
    await cli('campaign-reproduce', 'c-1', '--slot', '2026-11-02T00:00:00.000Z', '--block-network');
    expect(mocks.reproduceCampaignRun).toHaveBeenCalledWith(
      'c-1',
      join(workspace, '.zerochart-campaigns'),
      '2026-11-02T00:00:00.000Z',
      true,
    );
    expect(process.exitCode).toBe(1);
  });

  it('collects only matured outcomes when asked and fails on conflicts', async () => {
    mocks.collectCampaignOutcomes.mockResolvedValue({ results: [{ status: 'CONFLICT' }] });
    await cli('outcome-collect', 'c-1', '--matured-only');
    expect(mocks.collectCampaignOutcomes).toHaveBeenCalledWith(
      'c-1',
      join(workspace, '.zerochart-campaigns'),
      { maturedOnly: true },
    );
    expect(process.exitCode).toBe(1);
  });

  it('writes a decisions report to its default path and fails when evidence has errors', async () => {
    const model = { errors: ['missing observation'] };
    mocks.buildCampaignReportModel.mockResolvedValue(model);
    mocks.writeDecisionsReport.mockImplementation(async (_model: unknown, path: string) => path);

    await cli('decisions-report', 'c-1');

    const output = join(workspace, '.zerochart-reports', 'c-1.html');
    expect(mocks.writeDecisionsReport).toHaveBeenCalledWith(model, output);
    expect(printed()).toEqual({ output, errors: ['missing observation'] });
    expect(process.exitCode).toBe(1);
  });

  it('writes the synthetic demo report where asked', async () => {
    mocks.buildSyntheticReportModel.mockReturnValue({ errors: [] });
    mocks.writeDecisionsReport.mockImplementation(async (_model: unknown, path: string) => path);

    await cli('decisions-demo', '--output', 'out/demo.html');

    expect(printed()).toEqual({ output: join(workspace, 'out', 'demo.html') });
    expect(process.exitCode).toBeUndefined();
  });
});

describe('Opportunity Radar CLI', () => {
  const START = Date.UTC(2026, 9, 30, 0, 30);
  const END = START + 179 * DAY;
  const iso = (time: number) => new Date(time).toISOString();

  /** Synthetic Binance: 200 closed daily candles ending at the requested endTime. */
  function closedCandles(_symbol: string, request: { limit: number; endTime: number }): Candle[] {
    const lastOpen = request.endTime + 1 - DAY;
    return Array.from({ length: request.limit }, (_, i) => {
      const timestamp = lastOpen - (request.limit - 1 - i) * DAY;
      const close = 100 + i * 0.1;
      return {
        timestamp,
        closeTime: timestamp + DAY - 1,
        open: close,
        high: close + 0.5,
        low: close - 0.5,
        close,
      };
    });
  }

  it('rejects unknown options, unsafe paths, bad dates and a dirty worktree', async () => {
    await expect(cli('opportunity-campaign-run', 'c-1', '--verbose')).rejects.toThrow(
      'unknown or incomplete option --verbose',
    );
    await expect(cli('opportunity-campaign-status', 'c-1', '--store')).rejects.toThrow(
      'unknown or incomplete option --store',
    );
    await expect(cli('opportunity-campaign-run', 'c-1', '--store', '../outside')).rejects.toThrow(
      'inside the current workspace',
    );
    await expect(cli('opportunity-campaign-status', 'missing')).rejects.toThrow(
      'Campaign missing has no manifest in the evidence store.',
    );
    await expect(cli('opportunity-campaign-init', 'c-1', '--start', iso(START))).rejects.toThrow(
      'requires --start and --end',
    );
    await expect(
      cli('opportunity-campaign-init', 'c-1', '--start', 'soon', '--end', iso(END)),
    ).rejects.toThrow('--start must be an ISO timestamp');

    mocks.gitStatus.value = ' M scripts/opportunityCampaign.ts\n';
    await expect(
      cli('opportunity-campaign-init', 'c-1', '--start', iso(START), '--end', iso(END)),
    ).rejects.toThrow('requires a clean worktree');
    expect(await readdir(workspace)).toEqual([]);
  });

  it('runs every command against a synthetic campaign and prints no market evidence', async () => {
    mocks.gitStatus.value = '';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 29, 12));
    mocks.symbolCandles.mockImplementation(async (symbol, request) =>
      closedCandles(symbol, request),
    );
    const outputs: string[] = [];
    const run = async (...args: string[]) => {
      await cli(...args);
      outputs.push(String(stdout.mock.calls.at(-1)?.[0]));
      return printed();
    };

    expect(
      await run('opportunity-campaign-init', 'c-1', '--start', iso(START), '--end', iso(END)),
    ).toMatchObject({ campaignId: 'c-1', slotCount: 180, startSlot: iso(START) });

    vi.setSystemTime(START + 60_000);
    expect(await run('opportunity-campaign-run', 'c-1')).toEqual({
      status: 'COMPLETED',
      slot: iso(START),
      attemptNumber: 1,
      failures: {},
      scanStatus: 'COMPLETE',
      coverage: { configured: 12, evaluated: 12, notEvaluated: 0 },
      opportunities: 0,
    });
    expect(mocks.symbolCandles).toHaveBeenCalledTimes(12);
    expect(await run('opportunity-campaign-run', 'c-1')).toEqual({
      status: 'ALREADY_COMPLETED',
      slot: iso(START),
    });
    expect(mocks.symbolCandles).toHaveBeenCalledTimes(12);
    expect(
      await run('opportunity-campaign-reproduce', 'c-1', '--slot', iso(START), '--block-network'),
    ).toMatchObject({ slot: iso(START), networkBlocked: true, status: 'MATCH', reason: null });
    expect(process.exitCode).toBeUndefined();

    vi.setSystemTime(START + DAY + 60_000);
    mocks.symbolCandles.mockRejectedValue(
      new Error('Binance klines request failed with status 451'),
    );
    expect(await run('opportunity-campaign-run', 'c-1')).toEqual({
      status: 'FAILED',
      slot: iso(START + DAY),
      attemptNumber: 1,
      failures: { FETCH_FAILED: 12 },
    });
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    vi.setSystemTime(START + DAY + 6 * 60 * 60_000);
    expect(await run('opportunity-campaign-run', 'c-1')).toEqual({
      status: 'MISSED',
      slot: iso(START + DAY),
    });
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    expect(await run('opportunity-campaign-status', 'c-1')).toEqual({
      campaignId: 'c-1',
      specificationId: '0eddcc4f81ba47d74168392bb50af64050d3a9db2ab56da914c3814087d64483',
      implementationCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
      startSlot: iso(START),
      endSlot: iso(END),
      asOf: iso(START + DAY + 6 * 60 * 60_000),
      slots: { scheduled: 180, due: 2, completed: 1, pending: 0, missed: 1 },
      failedAttempts: 1,
      reproduction: { match: 1, mismatch: 0, notReproduced: 0 },
    });
    expect(process.exitCode).toBeUndefined();

    await expect(cli('opportunity-outcomes', 'c-1', '--all')).rejects.toThrow(
      'unknown or incomplete option --all',
    );
    // The synthetic slot emitted no Opportunity, so nothing matures or is fetched.
    mocks.symbolCandles.mockClear();
    expect(await run('opportunity-outcomes', 'c-1', '--matured-only')).toEqual({
      created: 0,
      unchanged: 0,
      recorded: 0,
      conflicts: 0,
      pending: 0,
      fetchFailed: 0,
    });
    expect(mocks.symbolCandles).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();

    // Every command prints statuses, hashes and counts: no paths, tickers or prices.
    expect(outputs).toHaveLength(8);
    for (const output of outputs) {
      expect(output).not.toMatch(/USD|close|candles|zerochart-campaigns|\//);
    }
  });
});
