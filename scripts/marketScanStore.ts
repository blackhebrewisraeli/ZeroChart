import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  collectScanInputs,
  evaluateScan,
  SCANNER_VERSION,
  type MarketScan,
  type ScanInput,
  type ScanSources,
} from '@/lib/marketScanner';
import { CANONICAL_MODEL_VERSION } from '@/lib/canonicalModel';
import { stableSerialize } from './evaluationStore';

/**
 * Scan-level evidence: everything needed to re-derive a scan offline. A
 * separate evidence type from scheduled-score campaigns (.zerochart-campaigns)
 * and received TradingView alerts (trading_signals); it never writes to either.
 */
export interface ScanSnapshot {
  schemaVersion: '1';
  evidenceType: 'market-scan';
  scanId: string;
  repositoryCommit: string;
  startedAt: string;
  completedAt: string;
  /** sha256 of the universe source and its sorted members. */
  universeVersion: string;
  /** sha256 of each member's collected input (candles or recorded failure). */
  inputHashes: Record<string, string>;
  inputs: readonly ScanInput[];
  scan: MarketScan;
}

export const SCAN_STORE = '.zerochart-scans';

function sha256(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex');
}

export function universeVersion(source: string, members: readonly string[]): string {
  return sha256({ source, members });
}

function hashInputs(inputs: readonly ScanInput[]): Record<string, string> {
  return Object.fromEntries(inputs.map((input) => [input.ticker, sha256(input)]));
}

/** The assets_status tickers, read with the public key exactly as the Markets page reads them. */
export async function fetchAssetsStatusUniverse(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const url = env['VITE_SUPABASE_URL'];
  const key = env['VITE_SUPABASE_PUBLISHABLE_KEY'] || env['VITE_SUPABASE_ANON_KEY'];
  if (!url || !key) {
    throw new Error(
      'scan reads the universe from assets_status: set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY (e.g. tsx --env-file=.env)',
    );
  }
  const tickers: string[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const response = await fetchImpl(
      `${url}/rest/v1/assets_status?select=ticker&order=ticker&offset=${offset}&limit=${pageSize}`,
      { headers: { apikey: key }, signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok) throw new Error(`assets_status request failed with HTTP ${response.status}`);
    const rows = (await response.json()) as Array<{ ticker: unknown }>;
    tickers.push(...rows.flatMap((row) => (typeof row.ticker === 'string' ? [row.ticker] : [])));
    if (rows.length < pageSize) return tickers;
  }
}

function scanIdFor(startedAt: number, version: string): string {
  return `${new Date(startedAt).toISOString().replace(/[-:]|\.\d{3}/g, '')}-${version.slice(0, 8)}`;
}

function snapshotPath(store: string, scanId: string): string {
  if (!/^\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(scanId)) throw new Error(`Invalid scan ID: ${scanId}`);
  return join(resolve(store), `${scanId}.json`);
}

/** Runs one scan and writes its snapshot; an existing snapshot is never overwritten. */
export async function runScan(options: {
  universe: readonly string[];
  universeSource: string;
  sources: ScanSources;
  repositoryCommit: string;
  store: string;
  now?: () => number;
}): Promise<{ path: string; snapshot: ScanSnapshot }> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const inputs = await collectScanInputs(options.universe, options.sources, {
    evaluationTime: startedAt,
  });
  const scan = evaluateScan(inputs, {
    evaluationTime: startedAt,
    universeSource: options.universeSource,
    equityProvider: options.sources.equity?.id ?? null,
  });
  const version = universeVersion(scan.universe.source, scan.universe.members);
  const snapshot: ScanSnapshot = {
    schemaVersion: '1',
    evidenceType: 'market-scan',
    scanId: scanIdFor(startedAt, version),
    repositoryCommit: options.repositoryCommit,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(now()).toISOString(),
    universeVersion: version,
    inputHashes: hashInputs(inputs),
    inputs,
    scan,
  };
  const path = snapshotPath(options.store, snapshot.scanId);
  await mkdir(resolve(options.store), { recursive: true });
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx' });
  return { path, snapshot };
}

export async function loadScan(scanId: string, store: string): Promise<ScanSnapshot> {
  const snapshot = JSON.parse(await readFile(snapshotPath(store, scanId), 'utf8')) as ScanSnapshot;
  if (snapshot.schemaVersion !== '1' || snapshot.evidenceType !== 'market-scan') {
    throw new Error(`${scanId} is not a market-scan snapshot`);
  }
  return snapshot;
}

