import { mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CandleProviderDataError } from '@/lib/binance';
import { parseTradingViewDevScan, TRADINGVIEW_DEV_SCAN_FILE } from '@/lib/tradingViewDevScan';
import { sessionOpen, US_EQUITY_INSTRUMENTS } from '@/lib/usEquityDaily';
import { bars, EQUITY_NOW, falling, rising, wave } from '@/test/usEquityFixtures';
import { reproduceScan, ScanSnapshotConflictError } from './marketScanStore';
import {
  importInputs,
  importTradingViewScan,
  parseExport,
  publishTradingViewDevScan,
  selectDevScanUniverse,
  TRADINGVIEW_SYMBOLS,
  tradingViewSeries,
  type TradingViewOhlcvExport,
} from './tradingViewImport';

/**
 * Labeled fixtures, not market data: sessions from the NYSE calendar, prices
 * from synthetic paths, shaped like a `get_ohlcv` 1D response. Nothing here
 * was fetched from TradingView.
 */
const NOTICE =
  'Market data notice: the last bar is still forming and may change; regular session only; prices are split-adjusted only.';
const COMMIT = 'c'.repeat(40);
const PATHS = [wave, rising, falling];

function response(symbol: string, path = wave) {
  return {
    success: true,
    symbol,
    interval: '1D',
    notice: NOTICE,
    bars: bars(path).map((bar) => ({
      t: sessionOpen(bar.session) / 1000,
      o: bar.open,
      h: bar.high,
      l: bar.low,
      c: bar.close,
      v: bar.volume,
    })),
  };
}

function exportOf(
  edit: (entries: TradingViewOhlcvExport['instruments']) => void = () => {},
): TradingViewOhlcvExport {
  const instruments = selectDevScanUniverse().map((ticker, i) => ({
    ticker,
    symbol: TRADINGVIEW_SYMBOLS[ticker]!,
    receivedAt: new Date(EQUITY_NOW - 60_000).toISOString(),
    response: response(TRADINGVIEW_SYMBOLS[ticker]!, PATHS[i % PATHS.length]),
  }));
  edit(instruments);
  return {
    schemaVersion: '1',
    source: 'tradingview-mcp',
    retrieval: {
      startedAt: new Date(EQUITY_NOW - 120_000).toISOString(),
      completedAt: new Date(EQUITY_NOW).toISOString(),
    },
    pineAlerts: { checkedAt: new Date(EQUITY_NOW).toISOString(), symbols: ['BINANCE:BTCUSDT'] },
    instruments,
  };
}

async function importInto(
  file: TradingViewOhlcvExport,
  options: { store?: string; now?: number; name?: string } = {},
) {
  const store = options.store ?? (await mkdtemp(join(tmpdir(), 'zerochart-tv-')));
  const path = join(store, options.name ?? 'export.json');
  await writeFile(path, JSON.stringify(file));
  const result = await importTradingViewScan({
    file: path,
    store,
    repositoryCommit: COMMIT,
    now: () => options.now ?? EQUITY_NOW + 5 * 60_000,
  });
  return { store, ...result };
}

async function temporaryArtifacts(store: string): Promise<string[]> {
  return (await readdir(store)).filter((name) => name.includes('.tmp-'));
}

describe('TradingView development universe', () => {
  it('picks 50 configured tickers by digest alone, whatever order they arrive in', () => {
    const picked = selectDevScanUniverse();
    expect(picked).toHaveLength(50);
    expect(picked.every((ticker) => Object.hasOwn(US_EQUITY_INSTRUMENTS, ticker))).toBe(true);
    expect(selectDevScanUniverse([...Object.keys(US_EQUITY_INSTRUMENTS)].reverse())).toEqual(
      picked,
    );
    expect(selectDevScanUniverse(['AAPL', 'BTC-USD', 'EURUSD=X'])).toEqual(['AAPL']);
  });

  it('names one exchange-qualified primary listing for exactly the selected tickers', () => {
    expect(Object.keys(TRADINGVIEW_SYMBOLS).sort()).toEqual(selectDevScanUniverse());
    for (const [ticker, symbol] of Object.entries(TRADINGVIEW_SYMBOLS)) {
      expect(symbol).toMatch(new RegExp(`^(NASDAQ|NYSE|AMEX|CBOE):${ticker}$`));
    }
  });
});

