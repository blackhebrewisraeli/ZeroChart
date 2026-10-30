import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  collectScanInputs,
  compareTickers,
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

export type ScanSnapshotDifference =
  'INPUTS' | 'UNIVERSE' | 'ATTRIBUTION' | 'EVALUATION_TIME' | 'OUTPUTS' | 'SNAPSHOT';

/** A retry targeted an immutable snapshot whose verified evidence is not equivalent. */
export class ScanSnapshotConflictError extends Error {
  readonly code = 'SCAN_SNAPSHOT_CONFLICT' as const;
  readonly details: {
    status: 'CONFLICT';
    code: 'SCAN_SNAPSHOT_CONFLICT';
    scanId: string;
    path: string;
    differences: readonly ScanSnapshotDifference[];
  };

  constructor(
    readonly scanId: string,
    readonly path: string,
    readonly differences: readonly ScanSnapshotDifference[],
  ) {
    super(`Conflicting scan snapshot ${scanId}: ${differences.join(', ')}`);
    this.name = 'ScanSnapshotConflictError';
    this.details = { status: 'CONFLICT', code: this.code, scanId, path, differences };
  }

  toJSON() {
    return this.details;
  }
}

export const SCAN_STORE = '.zerochart-scans';

function sha256(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex');
}

export function universeVersion(source: string, members: readonly string[]): string {
  return sha256({ source, members });
}

export function hashInputs(inputs: readonly ScanInput[]): Record<string, string> {
  return Object.fromEntries(inputs.map((input) => [input.ticker, sha256(input)]));
}

/** The JSON representation is the evidence contract; input order is not semantically relevant. */
export function normalizeInputs(inputs: readonly ScanInput[]): ScanInput[] {
  const json = JSON.stringify(inputs);
  if (json === undefined) throw new Error('Scan inputs are not JSON serializable');
  return (JSON.parse(json) as ScanInput[]).sort((a, b) => compareTickers(a.ticker, b.ticker));
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
  return saveScan({
    ...options,
    inputs,
    evaluationTime: startedAt,
    equityProvider: options.sources.equity?.id ?? null,
    completedAt: now(),
  });
}

/**
 * Scores already-collected inputs and writes the snapshot. `runScan` collects
 * them itself; an import (scripts/tradingViewImport.ts) passes inputs another
 * process collected, with the time collection ended as `evaluationTime`.
 */
export async function saveScan(options: {
  inputs: readonly ScanInput[];
  evaluationTime: number;
  universeSource: string;
  equityProvider: string | null;
  repositoryCommit: string;
  store: string;
  completedAt: number;
  onExisting?: 'ERROR' | 'REUSE_EQUIVALENT';
}): Promise<{
  path: string;
  snapshot: ScanSnapshot;
  snapshotStatus: 'CREATED' | 'REUSED';
}> {
  const evaluationTime = options.evaluationTime;
  const inputs = normalizeInputs(options.inputs);
  const scan = evaluateScan(inputs, {
    evaluationTime,
    universeSource: options.universeSource,
    equityProvider: options.equityProvider,
  });
  const version = universeVersion(scan.universe.source, scan.universe.members);
  const snapshot: ScanSnapshot = {
    schemaVersion: '1',
    evidenceType: 'market-scan',
    scanId: scanIdFor(evaluationTime, version),
    repositoryCommit: options.repositoryCommit,
    startedAt: new Date(evaluationTime).toISOString(),
    completedAt: new Date(options.completedAt).toISOString(),
    universeVersion: version,
    inputHashes: hashInputs(inputs),
    inputs,
    scan,
  };
  const path = snapshotPath(options.store, snapshot.scanId);
  await mkdir(resolve(options.store), { recursive: true });
  try {
    await atomicCreateSnapshot(path, `${JSON.stringify(snapshot, null, 2)}\n`);
    return { path, snapshot, snapshotStatus: 'CREATED' };
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
      options.onExisting !== 'REUSE_EQUIVALENT'
    ) {
      throw error;
    }
    const existing = await loadVerifiedSnapshot(snapshot.scanId, options.store, path);
    const differences = snapshotDifferences(existing, snapshot);
    if (differences.length > 0) {
      throw new ScanSnapshotConflictError(snapshot.scanId, path, differences);
    }
    return { path, snapshot: existing, snapshotStatus: 'REUSED' };
  }
}

