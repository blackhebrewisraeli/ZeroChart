import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fetchSymbolCandles, type Candle } from '@/lib/binance';
import { compareTickers } from '@/lib/marketScanner';
import type { Opportunity, OpportunityCandidateReason } from '@/lib/opportunityRadar';
import {
  createOrVerify,
  loadOpportunityCampaign,
  OpportunityCampaignError,
  opportunitySlotDirectory,
  readIfPresent,
  serialize,
  timeOfDay,
  type OpportunitySlotArtifact,
} from './opportunityCampaign';
import {
  exactCandle,
  firstDailyOpenStrictlyAfter,
  type ResearchCandle,
} from './outcomeMeasurement';

const DAY_MS = 86_400_000;

/** docs/opportunity-radar.v1.json `outcomes.missingData`; nothing is ever substituted. */
export type OpportunityOutcomeStatus = 'PENDING' | 'AVAILABLE' | 'MISSING' | 'INVALID';

export interface OpportunityHorizonOutcome {
  horizonDays: number;
  endpointOpenTime: string;
  status: OpportunityOutcomeStatus;
  /** The first required timestamp that was missing or invalid; null otherwise. */
  detail: string | null;
  referencePrice: number | null;
  endpointPrice: number | null;
  /** endpoint/reference − 1, in percent. */
  grossChangePct: number | null;
  /** Gross change minus the frozen round-trip deduction, in percent. */
  netChangePct: number | null;
  /** Gross, from the reference open through the endpoint open: highest high / lowest low. */
  maxFavorableExcursionPct: number | null;
  maxAdverseExcursionPct: number | null;
  /** Open time of the first candle in the horizon whose low is at or below invalidation. */
  invalidationTouchedAt: string | null;
}

export interface OpportunityEntryZoneOutcome {
  status: 'PENDING' | 'ENTERED' | 'NOT_ENTERED' | 'MISSING' | 'INVALID';
  enteredAt: string | null;
  detail: string | null;
}

export interface OpportunityOutcome {
  opportunityId: string;
  ticker: string;
  instrument: string;
  observedAt: string;
  referenceOpenTime: string;
  roundTripBps: number;
  /** Diagnostic only: the primary population includes Opportunities that never entered. */
  entryZone: OpportunityEntryZoneOutcome;
  horizons: Array<OpportunityHorizonOutcome & { primary: boolean }>;
}

type MeasuredOpportunity = Pick<
  Opportunity,
  | 'id'
  | 'ticker'
  | 'instrument'
  | 'evaluationTime'
  | 'entryZone'
  | 'invalidation'
  | 'validDailyOpens'
  | 'primaryHorizonDays'
  | 'secondaryHorizonDays'
>;

function iso(time: number): string {
  return new Date(time).toISOString();
}

function pct(reference: number, value: number): number {
  return (value / reference - 1) * 100;
}

/**
 * One exact OPEN-to-OPEN horizon. Every daily candle from the reference through
 * the endpoint must exist and validate; the first one that does not decides
 * MISSING or INVALID. A benchmark measurement passes `invalidation: null`.
 */
