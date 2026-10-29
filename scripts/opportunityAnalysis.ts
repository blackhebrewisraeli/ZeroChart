import { compareTickers } from '@/lib/marketScanner';
import type { OpportunityOutcomeRecord } from './opportunityOutcomes';
import type { OpportunityRuntimeConfig } from './opportunitySpecification';

const DAY_MS = 86_400_000;

/** docs/opportunity-radar.v1.json `analysis.uncertainty`. */
export const OPPORTUNITY_BOOTSTRAP = {
  confidence: 0.9,
  blockDays: 20,
  resamples: 10_000,
  seed: 20261029,
  prng: 'mulberry32',
} as const;

export type OpportunityDecisionStatus = 'INSUFFICIENT' | 'FAIL' | 'PASS_FOR_OWNER_REVIEW';

/** Sample and integrity conditions: any of these makes the result INSUFFICIENT. */
export type OpportunityInsufficientReason =
  | 'CALENDAR_SLOTS_BELOW_MINIMUM'
  | 'MATURED_PRIMARY_OUTCOMES_BELOW_MINIMUM'
  | 'DISTINCT_ASSETS_BELOW_MINIMUM'
  | 'DISTINCT_MONTHS_BELOW_MINIMUM'
  | 'SINGLE_ASSET_SHARE_ABOVE_MAXIMUM'
  | 'COMPLETED_SLOTS_BELOW_MINIMUM'
  | 'COMPLETED_SLOTS_NOT_ALL_REPRODUCED'
  | 'EVIDENCE_CONFLICTS';

/** Primary signal conditions, judged only once the sample and integrity gate is met. */
export type OpportunityFailReason =
  | 'MEAN_NET_NOT_POSITIVE'
  | 'MEDIAN_NET_NOT_POSITIVE'
  | 'MEAN_EXCESS_VS_BTC_NOT_POSITIVE'
  | 'MEAN_EXCESS_VS_EQUAL_WEIGHT_NOT_POSITIVE'
  | 'BOOTSTRAP_LOWER_BOUND_NOT_POSITIVE';

export interface OpportunityIntegrity {
  /** Calendar slots whose retry deadline has passed. */
  calendarSlots: number;
  completedSlots: number;
  /** Completed slots whose latest offline reproduction of their current bytes is MATCH. */
  reproducedSlots: number;
  conflicts: number;
}

export interface OpportunityHorizonSummary {
  horizonDays: number;
  matured: number;
  available: number;
  meanNetChangePct: number | null;
  medianNetChangePct: number | null;
  /** Net change minus the benchmark's gross change over identical timestamps. */
  meanExcessVsBtcPp: number | null;
  meanExcessVsEqualWeightPp: number | null;
  fractionPositive: number | null;
  fractionAboveBtc: number | null;
  fractionAboveEqualWeight: number | null;
  meanMaxFavorableExcursionPct: number | null;
  meanMaxAdverseExcursionPct: number | null;
  invalidationTouchedFraction: number | null;
}

export interface OpportunityBootstrapInterval {
  lower: number | null;
  upper: number | null;
  observations: number;
  calendarDays: number;
  /** Resamples whose drawn days held no observation; excluded from the percentiles. */
  emptyResamples: number;
}

export interface OpportunityAnalysis {
  status: OpportunityDecisionStatus;
  reasons: Array<OpportunityInsufficientReason | OpportunityFailReason>;
  gate: {
    calendarSlots: number;
    maturedPrimaryOutcomes: number;
    distinctAssets: number;
    distinctOpportunityMonths: number;
    maximumSingleAssetShare: number;
    completedSlotFraction: number;
    allCompletedSlotsReproduced: boolean;
    conflicts: number;
  };
  /** Null until the sample and integrity gate is met: no interim performance exists. */
  performance: {
    primary: OpportunityHorizonSummary & { bootstrapExcessVsBtc: OpportunityBootstrapInterval };
    horizons: OpportunityHorizonSummary[];
    entryZoneEnteredFraction: number | null;
  } | null;
}

/** mulberry32: a small, fully specified 32-bit PRNG returning values in [0, 1). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Linear-interpolation quantile (Hyndman–Fan type 7) of an ascending array. */
function quantile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const h = (sorted.length - 1) * p;
  const lower = Math.floor(h);
  const upper = Math.min(lower + 1, sorted.length - 1);
  return sorted[lower]! + (h - lower) * (sorted[upper]! - sorted[lower]!);
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function fraction(values: readonly boolean[]): number | null {
  return values.length === 0 ? null : values.filter(Boolean).length / values.length;
}

/**
 * Moving-block bootstrap of the mean over opportunity dates. The timeline is
 * every UTC day from the first to the last observation; each resample
 * concatenates uniformly drawn `blockDays` windows until it spans as many days
 * as the timeline. Input order never matters: observations are sorted by date
 * and id before any draw or sum.
 */