async function atomicCreateSnapshot(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { flag: 'wx' });
    // A hard link gives us an atomic create-if-absent without exposing a partial destination.
    await link(temporary, path);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export async function loadScan(scanId: string, store: string): Promise<ScanSnapshot> {
  const snapshot = JSON.parse(await readFile(snapshotPath(store, scanId), 'utf8')) as ScanSnapshot;
  if (snapshot.schemaVersion !== '1' || snapshot.evidenceType !== 'market-scan') {
    throw new Error(`${scanId} is not a market-scan snapshot`);
  }
  return snapshot;
}

type ScanMismatchReason =
  | 'UNSUPPORTED_VERSION'
  | 'UNIVERSE_HASH_MISMATCH'
  | 'INPUT_HASH_MISMATCH'
  | 'OUTPUT_MISMATCH'
  | 'EVALUATION_TIME_MISMATCH'
  | 'SNAPSHOT_METADATA_MISMATCH';

function snapshotMismatchReason(snapshot: ScanSnapshot): ScanMismatchReason | null {
  if (
    !snapshot ||
    typeof snapshot.repositoryCommit !== 'string' ||
    !Number.isFinite(Date.parse(snapshot.completedAt)) ||
    !Array.isArray(snapshot.inputs) ||
    !snapshot.inputHashes ||
    typeof snapshot.inputHashes !== 'object' ||
    !snapshot.scan ||
    !Array.isArray(snapshot.scan.cohorts) ||
    !Array.isArray(snapshot.scan.results) ||
    !snapshot.scan.universe ||
    typeof snapshot.scan.universe.source !== 'string' ||
    !Array.isArray(snapshot.scan.universe.members)
  ) {
    return 'SNAPSHOT_METADATA_MISMATCH';
  }
  if (
    snapshot.scan.scannerVersion !== SCANNER_VERSION ||
    snapshot.scan.modelVersion !== CANONICAL_MODEL_VERSION
  ) {
    return 'UNSUPPORTED_VERSION';
  }
  const evaluationTime = snapshot.scan.evaluationTime;
  const evaluationDate = new Date(evaluationTime);
  if (
    !Number.isFinite(evaluationTime) ||
    !Number.isFinite(evaluationDate.getTime()) ||
    snapshot.startedAt !== evaluationDate.toISOString() ||
    snapshot.scanId !== scanIdFor(evaluationTime, snapshot.universeVersion)
  ) {
    return 'EVALUATION_TIME_MISMATCH';
  }
  const { source, members } = snapshot.scan.universe;
  if (universeVersion(source, members) !== snapshot.universeVersion) {
    return 'UNIVERSE_HASH_MISMATCH';
  }
  if (stableSerialize(hashInputs(snapshot.inputs)) !== stableSerialize(snapshot.inputHashes)) {
    return 'INPUT_HASH_MISMATCH';
  }
  const recomputed = evaluateScan(snapshot.inputs, {
    evaluationTime,
    universeSource: source,
    equityProvider:
      snapshot.scan.cohorts.find((cohort) => cohort.assetClass === 'equity')?.provider ?? null,
  });
  return stableSerialize(recomputed) === stableSerialize(snapshot.scan) ? null : 'OUTPUT_MISMATCH';
}

function differenceForMismatch(reason: ScanMismatchReason): ScanSnapshotDifference {
  return {
    UNSUPPORTED_VERSION: 'ATTRIBUTION',
    UNIVERSE_HASH_MISMATCH: 'UNIVERSE',
    INPUT_HASH_MISMATCH: 'INPUTS',
    OUTPUT_MISMATCH: 'OUTPUTS',
    EVALUATION_TIME_MISMATCH: 'EVALUATION_TIME',
    SNAPSHOT_METADATA_MISMATCH: 'SNAPSHOT',
  }[reason] as ScanSnapshotDifference;
}

