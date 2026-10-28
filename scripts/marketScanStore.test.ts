import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Candle } from '@/lib/binance';
import { bars, EQUITY_NOW, fixtureProvider, split, wave } from '@/test/usEquityFixtures';
import {
  fetchAssetsStatusUniverse,
  loadScan,
  reproduceScan,
  runScan,
  scanSummary,
  type ScanSnapshot,
} from './marketScanStore';

const DAY = 86_400_000;
const TODAY = Date.UTC(2026, 9, 28);
const NOW = TODAY + 17 * 60 * 60_000;
const COMMIT = 'a'.repeat(40);

/** Labeled fixture: 199 closed Binance-convention daily candles plus today's open one. */
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

const CANDLES: Record<string, Candle[]> = {
  'BTC-USD': series((i) => 100 + Math.sin(i / 6) * 8),
  'ETH-USD': series((i) => 50 + i * 0.4),
  'SOL-USD': series((i) => 200 - i * 0.5),
};
const UNIVERSE = ['AAPL', 'BTC-USD', 'ETH-USD', 'EURUSD=X', 'SOL-USD', 'SPY', 'XRP-USD'];

async function scanInto(store: string) {
  return runScan({
    universe: UNIVERSE,
    universeSource: 'assets_status',
    sources: {
      crypto: async (ticker) => {
        const candles = CANDLES[ticker];
        if (!candles) throw new Error('HTTP 503');
        return candles;
      },
    },
    repositoryCommit: COMMIT,
    store,
    now: () => NOW,
  });
}

async function tamper(store: string, scanId: string, edit: (snapshot: ScanSnapshot) => void) {
  const path = join(store, `${scanId}.json`);
  const snapshot = JSON.parse(await readFile(path, 'utf8')) as ScanSnapshot;
  edit(snapshot);
  await writeFile(path, JSON.stringify(snapshot));
}

describe('market scan snapshots', () => {
  it('records a multi-asset scan that reproduces offline from its own inputs', async () => {
    const store = await mkdtemp(join(tmpdir(), 'zerochart-scan-'));
    const { path, snapshot } = await scanInto(store);
    expect(snapshot).toMatchObject({
      schemaVersion: '1',
      evidenceType: 'market-scan',
      repositoryCommit: COMMIT,
      startedAt: '2026-10-28T17:00:00.000Z',
    });
    expect(snapshot.scanId).toMatch(/^20261028T170000Z-[0-9a-f]{8}$/);
    expect(path).toBe(join(store, `${snapshot.scanId}.json`));
    expect(Object.keys(snapshot.inputHashes)).toEqual(UNIVERSE);
    expect(snapshot.scan.status).toBe('PARTIAL');
    expect(snapshot.scan.coverage).toMatchObject({
      configured: 7,
      supported: 4,
      evaluated: 3,
      unsupported: 3,
    });
    expect(await loadScan(snapshot.scanId, store)).toEqual(snapshot);
    expect(await reproduceScan(snapshot.scanId, store)).toEqual({
      status: 'MATCH',
      scanId: snapshot.scanId,
    });
  });

  it('never overwrites an existing snapshot', async () => {
    const store = await mkdtemp(join(tmpdir(), 'zerochart-scan-'));
    await scanInto(store);
    await expect(scanInto(store)).rejects.toThrow(/EEXIST/);
  });

  it('detects a changed input, universe or output', async () => {
    const store = await mkdtemp(join(tmpdir(), 'zerochart-scan-'));
    const { snapshot } = await scanInto(store);
    const id = snapshot.scanId;

    await tamper(store, id, (s) => {
      const candles = s.inputs.find((input) => input.ticker === 'BTC-USD')?.candles as Candle[];
      candles[150]!.close *= 1.001;
    });
    expect(await reproduceScan(id, store)).toMatchObject({ reason: 'INPUT_HASH_MISMATCH' });

    await tamper(store, id, (s) => {
      Object.assign(s, snapshot, { scan: { ...snapshot.scan, status: 'COMPLETE' } });
    });
    expect(await reproduceScan(id, store)).toMatchObject({ reason: 'OUTPUT_MISMATCH' });

    await tamper(store, id, (s) => {
      Object.assign(s, snapshot, {
        scan: {
          ...snapshot.scan,
          universe: { ...snapshot.scan.universe, members: ['BTC-USD'] },
        },
      });
    });
    expect(await reproduceScan(id, store)).toMatchObject({ reason: 'UNIVERSE_HASH_MISMATCH' });
  });

  it('summarizes the ranking and every unevaluated member without the raw candles', async () => {
    const store = await mkdtemp(join(tmpdir(), 'zerochart-scan-'));
    const { path, snapshot } = await scanInto(store);
    const summary = scanSummary(path, snapshot);
    expect(summary.ranked.map((row) => row.rank)).toEqual([1, 2, 3]);
    expect(summary.notEvaluated).toEqual([
      {
        ticker: 'XRP-USD',
        assetClass: 'crypto',
        status: 'FETCH_FAILED',
        detail: 'HTTP 503',
        fetchedAt: null,
        cached: false,
      },
    ]);
    expect(summary.unsupported.map((group) => [group.assetClass, group.tickers])).toEqual([
      ['equity', ['AAPL', 'SPY']],
      ['forex', ['EURUSD=X']],
    ]);
    expect(JSON.stringify(summary)).not.toContain('closeTime');
  });
});