export function movingBlockBootstrap(
  observations: ReadonlyArray<{ date: string; id: string; value: number }>,
  options: {
    confidence: number;
    blockDays: number;
    resamples: number;
    seed: number;
  } = OPPORTUNITY_BOOTSTRAP,
): OpportunityBootstrapInterval {
  if (observations.length === 0) {
    return { lower: null, upper: null, observations: 0, calendarDays: 0, emptyResamples: 0 };
  }
  const sorted = [...observations].sort(
    (a, b) => compareTickers(a.date, b.date) || compareTickers(a.id, b.id),
  );
  const first = Date.parse(`${sorted[0]!.date}T00:00:00.000Z`) / DAY_MS;
  const days = Date.parse(`${sorted.at(-1)!.date}T00:00:00.000Z`) / DAY_MS - first + 1;
  const byDay: number[][] = Array.from({ length: days }, () => []);
  for (const item of sorted) {
    byDay[Date.parse(`${item.date}T00:00:00.000Z`) / DAY_MS - first]!.push(item.value);
  }
  const blockDays = Math.min(options.blockDays, days);
  const starts = days - blockDays + 1;
  const blocks = Math.ceil(days / blockDays);
  const random = mulberry32(options.seed);
  const means: number[] = [];
  let emptyResamples = 0;
  for (let resample = 0; resample < options.resamples; resample += 1) {
    let sum = 0;
    let count = 0;
    let remaining = days;
    for (let block = 0; block < blocks; block += 1) {
      const start = Math.floor(random() * starts);
      const take = Math.min(blockDays, remaining);
      for (let day = start; day < start + take; day += 1) {
        for (const value of byDay[day]!) {
          sum += value;
          count += 1;
        }
      }
      remaining -= take;
    }
    if (count === 0) emptyResamples += 1;
    else means.push(sum / count);
  }
  means.sort((a, b) => a - b);
  const tail = (1 - options.confidence) / 2;
  return {
    lower: quantile(means, tail),
    upper: quantile(means, 1 - tail),
    observations: sorted.length,
    calendarDays: days,
    emptyResamples,
  };
}

function available(records: readonly OpportunityOutcomeRecord[]) {
  return records.filter((record) => record.outcome.status === 'AVAILABLE');
}

function excessVsBtc(record: OpportunityOutcomeRecord): number | null {
  return record.btc.status === 'AVAILABLE'
    ? record.outcome.netChangePct! - record.btc.grossChangePct!
    : null;
}

function excessVsEqualWeight(record: OpportunityOutcomeRecord): number | null {
  return record.equalWeight.meanGrossChangePct === null
    ? null
    : record.outcome.netChangePct! - record.equalWeight.meanGrossChangePct;
}

function summarize(
  horizonDays: number,
  records: readonly OpportunityOutcomeRecord[],
): OpportunityHorizonSummary {
  const measured = available(records);
  const nets = measured.map((record) => record.outcome.netChangePct!);
  const btc = measured.flatMap((record) => excessVsBtc(record) ?? []);
  const equalWeight = measured.flatMap((record) => excessVsEqualWeight(record) ?? []);
  return {
    horizonDays,
    matured: records.length,
    available: measured.length,
    meanNetChangePct: mean(nets),
    medianNetChangePct: quantile(
      [...nets].sort((a, b) => a - b),
      0.5,
    ),
    meanExcessVsBtcPp: mean(btc),
    meanExcessVsEqualWeightPp: mean(equalWeight),
    fractionPositive: fraction(nets.map((value) => value > 0)),
    fractionAboveBtc: fraction(btc.map((value) => value > 0)),
    fractionAboveEqualWeight: fraction(equalWeight.map((value) => value > 0)),
    meanMaxFavorableExcursionPct: mean(
      measured.map((record) => record.outcome.maxFavorableExcursionPct!),
    ),
    meanMaxAdverseExcursionPct: mean(
      measured.map((record) => record.outcome.maxAdverseExcursionPct!),
    ),
    invalidationTouchedFraction: fraction(
      measured.map((record) => record.outcome.invalidationTouchedAt !== null),
    ),
  };
}

/**
 * The preregistered decision gate, pure and side-effect free. Only primary
 * horizon records decide the result; secondary horizons are summarized after
 * the gate is met and never change it.
 */