describe('tradingViewSeries', () => {
  const from = '2026-01-13';

  it('keys bars by their 09:30 New York session, across the DST change', () => {
    const series = tradingViewSeries(response('NYSE:BAC'), { symbol: 'NYSE:BAC', from });
    expect(series.adjustment).toBe('SPLIT');
    expect(series.bars.at(-1)?.session).toBe('2026-10-27');
    const march = series.bars.find((bar) => bar.session === '2026-03-06');
    expect(march).toBeDefined();
    expect(series.bars.every((bar) => bar.session >= from)).toBe(true);
  });

  it('rejects a bar stamped anything but the session open, rather than re-dating it', () => {
    const body = response('NYSE:BAC');
    body.bars[150]!.t = Date.UTC(2026, 7, 20) / 1000;
    expect(() => tradingViewSeries(body, { symbol: 'NYSE:BAC', from })).toThrow(
      /not the 09:30 America\/New_York open of 2026-08-19/,
    );
  });

  it('refuses another instrument, interval, an unstated adjustment or a non-numeric bar', () => {
    const check = (edit: (body: ReturnType<typeof response>) => void) => {
      const body = response('NYSE:BAC');
      edit(body);
      return () => tradingViewSeries(body, { symbol: 'NYSE:BAC', from });
    };
    expect(check((body) => (body.symbol = 'BOATS:BAC'))).toThrow(CandleProviderDataError);
    expect(check((body) => (body.interval = '1W'))).toThrow(/not 1D/);
    expect(check((body) => (body.notice = 'regular session only'))).toThrow(
      /adjustment basis is unresolved/,
    );
    expect(check((body) => ((body.bars[3] as { c: unknown }).c = null))).toThrow(/non-numeric/);
    expect(check((body) => (body.success = false))).toThrow(/did not succeed/);
  });
});

