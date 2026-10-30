import type { Candle } from '@/lib/binance';
import type { MarketRegime } from '@/lib/canonicalModel';
import { validateBinanceDailyCandles } from '@/lib/candleValidation';
import { sma } from '@/lib/indicators';
import {
  evaluateScan,
  type MarketScan,
  type ScanAssetStatus,
  type ScanInput,
} from '@/lib/marketScanner';

const DAY_MS = 86_400_000;

export interface OpportunityDecisionConfig {
  specificationId: string;
  studyId: string;
  universe: readonly { ticker: string; instrument: string }[];
  indicators: { smaFast: number; smaSlow: number };
  candidate: {
    minimumScore: number;
    minimumMomentumPercent: number;
    excludeHighVolatility: boolean;
    requireCloseAboveFastSma: boolean;
    requireFastSmaAboveSlowSma: boolean;
  };
  marketGate: {
    benchmark: string;
    excludeHighVolatility: boolean;
    requireCloseAboveSlowSma: boolean;
    requireFastSmaAboveSlowSma: boolean;
  };
  opportunity: {
    entryZoneAtrBelowClose: number;
    entryZoneAtrAboveClose: number;
    invalidationAtrBelowClose: number;
    validDailyOpens: number;
    primaryHorizonDays: number;
    secondaryHorizonDays: readonly number[];
  };
}

export interface OpportunitySnapshot {
  ticker: string;
  instrument: string;
  scannerStatus: ScanAssetStatus;
  closedCandles: number;
  rank: number | null;
  close: number | null;
  atr: number | null;
  smaFast: number | null;
  smaSlow: number | null;
  score: number | null;
  momentumPercent: number | null;
  regime: MarketRegime | null;
}

export type OpportunityMarketGateReason =
  | 'MARKET_NOT_EVALUATED'
  | 'MARKET_INSUFFICIENT_HISTORY'
  | 'MARKET_CLOSE_NOT_ABOVE_SLOW_SMA'
  | 'MARKET_FAST_SMA_NOT_ABOVE_SLOW_SMA'
  | 'MARKET_HIGH_VOLATILITY';

export type OpportunityCandidateReason =
  | 'SCANNER_NOT_EVALUATED'
  | 'INSUFFICIENT_HISTORY'
  | 'MARKET_GATE_CLOSED'
  | 'CLOSE_NOT_ABOVE_FAST_SMA'
  | 'FAST_SMA_NOT_ABOVE_SLOW_SMA'
  | 'SCORE_BELOW_MINIMUM'
  | 'MOMENTUM_BELOW_MINIMUM'
  | 'HIGH_VOLATILITY';

export interface OpportunityAssetDecision extends OpportunitySnapshot {
  qualified: boolean;
  reasons: OpportunityCandidateReason[];
  newTransition: boolean;
}

export interface Opportunity {
  id: string;
  specificationId: string;
  evaluationTime: number;
  ticker: string;
  instrument: string;
  rank: number | null;
  score: number;
  regime: MarketRegime;
  momentumPercent: number;
  anchorClose: number;
  atr: number;
  entryZone: { low: number; high: number };
  invalidation: number;
  validDailyOpens: number;
  expiresAt: number;
  primaryHorizonDays: number;
  secondaryHorizonDays: number[];
}

export interface PreviousOpportunitySlot {
  status: 'COMPLETE' | 'PARTIAL' | 'FAILED';
  qualifiedTickers: readonly string[];
}

export interface OpportunityDecisionResult {
  specificationId: string;
  evaluationTime: number;
  marketGate: { passed: boolean; reasons: OpportunityMarketGateReason[] };
  assets: OpportunityAssetDecision[];
  opportunities: Opportunity[];
}

export interface OpportunitySlotResult extends OpportunityDecisionResult {
  scan: MarketScan;
}

