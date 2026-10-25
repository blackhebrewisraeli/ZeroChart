import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { DecisionSnapshot } from '@/lib/evaluationLab';
import { toBinanceSymbol } from '@/lib/binance';
import { stableSerialize } from './evaluationStore';
import { loadCampaignEvidence } from './observationCampaign';

const DAY_MS = 86_400_000;
export const OUTCOME_HORIZONS = [1, 7, 30] as const;
export type OutcomeHorizon = (typeof OUTCOME_HORIZONS)[number];
export type OutcomeStatus = 'PENDING' | 'AVAILABLE' | 'MISSING' | 'INVALID_CONFLICTING';

export const OUTCOME_SPECIFICATION = {
  schemaVersion: '1',
  name: 'zerochart-prospective-signal-outcomes',
  frozenAt: '2026-10-25T00:00:00.000Z',
  provider: 'binance-spot-rest',
  timeframe: '1d-utc',
  providerTimestampSemantics: {
    candleKey: 'open-time',
    openTimeField: 0,
    openPriceField: 1,
    dailyBoundary: '00:00:00Z',
  },
  horizonsCalendarDays: OUTCOME_HORIZONS,
  referencePrice: 'OPEN of the first UTC daily candle whose open time is strictly after observedAt',
  endpointPrice:
    'OPEN of the UTC daily candle exactly horizon calendar days after reference open time',
  benchmark: 'BTC-USD over the identical reference and endpoint timestamps',
  comparisonGroups: [
    'selected-assets',
    'qualified-not-selected-assets',
    'scored-rejected-assets',
    'full-scored-observed-universe',
  ],
  missingDataRules: {
    substitution: 'none',
    pending: 'endpoint open time is later than collection time',
    available: 'one validated candle exists at each exact required timestamp',
    missing: 'endpoint has occurred but a required exact candle is absent',
    invalidConflicting: 'duplicate, invalid, or conflicting provider data',
  },
  interpretation:
    'Reference-price signal research only; not fills, a portfolio backtest, risk-adjusted alpha, or evidence of executable profitability.',
} as const;

export const OUTCOME_SPECIFICATION_ID = createHash('sha256')
  .update(stableSerialize(OUTCOME_SPECIFICATION))
  .digest('hex');

export interface ResearchCandle {
  openTime: number;
  open: number;
}

export interface HorizonOutcome {
  horizonDays: OutcomeHorizon;
  status: OutcomeStatus;
  endpointOpenTime: string;
  endpointPrice: number | null;
  assetChangePct: number | null;
  benchmarkChangePct: number | null;
  differencePercentagePoints: number | null;
  detail: string | null;
}

export interface OutcomeRecord {
  schemaVersion: '1';
  campaignId: string;
  slot: string;
  runKey: string;
  asset: string;
  decisionStatus: DecisionSnapshot['status'];
  selectionStatus: DecisionSnapshot['selectionStatus'];
  originalScore: number;
  configurationId: string;
  modelVersion: string;
  observedAt: string;
  scheduledSlot: string;
  analysisRegistration: 'PREREGISTERED' | 'RETROSPECTIVELY_SPECIFIED';
  synthetic: boolean;
  outcomeSpecificationId: string;
  provider: 'binance-spot-rest';
  fetchedAt: string;
  referenceOpenTime: string;
  referencePrice: number | null;
  benchmarkAsset: 'BTC-USD';
  benchmarkReferencePrice: number | null;
  supportingPrices: Array<{ asset: string; openTime: string; open: number }>;
  horizons: HorizonOutcome[];
}

export class OutcomeConflictError extends Error {}

export function firstDailyOpenStrictlyAfter(observedAt: string | number | Date): number {
  const value = new Date(observedAt).getTime();
  if (!Number.isFinite(value)) throw new Error('Invalid observation time');
  return Math.floor(value / DAY_MS) * DAY_MS + DAY_MS;
}

function exactCandle(candles: readonly ResearchCandle[], openTime: number) {
  const matches = candles.filter((candle) => candle.openTime === openTime);
  if (matches.length > 1) return { kind: 'invalid' as const, candle: null };
  const candle = matches[0];
  if (!candle) return { kind: 'missing' as const, candle: null };
  if (candle.open <= 0 || !Number.isFinite(candle.open)) {
    return { kind: 'invalid' as const, candle: null };
  }
  return { kind: 'available' as const, candle };
}

function pct(reference: number, endpoint: number): number {
  return (endpoint / reference - 1) * 100;
}

