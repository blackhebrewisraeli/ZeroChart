import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stableSerialize } from './evaluationStore';

export const OPPORTUNITY_SPECIFICATION_ID =
  '0eddcc4f81ba47d74168392bb50af64050d3a9db2ab56da914c3814087d64483';

export type OpportunitySpecificationErrorCode =
  'READ_FAILED' | 'INVALID_SCHEMA' | 'IDENTIFIER_MISMATCH' | 'UNSUPPORTED_SPECIFICATION';

export class OpportunitySpecificationError extends Error {
  constructor(
    readonly code: OpportunitySpecificationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OpportunitySpecificationError';
  }
}

export interface OpportunityUniverseMember {
  ticker: string;
  instrument: string;
}

export interface OpportunityRuntimeConfig {
  specificationId: typeof OPPORTUNITY_SPECIFICATION_ID;
  studyId: 'zerochart-opportunity-radar-binance-spot-v1';
  universe: OpportunityUniverseMember[];
  schedule: { primarySlot: string; retryDeadline: string };
  indicators: { smaFast: number; smaSlow: number };
  candidate: {
    minimumScore: 78;
    minimumMomentumPercent: 0.0005;
    excludeHighVolatility: true;
    requireCloseAboveFastSma: true;
    requireFastSmaAboveSlowSma: true;
  };
  marketGate: {
    benchmark: string;
    excludeHighVolatility: true;
    requireCloseAboveSlowSma: true;
    requireFastSmaAboveSlowSma: true;
  };
  opportunity: {
    entryZoneAtrBelowClose: 0.5;
    entryZoneAtrAboveClose: 0.25;
    invalidationAtrBelowClose: 2;
    validDailyOpens: number;
    primaryHorizonDays: number;
    secondaryHorizonDays: number[];
  };
  costs: {
    entryFeeBps: number;
    exitFeeBps: number;
    entrySlippageBps: number;
    exitSlippageBps: number;
    roundTripBps: number;
  };
  decisionGate: {
    minimumCalendarSlots: number;
    minimumMaturedPrimaryOutcomes: number;
    minimumDistinctAssets: number;
    minimumDistinctOpportunityMonths: number;
    maximumSingleAssetShare: number;
    minimumCompletedSlotFraction: 0.95;
  };
}

export interface LoadedOpportunitySpecification {
  specification: Record<string, unknown> & {
    specificationId: typeof OPPORTUNITY_SPECIFICATION_ID;
  };
  runtime: OpportunityRuntimeConfig;
}

function invalid(label: string): never {
  throw new OpportunitySpecificationError(
    'INVALID_SCHEMA',
    `Invalid Opportunity Radar specification: ${label}`,
  );
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(label);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) invalid(label);
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(label);
  return value;
}

function numberArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) invalid(label);
  return value.map((entry, index) => numberValue(entry, `${label}[${index}]`));
}

function members(value: unknown): OpportunityUniverseMember[] {
  if (!Array.isArray(value) || value.length === 0) invalid('universe.members');
  return value.map((entry, index) => {
    const member = record(entry, `universe.members[${index}]`);
    return {
      ticker: stringValue(member['ticker'], `universe.members[${index}].ticker`),
      instrument: stringValue(member['instrument'], `universe.members[${index}].instrument`),
    };
  });
}

/** SHA-256 of canonical content after removing the self-referential identifier field. */
export function computeOpportunitySpecificationId(value: unknown): string {
  const specification = record(value, 'root');
  const { specificationId: _specificationId, ...content } = specification;
  return createHash('sha256').update(stableSerialize(content)).digest('hex');
}

