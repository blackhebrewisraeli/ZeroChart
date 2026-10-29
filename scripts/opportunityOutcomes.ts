import type { Opportunity } from '@/lib/opportunityRadar';
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