export function measureOutcome(input: {
  campaignId: string;
  slot: string;
  runKey: string;
  observedAt: string;
  decision: DecisionSnapshot;
  assetCandles: readonly ResearchCandle[];
  benchmarkCandles: readonly ResearchCandle[];
  now: Date;
  fetchedAt?: Date;
  synthetic?: boolean;
}): OutcomeRecord {
  if (input.decision.score === null) throw new Error('Original data failures are not measurable');
  const referenceOpenTime = firstDailyOpenStrictlyAfter(input.observedAt);
  const assetReference = exactCandle(input.assetCandles, referenceOpenTime);
  const benchmarkReference = exactCandle(input.benchmarkCandles, referenceOpenTime);
  const supporting = new Map<string, { asset: string; openTime: string; open: number }>();
  const add = (asset: string, candle: ResearchCandle | null) => {
    if (candle)
      supporting.set(`${asset}:${candle.openTime}`, {
        asset,
        openTime: new Date(candle.openTime).toISOString(),
        open: candle.open,
      });
  };
  add(input.decision.asset, assetReference.candle);
  add('BTC-USD', benchmarkReference.candle);
  const horizons = OUTCOME_HORIZONS.map((horizonDays): HorizonOutcome => {
    const endpointOpenTime = referenceOpenTime + horizonDays * DAY_MS;
    const base = {
      horizonDays,
      endpointOpenTime: new Date(endpointOpenTime).toISOString(),
      endpointPrice: null,
      assetChangePct: null,
      benchmarkChangePct: null,
      differencePercentagePoints: null,
      detail: null,
    };
    if (input.now.getTime() < endpointOpenTime) return { ...base, status: 'PENDING' };
    const assetEndpoint = exactCandle(input.assetCandles, endpointOpenTime);
    const benchmarkEndpoint = exactCandle(input.benchmarkCandles, endpointOpenTime);
    if (
      assetReference.kind === 'invalid' ||
      benchmarkReference.kind === 'invalid' ||
      assetEndpoint.kind === 'invalid' ||
      benchmarkEndpoint.kind === 'invalid'
    ) {
      return {
        ...base,
        status: 'INVALID_CONFLICTING',
        detail: 'Duplicate or invalid exact candle.',
      };
    }
    if (
      assetReference.kind === 'missing' ||
      benchmarkReference.kind === 'missing' ||
      assetEndpoint.kind === 'missing' ||
      benchmarkEndpoint.kind === 'missing'
    ) {
      return {
        ...base,
        status: 'MISSING',
        detail: 'A required exact candle is unavailable; no substitution was used.',
      };
    }
    add(input.decision.asset, assetEndpoint.candle);
    add('BTC-USD', benchmarkEndpoint.candle);
    const assetChangePct = pct(assetReference.candle.open, assetEndpoint.candle.open);
    const benchmarkChangePct = pct(benchmarkReference.candle.open, benchmarkEndpoint.candle.open);
    return {
      ...base,
      status: 'AVAILABLE',
      endpointPrice: assetEndpoint.candle.open,
      assetChangePct,
      benchmarkChangePct,
      differencePercentagePoints: assetChangePct - benchmarkChangePct,
    };
  });
  return {
    schemaVersion: '1',
    campaignId: input.campaignId,
    slot: input.slot,
    runKey: input.runKey,
    asset: input.decision.asset,
    decisionStatus: input.decision.status,
    selectionStatus: input.decision.selectionStatus,
    originalScore: input.decision.score,
    configurationId: input.decision.configurationId,
    modelVersion: input.decision.modelVersion,
    observedAt: input.observedAt,
    scheduledSlot: input.slot,
    analysisRegistration:
      Date.parse(input.observedAt) >= Date.parse(OUTCOME_SPECIFICATION.frozenAt)
        ? 'PREREGISTERED'
        : 'RETROSPECTIVELY_SPECIFIED',
    synthetic: input.synthetic ?? false,
    outcomeSpecificationId: OUTCOME_SPECIFICATION_ID,
    provider: 'binance-spot-rest',
    fetchedAt: (input.fetchedAt ?? input.now).toISOString(),
    referenceOpenTime: new Date(referenceOpenTime).toISOString(),
    referencePrice: assetReference.candle?.open ?? null,
    benchmarkAsset: 'BTC-USD',
    benchmarkReferencePrice: benchmarkReference.candle?.open ?? null,
    supportingPrices: [...supporting.values()].sort(
      (a, b) => a.openTime.localeCompare(b.openTime) || a.asset.localeCompare(b.asset),
    ),
    horizons,
  };
}

export async function fetchResearchCandles(
  ticker: string,
  startTime: number,
  endTime: number,
): Promise<ResearchCandle[]> {
  const symbol = toBinanceSymbol(ticker);
  if (!symbol) return [];
  const url = new URL('https://api.binance.com/api/v3/klines');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', '1d');
  url.searchParams.set('startTime', String(startTime));
  url.searchParams.set('endTime', String(endTime));
  url.searchParams.set('limit', '1000');
  const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`Binance research klines failed with ${response.status}`);
  const raw = (await response.json()) as unknown;
  if (!Array.isArray(raw)) throw new Error('Binance research klines response is not an array');
  return raw.flatMap((row): ResearchCandle[] => {
    if (!Array.isArray(row)) return [];
    const openTime = Number(row[0]);
    const open = Number.parseFloat(String(row[1]));
    return Number.isFinite(openTime) && Number.isFinite(open) ? [{ openTime, open }] : [];
  });
}