/** Validate the immutable contract and extract only the decisions runtime code needs. */
export function parseOpportunitySpecification(value: unknown): LoadedOpportunitySpecification {
  const specification = record(value, 'root');
  if (specification['schemaVersion'] !== '1') {
    throw new OpportunitySpecificationError(
      'UNSUPPORTED_SPECIFICATION',
      `Unsupported Opportunity Radar schema: ${String(specification['schemaVersion'])}`,
    );
  }
  const studyId = stringValue(specification['studyId'], 'studyId');
  if (studyId !== 'zerochart-opportunity-radar-binance-spot-v1') {
    throw new OpportunitySpecificationError(
      'UNSUPPORTED_SPECIFICATION',
      `Unsupported Opportunity Radar study: ${studyId}`,
    );
  }

  const universe = record(specification['universe'], 'universe');
  const frozenMembers = members(universe['members']);
  const schedule = record(specification['schedule'], 'schedule');
  const indicators = record(specification['indicators'], 'indicators');
  const marketGate = record(specification['marketGate'], 'marketGate');
  const opportunity = record(specification['opportunity'], 'opportunity');
  const entryZone = record(opportunity['entryZone'], 'opportunity.entryZone');
  const horizons = record(opportunity['horizonCalendarDays'], 'opportunity.horizonCalendarDays');
  const outcomes = record(specification['outcomes'], 'outcomes');
  const costs = record(outcomes['costModel'], 'outcomes.costModel');
  const checkpoints = record(specification['checkpoints'], 'checkpoints');
  const decisionGate = record(checkpoints['decisionGate'], 'checkpoints.decisionGate');
  const declaredId = stringValue(specification['specificationId'], 'specificationId');
  const computedId = computeOpportunitySpecificationId(specification);
  if (declaredId !== computedId) {
    throw new OpportunitySpecificationError(
      'IDENTIFIER_MISMATCH',
      `Opportunity Radar specification identifier mismatch: expected ${declaredId}, computed ${computedId}`,
    );
  }
  if (declaredId !== OPPORTUNITY_SPECIFICATION_ID) {
    throw new OpportunitySpecificationError(
      'UNSUPPORTED_SPECIFICATION',
      `Unsupported Opportunity Radar specification: ${declaredId}`,
    );
  }

  const runtime: OpportunityRuntimeConfig = {
    specificationId: OPPORTUNITY_SPECIFICATION_ID,
    studyId,
    universe: frozenMembers,
    schedule: {
      primarySlot: stringValue(schedule['primarySlot'], 'schedule.primarySlot'),
      retryDeadline: stringValue(schedule['retryDeadline'], 'schedule.retryDeadline'),
    },
    indicators: {
      smaFast: numberValue(indicators['smaFast'], 'indicators.smaFast'),
      smaSlow: numberValue(indicators['smaSlow'], 'indicators.smaSlow'),
    },
    candidate: {
      minimumScore: 78,
      minimumMomentumPercent: 0.0005,
      excludeHighVolatility: true,
      requireCloseAboveFastSma: true,
      requireFastSmaAboveSlowSma: true,
    },
    marketGate: {
      benchmark: stringValue(marketGate['benchmark'], 'marketGate.benchmark'),
      excludeHighVolatility: true,
      requireCloseAboveSlowSma: true,
      requireFastSmaAboveSlowSma: true,
    },
    opportunity: {
      entryZoneAtrBelowClose: 0.5,
      entryZoneAtrAboveClose: 0.25,
      invalidationAtrBelowClose: 2,
      validDailyOpens: numberValue(entryZone['validDailyOpens'], 'entryZone.validDailyOpens'),
      primaryHorizonDays: numberValue(horizons['primary'], 'horizonCalendarDays.primary'),
      secondaryHorizonDays: numberArray(horizons['secondary'], 'horizonCalendarDays.secondary'),
    },
    costs: {
      entryFeeBps: numberValue(costs['entryFeeBps'], 'costModel.entryFeeBps'),
      exitFeeBps: numberValue(costs['exitFeeBps'], 'costModel.exitFeeBps'),
      entrySlippageBps: numberValue(costs['entrySlippageBps'], 'costModel.entrySlippageBps'),
      exitSlippageBps: numberValue(costs['exitSlippageBps'], 'costModel.exitSlippageBps'),
      roundTripBps: numberValue(costs['roundTripBps'], 'costModel.roundTripBps'),
    },
    decisionGate: {
      minimumCalendarSlots: numberValue(
        decisionGate['minimumCalendarSlots'],
        'decisionGate.minimumCalendarSlots',
      ),
      minimumMaturedPrimaryOutcomes: numberValue(
        decisionGate['minimumMaturedPrimaryOutcomes'],
        'decisionGate.minimumMaturedPrimaryOutcomes',
      ),
      minimumDistinctAssets: numberValue(
        decisionGate['minimumDistinctAssets'],
        'decisionGate.minimumDistinctAssets',
      ),
      minimumDistinctOpportunityMonths: numberValue(
        decisionGate['minimumDistinctOpportunityMonths'],
        'decisionGate.minimumDistinctOpportunityMonths',
      ),
      maximumSingleAssetShare: numberValue(
        decisionGate['maximumSingleAssetShare'],
        'decisionGate.maximumSingleAssetShare',
      ),
      minimumCompletedSlotFraction: 0.95,
    },
  };
  return {
    specification: specification as LoadedOpportunitySpecification['specification'],
    runtime,
  };
}

export async function loadOpportunitySpecification(
  path = 'docs/opportunity-radar.v1.json',
): Promise<LoadedOpportunitySpecification> {
  try {
    return parseOpportunitySpecification(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch (error) {
    if (error instanceof OpportunitySpecificationError) throw error;
    throw new OpportunitySpecificationError(
      'READ_FAILED',
      `Could not read Opportunity Radar specification: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