async function loadVerifiedSnapshot(
  scanId: string,
  store: string,
  path: string,
): Promise<ScanSnapshot> {
  try {
    const snapshot = await loadScan(scanId, store);
    if (snapshot.scanId !== scanId) {
      throw new ScanSnapshotConflictError(scanId, path, ['EVALUATION_TIME']);
    }
    const mismatch = snapshotMismatchReason(snapshot);
    if (mismatch !== null) {
      throw new ScanSnapshotConflictError(scanId, path, [differenceForMismatch(mismatch)]);
    }
    return snapshot;
  } catch (error) {
    if (error instanceof ScanSnapshotConflictError) throw error;
    throw new ScanSnapshotConflictError(scanId, path, ['SNAPSHOT']);
  }
}

function scanAttribution(scan: MarketScan): unknown {
  return {
    scannerVersion: scan.scannerVersion,
    modelVersion: scan.modelVersion,
    timeframe: scan.timeframe,
    cohorts: scan.cohorts.map((cohort) => ({
      assetClass: cohort.assetClass,
      timeframe: cohort.timeframe,
      provider: cohort.provider,
      candlePolicyVersion: cohort.candlePolicyVersion,
      calendar: cohort.calendar,
      minClosedCandles: cohort.minClosedCandles,
      freshness: cohort.freshness,
    })),
  };
}

function calculatedOutputs(scan: MarketScan): unknown {
  return {
    status: scan.status,
    coverage: scan.coverage,
    cohorts: scan.cohorts.map((cohort) => ({
      assetClass: cohort.assetClass,
      status: cohort.status,
      coverage: cohort.coverage,
      dataAsOf: cohort.dataAsOf,
    })),
    results: scan.results,
  };
}

function snapshotDifferences(
  existing: ScanSnapshot,
  candidate: ScanSnapshot,
): ScanSnapshotDifference[] {
  const differences: ScanSnapshotDifference[] = [];
  if (
    stableSerialize({ inputs: normalizeInputs(existing.inputs), hashes: existing.inputHashes }) !==
    stableSerialize({ inputs: normalizeInputs(candidate.inputs), hashes: candidate.inputHashes })
  ) {
    differences.push('INPUTS');
  }
  if (
    stableSerialize({ version: existing.universeVersion, universe: existing.scan.universe }) !==
    stableSerialize({ version: candidate.universeVersion, universe: candidate.scan.universe })
  ) {
    differences.push('UNIVERSE');
  }
  if (
    stableSerialize(scanAttribution(existing.scan)) !==
    stableSerialize(scanAttribution(candidate.scan))
  ) {
    differences.push('ATTRIBUTION');
  }
  if (
    existing.scan.evaluationTime !== candidate.scan.evaluationTime ||
    existing.startedAt !== candidate.startedAt
  ) {
    differences.push('EVALUATION_TIME');
  }
  if (
    stableSerialize(calculatedOutputs(existing.scan)) !==
    stableSerialize(calculatedOutputs(candidate.scan))
  ) {
    differences.push('OUTPUTS');
  }
  return differences;
}

/** Re-derives a stored scan from its own inputs, offline, and compares every output. */
export async function reproduceScan(
  scanId: string,
  store: string,
): Promise<{
  status: 'MATCH' | 'MISMATCH';
  scanId: string;
  reason?:
    | 'UNSUPPORTED_VERSION'
    | 'UNIVERSE_HASH_MISMATCH'
    | 'INPUT_HASH_MISMATCH'
    | 'OUTPUT_MISMATCH'
    | 'EVALUATION_TIME_MISMATCH'
    | 'SNAPSHOT_METADATA_MISMATCH';
}> {
  const snapshot = await loadScan(scanId, store);
  const mismatch = (reason: NonNullable<Awaited<ReturnType<typeof reproduceScan>>['reason']>) => ({
    status: 'MISMATCH' as const,
    scanId,
    reason,
  });
  const reason = snapshotMismatchReason(snapshot);
  return reason === null ? { status: 'MATCH', scanId } : mismatch(reason);
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