export async function saveOutcomeRecord(
  path: string,
  record: OutcomeRecord,
): Promise<'CREATED' | 'UNCHANGED'> {
  const content = `${JSON.stringify(record, null, 2)}\n`;
  await mkdir(resolve(path, '..'), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { flag: 'wx' });
    try {
      await link(temporary, path);
      return 'CREATED';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readFile(path, 'utf8');
      if (existing !== content)
        throw new OutcomeConflictError(`Provider revision conflict for ${path}`);
      return 'UNCHANGED';
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function safePart(value: string): string {
  return encodeURIComponent(value).replaceAll('%', '_');
}

export async function collectCampaignOutcomes(
  campaignId: string,
  store: string,
  options: {
    now?: Date;
    fetchCandles?: typeof fetchResearchCandles;
  } = {},
) {
  const now = options.now ?? new Date();
  const fetchCandles = options.fetchCandles ?? fetchResearchCandles;
  const { observations } = await loadCampaignEvidence(campaignId, store, now);
  type CollectionResult = {
    asset: string;
    slot: string;
    status: 'CREATED' | 'UNCHANGED' | 'CONFLICT';
  };
  const byObservation = await Promise.all(
    observations.map(async (observation): Promise<CollectionResult[]> => {
      const measurable = observation.run.decisions.filter((decision) => decision.score !== null);
      const reference = firstDailyOpenStrictlyAfter(observation.observedAt);
      const end = reference + 30 * DAY_MS;
      const cache = new Map<string, Promise<ResearchCandle[]>>();
      const load = (asset: string) => {
        const current = cache.get(asset) ?? fetchCandles(asset, reference, end);
        cache.set(asset, current);
        return current;
      };
      const benchmark = await load('BTC-USD');
      return Promise.all(
        measurable.map(async (decision): Promise<CollectionResult> => {
          const record = measureOutcome({
            campaignId,
            slot: observation.slot,
            runKey: observation.run.runKey,
            observedAt: observation.observedAt,
            decision,
            assetCandles: await load(decision.asset),
            benchmarkCandles: benchmark,
            now,
          });
          const path = join(
            resolve(store),
            campaignId,
            'outcomes',
            OUTCOME_SPECIFICATION_ID,
            safePart(observation.slot),
            `${safePart(decision.asset)}.json`,
          );
          try {
            return {
              asset: decision.asset,
              slot: observation.slot,
              status: await saveOutcomeRecord(path, record),
            };
          } catch (error) {
            if (!(error instanceof OutcomeConflictError)) throw error;
            return { asset: decision.asset, slot: observation.slot, status: 'CONFLICT' };
          }
        }),
      );
    }),
  );
  const results = byObservation.flat();
  return { outcomeSpecificationId: OUTCOME_SPECIFICATION_ID, results };
}

export async function loadCampaignOutcomes(
  campaignId: string,
  store: string,
): Promise<OutcomeRecord[]> {
  const root = join(resolve(store), campaignId, 'outcomes', OUTCOME_SPECIFICATION_ID);
  const slots = await readdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const records = (
    await Promise.all(
      slots.map(async (slot): Promise<OutcomeRecord[]> => {
        const directory = join(root, slot);
        const names = await readdir(directory);
        return Promise.all(
          names
            .filter((entry) => entry.endsWith('.json'))
            .map(async (name) => {
              const record = JSON.parse(
                await readFile(join(directory, name), 'utf8'),
              ) as OutcomeRecord;
              if (record.outcomeSpecificationId !== OUTCOME_SPECIFICATION_ID) {
                throw new Error(`Outcome specification mismatch in ${name}`);
              }
              return record;
            }),
        );
      }),
    )
  ).flat();
  return records.sort((a, b) => a.slot.localeCompare(b.slot) || a.asset.localeCompare(b.asset));
}

export function summarizeOutcomes(records: readonly OutcomeRecord[]) {
  const available = OUTCOME_HORIZONS.map((horizonDays) => {
    const values = records.flatMap((record) => {
      const outcome = record.horizons.find((item) => item.horizonDays === horizonDays);
      return outcome?.status === 'AVAILABLE' && outcome.assetChangePct !== null
        ? [outcome.assetChangePct]
        : [];
    });
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    let median: number | null = null;
    if (sorted.length > 0) {
      median =
        sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
    }
    return {
      horizonDays,
      sampleSize: values.length,
      mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      median,
      positiveFraction: values.length
        ? values.filter((value) => value > 0).length / values.length
        : null,
    };
  });
  const dates = [...new Set(records.map((record) => record.observedAt.slice(0, 10)))].sort((a, b) =>
    a.localeCompare(b),
  );
  return {
    byHorizon: available,
    uniqueAssets: new Set(records.map((record) => record.asset)).size,
    observationDates: dates.length,
    dateRange: dates.length ? { start: dates[0]!, end: dates.at(-1)! } : null,
  };
}