/** Re-derives a stored scan from its own inputs, offline, and compares every output. */
export async function reproduceScan(
  scanId: string,
  store: string,
): Promise<{
  status: 'MATCH' | 'MISMATCH';
  scanId: string;
  reason?:
    'UNSUPPORTED_VERSION' | 'UNIVERSE_HASH_MISMATCH' | 'INPUT_HASH_MISMATCH' | 'OUTPUT_MISMATCH';
}> {
  const snapshot = await loadScan(scanId, store);
  const mismatch = (reason: NonNullable<Awaited<ReturnType<typeof reproduceScan>>['reason']>) => ({
    status: 'MISMATCH' as const,
    scanId,
    reason,
  });
  if (
    snapshot.scan.scannerVersion !== SCANNER_VERSION ||
    snapshot.scan.modelVersion !== CANONICAL_MODEL_VERSION
  ) {
    return mismatch('UNSUPPORTED_VERSION');
  }
  const { source, members } = snapshot.scan.universe;
  if (universeVersion(source, members) !== snapshot.universeVersion) {
    return mismatch('UNIVERSE_HASH_MISMATCH');
  }
  if (stableSerialize(hashInputs(snapshot.inputs)) !== stableSerialize(snapshot.inputHashes)) {
    return mismatch('INPUT_HASH_MISMATCH');
  }
  const recomputed = evaluateScan(snapshot.inputs, {
    evaluationTime: snapshot.scan.evaluationTime,
    universeSource: source,
    equityProvider:
      snapshot.scan.cohorts.find((cohort) => cohort.assetClass === 'equity')?.provider ?? null,
  });
  return stableSerialize(recomputed) === stableSerialize(snapshot.scan)
    ? { status: 'MATCH', scanId }
    : mismatch('OUTPUT_MISMATCH');
}

/** What the CLI prints: the ranking and every unevaluated member, without the raw candles. */
export function scanSummary(path: string, snapshot: ScanSnapshot) {
  const { scan } = snapshot;
  const iso = (time: number | null) => (time === null ? null : new Date(time).toISOString());
  return {
    scanId: snapshot.scanId,
    path,
    status: scan.status,
    startedAt: snapshot.startedAt,
    completedAt: snapshot.completedAt,
    versions: {
      scanner: scan.scannerVersion,
      model: scan.modelVersion,
      universe: snapshot.universeVersion,
      repositoryCommit: snapshot.repositoryCommit,
    },
    universe: { source: scan.universe.source, members: scan.universe.members.length },
    coverage: scan.coverage,
    cohorts: scan.cohorts.map((cohort) => ({
      ...cohort,
      dataAsOf: { oldest: iso(cohort.dataAsOf.oldest), newest: iso(cohort.dataAsOf.newest) },
    })),
    // Ranks restart per asset class: scores are never compared across classes.
    ranked: scan.results
      .filter((result) => result.status === 'EVALUATED')
      .map((result) => ({
        assetClass: result.assetClass,
        rank: result.rank,
        ticker: result.ticker,
        instrument: result.instrument,
        score: result.model?.signal_score ?? null,
        regime: result.model?.regime ?? null,
        setups: result.setups,
        riskProfiles: result.riskProfiles,
        dataAsOf: iso(result.dataAsOf),
        fetchedAt: iso(result.fetchedAt),
        cached: result.cached,
        rationale: result.model?.rationale ?? null,
      })),
    notEvaluated: scan.results
      .filter((result) => result.status !== 'EVALUATED' && result.status !== 'UNSUPPORTED')
      .map((result) => ({
        ticker: result.ticker,
        assetClass: result.assetClass,
        status: result.status,
        detail: result.detail,
        fetchedAt: iso(result.fetchedAt),
        cached: result.cached,
      })),
    unsupported: (['equity', 'forex', 'crypto'] as const).flatMap((assetClass) => {
      const results = scan.results.filter(
        (result) => result.status === 'UNSUPPORTED' && result.assetClass === assetClass,
      );
      if (results.length === 0) return [];
      return [
        {
          assetClass,
          count: results.length,
          reason: results[0]?.detail ?? null,
          tickers: results.map((result) => result.ticker),
        },
      ];
    }),
  };
}