export function analyzeOpportunityCampaign(input: {
  records: readonly OpportunityOutcomeRecord[];
  integrity: OpportunityIntegrity;
  gate: OpportunityRuntimeConfig['decisionGate'];
  primaryHorizonDays: number;
}): OpportunityAnalysis {
  const { gate, integrity } = input;
  const records = [...input.records].sort(
    (a, b) =>
      compareTickers(a.slot, b.slot) ||
      compareTickers(a.opportunityId, b.opportunityId) ||
      a.horizonDays - b.horizonDays,
  );
  const primary = records.filter((record) => record.horizonDays === input.primaryHorizonDays);
  const measured = available(primary);
  const perAsset = new Map<string, number>();
  for (const record of measured)
    perAsset.set(record.ticker, (perAsset.get(record.ticker) ?? 0) + 1);
  const gateValues: OpportunityAnalysis['gate'] = {
    calendarSlots: integrity.calendarSlots,
    maturedPrimaryOutcomes: measured.length,
    distinctAssets: perAsset.size,
    distinctOpportunityMonths: new Set(measured.map((record) => record.slot.slice(0, 7))).size,
    maximumSingleAssetShare:
      measured.length === 0 ? 0 : Math.max(...perAsset.values()) / measured.length,
    completedSlotFraction:
      integrity.calendarSlots === 0 ? 0 : integrity.completedSlots / integrity.calendarSlots,
    allCompletedSlotsReproduced: integrity.reproducedSlots === integrity.completedSlots,
    conflicts: integrity.conflicts,
  };

  const insufficient: OpportunityInsufficientReason[] = [];
  if (gateValues.calendarSlots < gate.minimumCalendarSlots) {
    insufficient.push('CALENDAR_SLOTS_BELOW_MINIMUM');
  }
  if (gateValues.maturedPrimaryOutcomes < gate.minimumMaturedPrimaryOutcomes) {
    insufficient.push('MATURED_PRIMARY_OUTCOMES_BELOW_MINIMUM');
  }
  if (gateValues.distinctAssets < gate.minimumDistinctAssets) {
    insufficient.push('DISTINCT_ASSETS_BELOW_MINIMUM');
  }
  if (gateValues.distinctOpportunityMonths < gate.minimumDistinctOpportunityMonths) {
    insufficient.push('DISTINCT_MONTHS_BELOW_MINIMUM');
  }
  if (gateValues.maximumSingleAssetShare > gate.maximumSingleAssetShare) {
    insufficient.push('SINGLE_ASSET_SHARE_ABOVE_MAXIMUM');
  }
  // Whole percent in integers, so 171 of 180 is exactly 95%.
  if (
    integrity.calendarSlots === 0 ||
    integrity.completedSlots * 100 <
      Math.round(gate.minimumCompletedSlotFraction * 100) * integrity.calendarSlots
  ) {
    insufficient.push('COMPLETED_SLOTS_BELOW_MINIMUM');
  }
  if (!gateValues.allCompletedSlotsReproduced)
    insufficient.push('COMPLETED_SLOTS_NOT_ALL_REPRODUCED');
  if (integrity.conflicts > 0) insufficient.push('EVIDENCE_CONFLICTS');
  if (insufficient.length > 0) {
    return { status: 'INSUFFICIENT', reasons: insufficient, gate: gateValues, performance: null };
  }

  const horizons = [...new Set(records.map((record) => record.horizonDays))]
    .sort((a, b) => a - b)
    .map((days) =>
      summarize(
        days,
        records.filter((record) => record.horizonDays === days),
      ),
    );
  const bootstrapExcessVsBtc = movingBlockBootstrap(
    measured.flatMap((record) => {
      const value = excessVsBtc(record);
      return value === null
        ? []
        : [{ date: record.slot.slice(0, 10), id: record.opportunityId, value }];
    }),
  );
  const primarySummary = { ...summarize(input.primaryHorizonDays, primary), bootstrapExcessVsBtc };
  const resolvedEntry = primary.filter(
    (record) => record.entryZone.status === 'ENTERED' || record.entryZone.status === 'NOT_ENTERED',
  );

  const failed: OpportunityFailReason[] = [];
  const positive = (value: number | null) => value !== null && value > 0;
  if (!positive(primarySummary.meanNetChangePct)) failed.push('MEAN_NET_NOT_POSITIVE');
  if (!positive(primarySummary.medianNetChangePct)) failed.push('MEDIAN_NET_NOT_POSITIVE');
  if (!positive(primarySummary.meanExcessVsBtcPp)) failed.push('MEAN_EXCESS_VS_BTC_NOT_POSITIVE');
  if (!positive(primarySummary.meanExcessVsEqualWeightPp)) {
    failed.push('MEAN_EXCESS_VS_EQUAL_WEIGHT_NOT_POSITIVE');
  }
  if (!positive(bootstrapExcessVsBtc.lower)) failed.push('BOOTSTRAP_LOWER_BOUND_NOT_POSITIVE');
  return {
    status: failed.length === 0 ? 'PASS_FOR_OWNER_REVIEW' : 'FAIL',
    reasons: failed,
    gate: gateValues,
    performance: {
      primary: primarySummary,
      horizons,
      entryZoneEnteredFraction: fraction(
        resolvedEntry.map((record) => record.entryZone.status === 'ENTERED'),
      ),
    },
  };
}