export function measureHorizon(input: {
  candles: readonly ResearchCandle[];
  referenceOpenTime: number;
  horizonDays: number;
  now: number;
  roundTripBps: number;
  invalidation: number | null;
}): OpportunityHorizonOutcome {
  const endpointOpenTime = input.referenceOpenTime + input.horizonDays * DAY_MS;
  const outcome: OpportunityHorizonOutcome = {
    horizonDays: input.horizonDays,
    endpointOpenTime: iso(endpointOpenTime),
    status: 'PENDING',
    detail: null,
    referencePrice: null,
    endpointPrice: null,
    grossChangePct: null,
    netChangePct: null,
    maxFavorableExcursionPct: null,
    maxAdverseExcursionPct: null,
    invalidationTouchedAt: null,
  };
  if (input.now < endpointOpenTime) return outcome;

  const required: ResearchCandle[] = [];
  for (let time = input.referenceOpenTime; time <= endpointOpenTime; time += DAY_MS) {
    const found = exactCandle(input.candles, time);
    if (found.kind === 'missing') {
      return { ...outcome, status: 'MISSING', detail: `${iso(time)}: no candle; none substituted` };
    }
    if (found.kind === 'invalid') {
      return { ...outcome, status: 'INVALID', detail: `${iso(time)}: ${found.detail}` };
    }
    required.push(found.candle);
  }
  const path = required.slice(0, -1);
  const reference = required[0]!.open;
  const endpoint = required.at(-1)!.open;
  const grossChangePct = pct(reference, endpoint);
  const touched =
    input.invalidation === null
      ? undefined
      : path.find((candle) => candle.low <= input.invalidation!);
  return {
    ...outcome,
    status: 'AVAILABLE',
    referencePrice: reference,
    endpointPrice: endpoint,
    grossChangePct,
    netChangePct: grossChangePct - input.roundTripBps / 100,
    maxFavorableExcursionPct: pct(reference, Math.max(...path.map((c) => c.high), endpoint)),
    maxAdverseExcursionPct: pct(reference, Math.min(...path.map((c) => c.low), endpoint)),
    invalidationTouchedAt: touched === undefined ? null : iso(touched.openTime),
  };
}

/** Whether any of the first `validDailyOpens` opens after observedAt lay inside the zone. */
function measureEntryZone(
  opportunity: MeasuredOpportunity,
  candles: readonly ResearchCandle[],
  referenceOpenTime: number,
  now: number,
): OpportunityEntryZoneOutcome {
  for (let index = 0; index < opportunity.validDailyOpens; index += 1) {
    const time = referenceOpenTime + index * DAY_MS;
    if (now < time) return { status: 'PENDING', enteredAt: null, detail: null };
    const found = exactCandle(candles, time);
    if (found.kind === 'missing') {
      return { status: 'MISSING', enteredAt: null, detail: `${iso(time)}: no candle` };
    }
    if (found.kind === 'invalid') {
      return { status: 'INVALID', enteredAt: null, detail: `${iso(time)}: ${found.detail}` };
    }
    const { open } = found.candle;
    if (open >= opportunity.entryZone.low && open <= opportunity.entryZone.high) {
      return { status: 'ENTERED', enteredAt: iso(time), detail: null };
    }
  }
  return { status: 'NOT_ENTERED', enteredAt: null, detail: null };
}

/**
 * Pure intent-to-treat measurement of one Opportunity: the reference is the
 * first daily OPEN strictly after observedAt whether or not it entered the
 * displayed zone. No clock, network or storage.
 */
export function measureOpportunityOutcome(input: {
  opportunity: MeasuredOpportunity;
  candles: readonly ResearchCandle[];
  now: number;
  roundTripBps: number;
}): OpportunityOutcome {
  const { opportunity } = input;
  const referenceOpenTime = firstDailyOpenStrictlyAfter(opportunity.evaluationTime);
  const horizons = [
    ...new Set([opportunity.primaryHorizonDays, ...opportunity.secondaryHorizonDays]),
  ].sort((a, b) => a - b);
  return {
    opportunityId: opportunity.id,
    ticker: opportunity.ticker,
    instrument: opportunity.instrument,
    observedAt: iso(opportunity.evaluationTime),
    referenceOpenTime: iso(referenceOpenTime),
    roundTripBps: input.roundTripBps,
    entryZone: measureEntryZone(opportunity, input.candles, referenceOpenTime, input.now),
    horizons: horizons.map((horizonDays) => ({
      ...measureHorizon({
        candles: input.candles,
        referenceOpenTime,
        horizonDays,
        now: input.now,
        roundTripBps: input.roundTripBps,
        invalidation: opportunity.invalidation,
      }),
      primary: horizonDays === opportunity.primaryHorizonDays,
    })),
  };
}

