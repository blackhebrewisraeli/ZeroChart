// @vitest-environment node

import { copyFile, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { CandleProviderDataError, type Candle } from '@/lib/binance';
import { evaluateScan } from '@/lib/marketScanner';

const mocks = vi.hoisted(() => ({
  candles: vi.fn(),
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
}));

// Network edges are stubbed; the evaluation store and the scanner run for real.
vi.mock('@/lib/binance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/binance')>()),
  fetchHistoricalCandles: mocks.candles,
}));
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