function finite(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

function hasDecisionMetrics(snapshot: OpportunitySnapshot): boolean {
  return (
    finite(snapshot.close) &&
    finite(snapshot.atr) &&
    finite(snapshot.smaFast) &&
    finite(snapshot.smaSlow) &&
    finite(snapshot.score) &&
    finite(snapshot.momentumPercent) &&
    snapshot.regime !== null
  );
}

function marketGateOf(
  snapshots: readonly OpportunitySnapshot[],
  config: OpportunityDecisionConfig,
): OpportunityDecisionResult['marketGate'] {
  const benchmark = snapshots.find((snapshot) => snapshot.ticker === config.marketGate.benchmark);
  if (!benchmark || benchmark.scannerStatus !== 'EVALUATED') {
    return { passed: false, reasons: ['MARKET_NOT_EVALUATED'] };
  }
  const required = Math.max(config.indicators.smaFast, config.indicators.smaSlow);
  if (benchmark.closedCandles < required || !hasDecisionMetrics(benchmark)) {
    return { passed: false, reasons: ['MARKET_INSUFFICIENT_HISTORY'] };
  }

  const reasons: OpportunityMarketGateReason[] = [];
  if (config.marketGate.requireCloseAboveSlowSma && benchmark.close! <= benchmark.smaSlow!) {
    reasons.push('MARKET_CLOSE_NOT_ABOVE_SLOW_SMA');
  }
  if (config.marketGate.requireFastSmaAboveSlowSma && benchmark.smaFast! <= benchmark.smaSlow!) {
    reasons.push('MARKET_FAST_SMA_NOT_ABOVE_SLOW_SMA');
  }
  if (config.marketGate.excludeHighVolatility && benchmark.regime === 'HIGH_VOLATILITY') {
    reasons.push('MARKET_HIGH_VOLATILITY');
  }
  return { passed: reasons.length === 0, reasons };
}

function candidateReasons(
  snapshot: OpportunitySnapshot,
  marketGatePassed: boolean,
  config: OpportunityDecisionConfig,
): OpportunityCandidateReason[] {
  if (snapshot.scannerStatus !== 'EVALUATED') return ['SCANNER_NOT_EVALUATED'];
  const required = Math.max(config.indicators.smaFast, config.indicators.smaSlow);
  if (snapshot.closedCandles < required || !hasDecisionMetrics(snapshot)) {
    return ['INSUFFICIENT_HISTORY'];
  }
  if (!marketGatePassed) return ['MARKET_GATE_CLOSED'];

  const reasons: OpportunityCandidateReason[] = [];
  if (config.candidate.requireCloseAboveFastSma && snapshot.close! <= snapshot.smaFast!) {
    reasons.push('CLOSE_NOT_ABOVE_FAST_SMA');
  }
  if (config.candidate.requireFastSmaAboveSlowSma && snapshot.smaFast! <= snapshot.smaSlow!) {
    reasons.push('FAST_SMA_NOT_ABOVE_SLOW_SMA');
  }
  if (snapshot.score! < config.candidate.minimumScore) reasons.push('SCORE_BELOW_MINIMUM');
  if (snapshot.momentumPercent! < config.candidate.minimumMomentumPercent) {
    reasons.push('MOMENTUM_BELOW_MINIMUM');
  }
  if (config.candidate.excludeHighVolatility && snapshot.regime === 'HIGH_VOLATILITY') {
    reasons.push('HIGH_VOLATILITY');
  }
  return reasons;
}

function opportunityOf(
  decision: OpportunityAssetDecision,
  config: OpportunityDecisionConfig,
  evaluationTime: number,
): Opportunity {
  const close = decision.close!;
  const atr = decision.atr!;
  return {
    id: `${new Date(evaluationTime).toISOString()}|${decision.ticker}`,
    specificationId: config.specificationId,
    evaluationTime,
    ticker: decision.ticker,
    instrument: decision.instrument,
    rank: decision.rank,
    score: decision.score!,
    regime: decision.regime!,
    momentumPercent: decision.momentumPercent!,
    anchorClose: close,
    atr,
    entryZone: {
      low: close - config.opportunity.entryZoneAtrBelowClose * atr,
      high: close + config.opportunity.entryZoneAtrAboveClose * atr,
    },
    invalidation: close - config.opportunity.invalidationAtrBelowClose * atr,
    validDailyOpens: config.opportunity.validDailyOpens,
    expiresAt: evaluationTime + config.opportunity.validDailyOpens * DAY_MS,
    primaryHorizonDays: config.opportunity.primaryHorizonDays,
    secondaryHorizonDays: [...config.opportunity.secondaryHorizonDays],
  };
}

/** Pure candidate and false→true transition evaluation over already-derived snapshots. */
export function evaluateOpportunityDecisions(
  snapshots: readonly OpportunitySnapshot[],
  config: OpportunityDecisionConfig,
  evaluationTime: number,
  previous?: PreviousOpportunitySlot,
): OpportunityDecisionResult {
  const marketGate = marketGateOf(snapshots, config);
  const comparablePrevious = previous?.status === 'COMPLETE';
  const previouslyQualified = new Set(previous?.qualifiedTickers ?? []);
  const assets = snapshots.map((snapshot): OpportunityAssetDecision => {
    const reasons = candidateReasons(snapshot, marketGate.passed, config);
    const qualified = reasons.length === 0;
    return {
      ...snapshot,
      qualified,
      reasons,
      newTransition: Boolean(
        comparablePrevious && qualified && !previouslyQualified.has(snapshot.ticker),
      ),
    };
  });
  return {
    specificationId: config.specificationId,
    evaluationTime,
    marketGate,
    assets,
    opportunities: assets
      .filter((asset) => asset.newTransition)
      .map((asset) => opportunityOf(asset, config, evaluationTime)),
  };
}

function lastFinite(values: Float64Array): number | null {
  const value = values.at(-1);
  return value !== undefined && Number.isFinite(value) ? value : null;
}

function snapshotOf(
  input: ScanInput,
  scan: MarketScan,
  config: OpportunityDecisionConfig,
  evaluationTime: number,
): OpportunitySnapshot {
  const scanned = scan.results.find((result) => result.ticker === input.ticker);
  const configured = config.universe.find((member) => member.ticker === input.ticker);
  const validation = validateBinanceDailyCandles(input.candles ?? ([] as Candle[]), {
    evaluationTime,
    modelWindow: Math.max(config.indicators.smaFast, config.indicators.smaSlow),
  });
  const closes = validation.structurallyValid
    ? validation.closed.map((candle) => candle.close)
    : [];
  return {
    ticker: input.ticker,
    instrument: configured?.instrument ?? input.instrument ?? '',
    scannerStatus: scanned?.status ?? 'FETCH_FAILED',
    closedCandles: validation.closed.length,
    rank: scanned?.rank ?? null,
    close: scanned?.model?.close ?? null,
    atr: scanned?.model?.atr ?? null,
    smaFast: lastFinite(sma(closes, config.indicators.smaFast)),
    smaSlow: lastFinite(sma(closes, config.indicators.smaSlow)),
    score: scanned?.model?.signal_score ?? null,
    momentumPercent: scanned?.model?.inputs.momentumPercent ?? null,
    regime: scanned?.model?.regime ?? null,
  };
}

/** Pure adapter from collected scanner inputs to one reproducible Opportunity slot. */
export function evaluateOpportunitySlot(
  inputs: readonly ScanInput[],
  config: OpportunityDecisionConfig,
  evaluationTime: number,
  previous?: PreviousOpportunitySlot,
): OpportunitySlotResult {
  const scan = evaluateScan(inputs, {
    evaluationTime,
    universeSource: config.studyId,
  });
  const inputsByTicker = new Map(inputs.map((input) => [input.ticker, input]));
  const snapshots = scan.results.flatMap((result) => {
    const input = inputsByTicker.get(result.ticker);
    return input ? [snapshotOf(input, scan, config, evaluationTime)] : [];
  });
  return {
    scan,
    ...evaluateOpportunityDecisions(snapshots, config, evaluationTime, previous),
  };
}