/** Fetches one instrument's daily candles opening within [startTime, endTime]. */
export type FetchOutcomeCandles = (
  instrument: string,
  range: { startTime: number; endTime: number; limit: number },
) => Promise<readonly Candle[]>;

// ponytail: one request per instrument; the longest window is 31 candles, far under Binance's 1000.
export const fetchOutcomeCandles: FetchOutcomeCandles = (instrument, range) =>
  fetchSymbolCandles(instrument, { interval: '1d', ...range });

const NOT_JUDGED: ReadonlySet<OpportunityCandidateReason> = new Set([
  'SCANNER_NOT_EVALUATED',
  'INSUFFICIENT_HISTORY',
]);

/**
 * The frozen equal-weight membership: every member the slot judged against the
 * candidate rule. Members with failed data or short history were not eligible.
 */
export function eligibleTickers(artifact: OpportunitySlotArtifact): string[] {
  return artifact.result.assets
    .filter((asset) => !asset.reasons.some((reason) => NOT_JUDGED.has(reason)))
    .map((asset) => asset.ticker)
    .sort(compareTickers);
}

export interface OpportunityOutcomeRecord {
  schemaVersion: '1';
  evidenceType: 'opportunity-radar-outcome';
  campaignId: string;
  specificationId: string;
  slot: string;
  /** sha256 of the slot artifact the Opportunity came from. */
  slotSha256: string;
  opportunityId: string;
  ticker: string;
  instrument: string;
  horizonDays: number;
  primary: boolean;
  referenceOpenTime: string;
  roundTripBps: number;
  entryZone: OpportunityEntryZoneOutcome;
  outcome: OpportunityHorizonOutcome;
  /** The benchmark over the identical reference and endpoint timestamps. */
  btc: OpportunityHorizonOutcome;
  equalWeight: {
    members: string[];
    available: number;
    meanGrossChangePct: number | null;
    meanNetChangePct: number | null;
    outcomes: Record<
      string,
      Pick<OpportunityHorizonOutcome, 'status' | 'grossChangePct' | 'netChangePct'>
    >;
  };
  /** Every received candle opening from the reference through the endpoint, by ticker. */
  candles: Record<string, ResearchCandle[]>;
}

/** Counts of Opportunity horizons; never prices, tickers or paths. */
export interface OpportunityOutcomeCollection {
  created: number;
  unchanged: number;
  /** Matured and already on file; not refetched because nothing new matured for its slot. */
  recorded: number;
  conflicts: number;
  pending: number;
  fetchFailed: number;
}