describe('importTradingViewScan', () => {
  it('scores every selected ticker with the canonical engine and reproduces offline', async () => {
    const { store, snapshot, view, status, snapshotStatus, viewStatus } =
      await importInto(exportOf());
    expect({ status, snapshotStatus, viewStatus }).toEqual({
      status: 'IMPORTED',
      snapshotStatus: 'CREATED',
      viewStatus: 'UPDATED',
    });
    expect(snapshot.scan.status).toBe('COMPLETE');
    expect(snapshot.scan.coverage).toMatchObject({ configured: 50, evaluated: 50 });
    expect(snapshot.scan.cohorts[0]).toMatchObject({
      assetClass: 'equity',
      provider: 'tradingview-mcp-get_ohlcv',
      candlePolicyVersion: 'us-equity-daily-v1',
      minClosedCandles: 199,
    });
    const first = snapshot.scan.results[0]!;
    expect(first).toMatchObject({ rank: 1, closedCandles: 199, cached: false });
    expect(first.fetchedAt).toBe(EQUITY_NOW - 60_000);
    expect(snapshot.startedAt).toBe(new Date(EQUITY_NOW).toISOString());
    expect(await reproduceScan(snapshot.scanId, store)).toEqual({
      status: 'MATCH',
      scanId: snapshot.scanId,
    });
    const written = parseTradingViewDevScan(
      JSON.parse(await readFile(join(store, TRADINGVIEW_DEV_SCAN_FILE), 'utf8')),
    );
    expect(written).toEqual(view);
    expect(view.source).toMatchObject({ notice: NOTICE, symbols: TRADINGVIEW_SYMBOLS });
  });

  it('reuses an equivalent snapshot despite a later import completion and republishes the view', async () => {
    const file = exportOf();
    const first = await importInto(file);
    const snapshotPath = join(first.store, `${first.snapshot.scanId}.json`);
    const snapshotBytes = await readFile(snapshotPath, 'utf8');

    const repeated = await importInto(file, {
      store: first.store,
      now: EQUITY_NOW + 30 * 60_000,
    });

    expect(repeated).toMatchObject({
      status: 'ALREADY_IMPORTED',
      snapshotStatus: 'REUSED',
      viewStatus: 'UPDATED',
    });
    expect(repeated.snapshot).toEqual(first.snapshot);
    expect(repeated.snapshot.completedAt).toBe(first.snapshot.completedAt);
    expect(await readFile(snapshotPath, 'utf8')).toBe(snapshotBytes);
    expect(
      parseTradingViewDevScan(
        JSON.parse(await readFile(join(first.store, TRADINGVIEW_DEV_SCAN_FILE), 'utf8')),
      ),
    ).toEqual(repeated.view);
    expect(await reproduceScan(first.snapshot.scanId, first.store)).toEqual({
      status: 'MATCH',
      scanId: first.snapshot.scanId,
    });
  });

  it('rejects changed inputs for the same target without changing the snapshot or view', async () => {
    const original = exportOf();
    const first = await importInto(original);
    const snapshotPath = join(first.store, `${first.snapshot.scanId}.json`);
    const viewPath = join(first.store, TRADINGVIEW_DEV_SCAN_FILE);
    const snapshotBytes = await readFile(snapshotPath, 'utf8');
    const viewBytes = await readFile(viewPath, 'utf8');
    const changed = exportOf((entries) => {
      const body = entries[0]!.response as ReturnType<typeof response>;
      body.bars[150]!.c *= 1.001;
    });

    const error = await importInto(changed, {
      store: first.store,
      name: 'changed-export.json',
    }).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(ScanSnapshotConflictError);
    expect(error).toMatchObject({
      code: 'SCAN_SNAPSHOT_CONFLICT',
      scanId: first.snapshot.scanId,
      differences: expect.arrayContaining(['INPUTS']),
    });
    expect(await readFile(snapshotPath, 'utf8')).toBe(snapshotBytes);
    expect(await readFile(viewPath, 'utf8')).toBe(viewBytes);
  });

  it.each([
    {
      label: 'calculated outputs',
      difference: 'OUTPUTS',
      edit: (stored: unknown) => {
        const snapshot = stored as { scan: { results: Array<{ rank: number | null }> } };
        snapshot.scan.results[0]!.rank = 999;
      },
    },
    {
      label: 'model attribution',
      difference: 'ATTRIBUTION',
      edit: (stored: unknown) => {
        const snapshot = stored as { scan: { modelVersion: string } };
        snapshot.scan.modelVersion = 'unexpected-model-version';
      },
    },
  ])(
    'validates existing $label before reuse and overwrites nothing',
    async ({ difference, edit }) => {
      const file = exportOf();
      const first = await importInto(file);
      const snapshotPath = join(first.store, `${first.snapshot.scanId}.json`);
      const viewPath = join(first.store, TRADINGVIEW_DEV_SCAN_FILE);
      const stored: unknown = JSON.parse(await readFile(snapshotPath, 'utf8'));
      edit(stored);
      await writeFile(snapshotPath, `${JSON.stringify(stored, null, 2)}\n`);
      const invalidSnapshotBytes = await readFile(snapshotPath, 'utf8');
      const viewBytes = await readFile(viewPath, 'utf8');

      const error = await importInto(file, { store: first.store }).then(
        () => null,
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(ScanSnapshotConflictError);
      expect(error).toMatchObject({
        code: 'SCAN_SNAPSHOT_CONFLICT',
        scanId: first.snapshot.scanId,
        differences: expect.arrayContaining([difference]),
      });
      expect(await readFile(snapshotPath, 'utf8')).toBe(invalidSnapshotBytes);
      expect(await readFile(viewPath, 'utf8')).toBe(viewBytes);
    },
  );

  it('recreates a missing development view from a verified saved snapshot', async () => {
    const file = exportOf();
    const first = await importInto(file);
    const viewPath = join(first.store, TRADINGVIEW_DEV_SCAN_FILE);
    await unlink(viewPath);

    const repeated = await importInto(file, { store: first.store });

    expect(repeated).toMatchObject({
      status: 'ALREADY_IMPORTED',
      snapshotStatus: 'REUSED',
      viewStatus: 'UPDATED',
    });
    expect(parseTradingViewDevScan(JSON.parse(await readFile(viewPath, 'utf8')))).toEqual(
      repeated.view,
    );
  });

  it('keeps the previous complete view when atomic publication is interrupted and recovers on retry', async () => {
    const file = exportOf();
    const first = await importInto(file);
    const viewPath = join(first.store, TRADINGVIEW_DEV_SCAN_FILE);
    const staleView = { ...first.view, importedAt: '2000-01-01T00:00:00.000Z' };
    await writeFile(viewPath, `${JSON.stringify(staleView, null, 2)}\n`);
    const staleBytes = await readFile(viewPath, 'utf8');

    await expect(
      publishTradingViewDevScan(first.view, first.store, {
        writeFile,
        rename: async () => {
          throw new Error('simulated interruption before atomic rename');
        },
        unlink,
      }),
    ).rejects.toThrow(/simulated interruption/);
    expect(await readFile(viewPath, 'utf8')).toBe(staleBytes);
    expect(await temporaryArtifacts(first.store)).toEqual([]);

    const recovered = await importInto(file, { store: first.store });
    expect(recovered).toMatchObject({
      status: 'ALREADY_IMPORTED',
      snapshotStatus: 'REUSED',
      viewStatus: 'UPDATED',
    });
    expect(await readFile(viewPath, 'utf8')).not.toBe(staleBytes);
    expect(parseTradingViewDevScan(JSON.parse(await readFile(viewPath, 'utf8')))).toEqual(
      recovered.view,
    );
  });

  it('keeps concurrent identical imports idempotent and leaves no partial files', async () => {
    const store = await mkdtemp(join(tmpdir(), 'zerochart-tv-'));
    const file = exportOf();

    const results = await Promise.all([
      importInto(file, { store, name: 'first-export.json' }),
      importInto(file, { store, name: 'second-export.json', now: EQUITY_NOW + 10 * 60_000 }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['ALREADY_IMPORTED', 'IMPORTED']);
    expect(results.map((result) => result.snapshotStatus).sort()).toEqual(['CREATED', 'REUSED']);
    expect(results.every((result) => result.viewStatus === 'UPDATED')).toBe(true);
    expect(results[0]!.snapshot).toEqual(results[1]!.snapshot);
    expect(await reproduceScan(results[0]!.snapshot.scanId, store)).toEqual({
      status: 'MATCH',
      scanId: results[0]!.snapshot.scanId,
    });
    expect(await temporaryArtifacts(store)).toEqual([]);
  });

  it('keeps one immutable winner when conflicting imports race', async () => {
    const store = await mkdtemp(join(tmpdir(), 'zerochart-tv-'));
    const original = exportOf();
    const changed = exportOf((entries) => {
      const body = entries[0]!.response as ReturnType<typeof response>;
      body.bars[150]!.c *= 1.001;
    });

    const results = await Promise.allSettled([
      importInto(original, { store, name: 'original-export.json' }),
      importInto(changed, { store, name: 'changed-export.json' }),
    ]);
    const successes = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof importInto>>> =>
        result.status === 'fulfilled',
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(successes[0]!.value).toMatchObject({ status: 'IMPORTED', snapshotStatus: 'CREATED' });
    expect(failures[0]!.reason).toBeInstanceOf(ScanSnapshotConflictError);
    expect(failures[0]!.reason).toMatchObject({
      code: 'SCAN_SNAPSHOT_CONFLICT',
      differences: expect.arrayContaining(['INPUTS']),
    });
    const winner = successes[0]!.value;
    expect(await reproduceScan(winner.snapshot.scanId, store)).toEqual({
      status: 'MATCH',
      scanId: winner.snapshot.scanId,
    });
    const view = parseTradingViewDevScan(
      JSON.parse(await readFile(join(store, TRADINGVIEW_DEV_SCAN_FILE), 'utf8')),
    );
    expect(view.scan).toEqual(winner.snapshot.scan);
    expect(await temporaryArtifacts(store)).toEqual([]);
  });

  it('keeps every failure, with its reason, instead of dropping the ticker', async () => {
    const [a, b, c, d, e] = selectDevScanUniverse();
    const { snapshot } = await importInto(
      exportOf((entries) => {
        entries[0] = { ticker: a!, symbol: TRADINGVIEW_SYMBOLS[a!]!, error: 'HTTP 429' };
        entries.splice(1, 1);
        entries[1]!.symbol = 'BOATS:X';
        (entries[2]!.response as { notice: string }).notice = 'delayed';
        (entries[3]!.response as { success: boolean }).success = false;
      }),
    );
    const byTicker = new Map(snapshot.scan.results.map((result) => [result.ticker, result]));
    expect(snapshot.scan.status).toBe('PARTIAL');
    expect(snapshot.scan.coverage).toMatchObject({ configured: 50, evaluated: 45 });
    expect(byTicker.get(a!)).toMatchObject({ status: 'FETCH_FAILED' });
    expect(byTicker.get(a!)?.detail).toMatch(/HTTP 429/);
    expect(byTicker.get(b!)?.detail).toMatch(/was never retrieved/);
    expect(byTicker.get(c!)).toMatchObject({ status: 'DATA_INVALID' });
    expect(byTicker.get(d!)?.detail).toMatch(/adjustment basis is unresolved/);
    expect(byTicker.get(e!)).toMatchObject({ status: 'FETCH_FAILED' });
    expect(byTicker.get(e!)?.detail).toMatch(/did not succeed/);
  });

  it('refuses a retrieval that a session close interrupted, and files it does not recognise', async () => {
    const straddle = exportOf();
    // 04:00 UTC on 28 Oct: 27 Oct turns final at 05:00 UTC, inside the window.
    straddle.retrieval.startedAt = new Date(EQUITY_NOW - 13 * 3_600_000).toISOString();
    await expect(importInto(straddle)).rejects.toThrow(/became final during retrieval/);

    const foreign = exportOf((entries) => entries.push({ ...entries[0]!, ticker: 'XOM' }));
    expect(() => parseExport(foreign)).toThrow(/XOM is not in the dev-scan universe/);
    const late = exportOf((entries) => (entries[0]!.receivedAt = '2027-01-01T00:00:00Z'));
    expect(() => parseExport(late)).toThrow(/inside the retrieval window/);
    expect(() => parseTradingViewDevScan({ kind: 'tradingview-dev-scan' })).toThrow();
  });

  it('rejects a malformed export at the boundary', () => {
    const file = exportOf();
    expect(() => parseExport({ schemaVersion: '2' })).toThrow(/schemaVersion 1/);
    expect(() =>
      parseExport({
        ...file,
        retrieval: { startedAt: file.retrieval.completedAt, completedAt: 'x' },
      }),
    ).toThrow(/not ordered ISO times/);
    expect(() => parseExport({ ...file, instruments: {} })).toThrow(/must be an array/);
    const unnamed = exportOf((entries) => Object.assign(entries[0]!, { symbol: 7 }));
    expect(() => parseExport(unnamed)).toThrow(/needs ticker and symbol/);
    expect(() => parseExport(exportOf((entries) => entries.push({ ...entries[0]! })))).toThrow(
      /appears twice/,
    );
    expect(() =>
      parseExport({
        ...file,
        pineAlerts: { checkedAt: 'not-a-time', symbols: ['BINANCE:BTCUSDT', 7] },
      }),
    ).toThrow(/pineAlerts/);
    const noBars = { ...response('NYSE:BAC'), bars: undefined };
    expect(() => tradingViewSeries(noBars, { symbol: 'NYSE:BAC', from: '2026-01-13' })).toThrow(
      /no bars array/,
    );
  });

  it('reports a scan outside the published calendar rather than guessing sessions', () => {
    const inputs = importInputs(exportOf(), Date.UTC(2029, 0, 10));
    expect(inputs).toHaveLength(50);
    expect(inputs.every((input) => input.error?.detail.startsWith('CALENDAR_OUT_OF_RANGE'))).toBe(
      true,
    );
  });

  it('records a retrieval in which every call failed as a failed scan, with no notice to quote', async () => {
    const { snapshot, view } = await importInto(
      exportOf((entries) =>
        entries.forEach((entry) => {
          delete entry.response;
          entry.error = 'HTTP 500';
        }),
      ),
    );
    expect(snapshot.scan.status).toBe('FAILED');
    expect(snapshot.scan.coverage.byStatus.FETCH_FAILED).toBe(50);
    expect(view.source.notice).toBe('No market-data notice was returned.');
  });
});