describe('market scan snapshots with an equity provider (fixture)', () => {
  const SECRET = 'sk_live_fixture_credential_never_serialized';
  /** An adapter holding a credential in its closure, as a real one would server-side. */
  const sentHeaders: string[] = [];
  function credentialedProvider() {
    const inner = fixtureProvider({
      AAPL: split(bars(wave)),
      SPY: split(bars((i) => 400 + i)),
      MSFT: new Error('HTTP 503'),
    });
    const authorization = `Token ${SECRET}`;
    return {
      ...inner,
      fetchDaily: (symbol: string, range: { from: string; to: string }) => {
        sentHeaders.push(authorization);
        return inner.fetchDaily(symbol, range);
      },
    };
  }

  async function equityScanInto(store: string) {
    return runScan({
      universe: ['AAPL', 'BTC-USD', 'MSFT', 'SPY'],
      universeSource: 'assets_status',
      sources: {
        crypto: async () => CANDLES['BTC-USD']!,
        equity: credentialedProvider(),
        now: () => EQUITY_NOW,
      },
      repositoryCommit: COMMIT,
      store,
      now: () => EQUITY_NOW,
    });
  }

  it('reproduces offline, with the provider and policy attributed and no credential stored', async () => {
    const store = await mkdtemp(join(tmpdir(), 'zerochart-scan-'));
    const { path, snapshot } = await equityScanInto(store);
    expect(snapshot.scan.cohorts.map((cohort) => [cohort.assetClass, cohort.provider])).toEqual([
      ['crypto', 'binance-spot-klines'],
      ['equity', 'fixture-eod'],
    ]);
    // Reproduction reads only the snapshot: no provider is passed or called.
    expect(await reproduceScan(snapshot.scanId, store)).toEqual({
      status: 'MATCH',
      scanId: snapshot.scanId,
    });
    expect(sentHeaders.length).toBeGreaterThan(0);
    expect(await readFile(path, 'utf8')).not.toContain(SECRET);

    const summary = scanSummary(path, snapshot);
    expect(summary.ranked.map((row) => [row.assetClass, row.ticker, row.rank])).toEqual([
      ['crypto', 'BTC-USD', 1],
      expect.arrayContaining(['equity', 1]),
      expect.arrayContaining(['equity', 2]),
    ]);
    expect(summary.notEvaluated).toEqual([
      expect.objectContaining({ ticker: 'MSFT', assetClass: 'equity', status: 'FETCH_FAILED' }),
    ]);
    expect(summary.cohorts[1]).toMatchObject({
      candlePolicyVersion: 'us-equity-daily-v1',
      dataAsOf: { newest: '2026-10-27T20:00:00.000Z' },
    });
  });

  it('detects an edited equity series', async () => {
    const store = await mkdtemp(join(tmpdir(), 'zerochart-scan-'));
    const { snapshot } = await equityScanInto(store);
    await tamper(store, snapshot.scanId, (s) => {
      const aapl = s.inputs.find((input) => input.ticker === 'AAPL')!.equity!.series!;
      aapl.bars[150]!.close *= 1.001;
    });
    expect(await reproduceScan(snapshot.scanId, store)).toMatchObject({
      reason: 'INPUT_HASH_MISMATCH',
    });
  });
});

describe('fetchAssetsStatusUniverse', () => {
  it('pages through assets_status with GET requests and the public key only', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const page = (count: number, offset: number) =>
      Array.from({ length: count }, (_, i) => ({ ticker: `T${offset + i}` }));
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      const offset = Number(new URL(url).searchParams.get('offset'));
      return new Response(JSON.stringify(page(offset === 0 ? 1000 : 2, offset)));
    }) as typeof fetch;
    const tickers = await fetchAssetsStatusUniverse(
      {
        VITE_SUPABASE_URL: 'https://example.test',
        VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x',
      },
      fetchImpl,
    );
    expect(tickers).toHaveLength(1002);
    expect(requests.map((request) => request.url)).toEqual([
      'https://example.test/rest/v1/assets_status?select=ticker&order=ticker&offset=0&limit=1000',
      'https://example.test/rest/v1/assets_status?select=ticker&order=ticker&offset=1000&limit=1000',
    ]);
    expect(requests.every((request) => request.init?.method === undefined)).toBe(true);
    expect(requests[0]?.init?.headers).toEqual({ apikey: 'sb_publishable_x' });
  });

  it('refuses to run without the Supabase URL and public key', async () => {
    await expect(fetchAssetsStatusUniverse({})).rejects.toThrow(/VITE_SUPABASE_URL/);
  });
});