function researchCandle(candle: Candle): ResearchCandle {
  return {
    openTime: candle.timestamp,
    closeTime: candle.closeTime,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  };
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Appends immutable outcome records for every matured Opportunity horizon. A
 * slot is fetched only when one of its horizons has no record yet; that fetch
 * re-verifies the slot's earlier records, and any difference is a CONFLICT that
 * blocks new records for the slot. A failed fetch records nothing.
 */
export async function collectOpportunityOutcomes(options: {
  campaignId: string;
  store: string;
  fetchCandles?: FetchOutcomeCandles;
  now?: () => number;
  specificationPath?: string;
}): Promise<OpportunityOutcomeCollection> {
  const { directory, manifest, runtime } = await loadOpportunityCampaign(
    options.store,
    options.campaignId,
    options.specificationPath,
  );
  const now = (options.now ?? Date.now)();
  const fetchCandles = options.fetchCandles ?? fetchOutcomeCandles;
  const instruments = new Map(
    manifest.universe.map((member) => [member.ticker, member.instrument]),
  );
  const benchmark = runtime.marketGate.benchmark;
  // An endpoint is collected from that day's primary slot on, never in the seconds after
  // its 00:00 open when the provider may not have the candle yet: a MISSING is permanent.
  const collectionOffset = timeOfDay(manifest.schedule.primarySlot, 'primary slot');
  const roundTripBps = runtime.costs.roundTripBps;
  const horizons = [
    ...new Set([
      runtime.opportunity.primaryHorizonDays,
      ...runtime.opportunity.secondaryHorizonDays,
    ]),
  ].sort((a, b) => a - b);
  const summary: OpportunityOutcomeCollection = {
    created: 0,
    unchanged: 0,
    recorded: 0,
    conflicts: 0,
    pending: 0,
    fetchFailed: 0,
  };

  for (const entry of manifest.slots) {
    if (Date.parse(entry.slot) > now) break;
    const slotBytes = await readIfPresent(
      resolve(opportunitySlotDirectory(directory, entry.slot), 'slot.json'),
    );
    if (slotBytes === null) continue;
    const artifact = JSON.parse(slotBytes) as OpportunitySlotArtifact;
    const { opportunities } = artifact.result;
    if (opportunities.length === 0) continue;
    const referenceOpenTime = firstDailyOpenStrictlyAfter(Date.parse(entry.slot));
    const matured = horizons.filter(
      (days) => referenceOpenTime + days * DAY_MS + collectionOffset <= now,
    );
    summary.pending += (horizons.length - matured.length) * opportunities.length;
    if (matured.length === 0) continue;

    const outcomeDirectory = resolve(
      directory,
      'outcomes',
      manifest.specificationId,
      entry.slot.replaceAll(':', '-'),
    );
    const targets = opportunities.flatMap((opportunity) =>
      matured.map((days) => ({
        opportunity,
        days,
        path: resolve(outcomeDirectory, `${opportunity.ticker}-${days}d.json`),
      })),
    );
    const existing = new Map<string, string>();
    for (const { path } of targets) {
      const bytes = await readIfPresent(path);
      if (bytes !== null) existing.set(path, bytes);
    }
    if (existing.size === targets.length) {
      summary.recorded += targets.length;
      continue;
    }

    const longest = Math.max(...matured);
    const members = eligibleTickers(artifact);
    const fetched = new Map<string, ResearchCandle[]>();
    try {
      const tickers = new Set([...members, benchmark, ...opportunities.map((item) => item.ticker)]);
      for (const ticker of [...tickers].sort(compareTickers)) {
        const candles = await fetchCandles(instruments.get(ticker)!, {
          startTime: referenceOpenTime,
          endTime: referenceOpenTime + longest * DAY_MS,
          limit: longest + 1,
        });
        fetched.set(ticker, candles.map(researchCandle));
      }
    } catch {
      summary.fetchFailed += targets.length - existing.size;
      continue;
    }

    const horizonOf = (ticker: string, days: number) =>
      measureHorizon({
        candles: fetched.get(ticker) ?? [],
        referenceOpenTime,
        horizonDays: days,
        now,
        roundTripBps,
        invalidation: null,
      });
    const records = targets.map(({ opportunity, days, path }) => {
      const measured = measureOpportunityOutcome({
        opportunity,
        candles: fetched.get(opportunity.ticker) ?? [],
        now,
        roundTripBps,
      });
      const { primary, ...outcome } = measured.horizons.find((item) => item.horizonDays === days)!;
      const memberOutcomes = members.map((ticker) => [ticker, horizonOf(ticker, days)] as const);
      const available = memberOutcomes
        .map(([, item]) => item)
        .filter((item) => item.status === 'AVAILABLE');
      const endpointOpenTime = referenceOpenTime + days * DAY_MS;
      const record: OpportunityOutcomeRecord = {
        schemaVersion: '1',
        evidenceType: 'opportunity-radar-outcome',
        campaignId: manifest.campaignId,
        specificationId: manifest.specificationId,
        slot: entry.slot,
        slotSha256: createHash('sha256').update(slotBytes).digest('hex'),
        opportunityId: opportunity.id,
        ticker: opportunity.ticker,
        instrument: opportunity.instrument,
        horizonDays: days,
        primary,
        referenceOpenTime: measured.referenceOpenTime,
        roundTripBps,
        entryZone: measured.entryZone,
        outcome,
        btc: horizonOf(benchmark, days),
        equalWeight: {
          members,
          available: available.length,
          meanGrossChangePct: mean(available.map((item) => item.grossChangePct!)),
          meanNetChangePct: mean(available.map((item) => item.netChangePct!)),
          outcomes: Object.fromEntries(
            memberOutcomes.map(([ticker, item]) => [
              ticker,
              {
                status: item.status,
                grossChangePct: item.grossChangePct,
                netChangePct: item.netChangePct,
              },
            ]),
          ),
        },
        candles: Object.fromEntries(
          [...fetched].map(([ticker, candles]) => [
            ticker,
            candles.filter(
              (candle) =>
                candle.openTime >= referenceOpenTime && candle.openTime <= endpointOpenTime,
            ),
          ]),
        ),
      };
      return { path, content: serialize(record) };
    });

    let conflicts = records.filter(
      ({ path, content }) => existing.has(path) && existing.get(path) !== content,
    ).length;
    await mkdir(outcomeDirectory, { recursive: true });
    for (const { path, content } of conflicts === 0 ? records : []) {
      try {
        const status = await createOrVerify(path, content, 'EVIDENCE_CONFLICT');
        summary[status === 'CREATED' ? 'created' : 'unchanged'] += 1;
      } catch (error) {
        if (!(error instanceof OpportunityCampaignError) || error.code !== 'EVIDENCE_CONFLICT') {
          throw error;
        }
        conflicts += 1;
      }
    }
    if (conflicts > 0) {
      // Every detection is kept, so the decision gate's zero-conflict condition can see it.
      const detectedAt = new Date(now).toISOString();
      const receipt: OpportunityOutcomeConflict = {
        schemaVersion: '1',
        evidenceType: 'opportunity-radar-outcome-conflict',
        slot: entry.slot,
        detectedAt,
        records: conflicts,
      };
      await mkdir(resolve(outcomeDirectory, 'conflicts'), { recursive: true });
      await createOrVerify(
        resolve(
          outcomeDirectory,
          'conflicts',
          `${detectedAt.replaceAll(':', '-')}-${randomUUID()}.json`,
        ),
        serialize(receipt),
        'EVIDENCE_CONFLICT',
      );
      summary.conflicts += conflicts;
    }
  }
  return summary;
}

export interface OpportunityOutcomeConflict {
  schemaVersion: '1';
  evidenceType: 'opportunity-radar-outcome-conflict';
  slot: string;
  detectedAt: string;
  /** Records whose re-measurement differed from the immutable file. */
  records: number;
}

/** Every outcome record and the total conflicting records ever detected for the campaign. */
export async function loadOpportunityOutcomes(
  directory: string,
  specificationId: string,
): Promise<{ records: OpportunityOutcomeRecord[]; conflicts: number }> {
  const root = resolve(directory, 'outcomes', specificationId);
  const list = (path: string) =>
    readdir(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [] as string[];
      throw error;
    });
  const records: OpportunityOutcomeRecord[] = [];
  let conflicts = 0;
  for (const slot of (await list(root)).sort()) {
    const slotDirectory = resolve(root, slot);
    for (const name of (await list(slotDirectory))
      .filter((item) => item.endsWith('.json'))
      .sort()) {
      records.push(
        JSON.parse(
          (await readIfPresent(resolve(slotDirectory, name)))!,
        ) as OpportunityOutcomeRecord,
      );
    }
    for (const name of (await list(resolve(slotDirectory, 'conflicts'))).filter((item) =>
      item.endsWith('.json'),
    )) {
      const receipt = JSON.parse(
        (await readIfPresent(resolve(slotDirectory, 'conflicts', name)))!,
      ) as OpportunityOutcomeConflict;
      conflicts += receipt.records;
    }
  }
  return { records, conflicts };
}
