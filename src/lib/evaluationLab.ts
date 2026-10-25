import {
  CANONICAL_MODEL_VERSION,
  MIN_CANDLES,
  type CanonicalScore,
  type EngineCandle,
  evaluateCandles,
} from '@/lib/canonicalModel';
import { ASSET_COUNT_BY_RISK, type RiskProfile } from '@/lib/portfolioBuilder';
import { RISK_PROFILE_POLICIES, qualifiesForRiskProfile } from '@/lib/roboAdvisor';

export const EVALUATION_STRATEGY_VERSION = 'canonical-portfolio-v1';
export const DAILY_TIMEFRAME = '1d';
export const DEFAULT_MAX_DATA_AGE_MS = 48 * 60 * 60 * 1000;
export const DEFAULT_TOTAL_CAPITAL = 100_000;

export type DecisionStatus =
  | 'ELIGIBLE'
  | 'DATA_UNAVAILABLE'
  | 'DATA_FETCH_FAILED'
  | 'STALE_DATA'
  | 'INSUFFICIENT_HISTORY'
  | 'BELOW_MINIMUM_SCORE'
  | 'HIGH_VOLATILITY'
  | 'NON_POSITIVE_MOMENTUM';

export type ProposedAction = 'PROPOSE_ALLOCATION' | 'REJECT';

export interface EvaluationConfig {
  strategyVersion: string;
  modelVersion: string;
  universe: readonly string[];
  timeframe: typeof DAILY_TIMEFRAME;
  riskProfile: RiskProfile;
  totalCapital: number;
  maxDataAgeMs: number;
  executionTiming: 'next_observation_after_closed_candle';
  costs: {
    feeBps: number;
    slippageBps: number;
  };
  exitBehavior: 'none_in_evaluation_lab';
  benchmark: 'not_applicable_without_executable_exits';
  assumptions: readonly string[];
  limitations: readonly string[];
  configurationId: string;
}

export interface EvaluationCandle extends EngineCandle {
  timestamp: number;
  closeTime: number;
}

export interface EvaluationAssetInput {
  ticker: string;
  source: string;
  timeframe: typeof DAILY_TIMEFRAME;
  candles: readonly EvaluationCandle[];
  error?: string;
}

export interface EvaluationInput {
  evaluationTime: number;
  assets: readonly EvaluationAssetInput[];
}

export interface RejectionReason {
  code: DecisionStatus;
  detail: string;
}

export interface DecisionSnapshot {
  logicalKey: string;
  evaluationTime: number;
  dataAsOf: number | null;
  asset: string;
  source: string;
  timeframe: typeof DAILY_TIMEFRAME;
  strategyVersion: string;
  modelVersion: string;
  configurationId: string;
  inputReference: string;
  inputSnapshot: readonly EvaluationCandle[];
  status: DecisionStatus;
  rejectionReasons: readonly RejectionReason[];
  proposedAction: ProposedAction;
  score: number | null;
  scoreComponents: CanonicalScore['components'] | null;
  regime: CanonicalScore['regime'] | null;
  rationale: string | null;
  close: number | null;
  atr: number | null;
  allocationWeight: number;
  allocatedAmount: number;
  observedInputCount: number;
}

export interface EvaluationRun {
  evaluationTime: number;
  configuration: EvaluationConfig;
  decisions: readonly DecisionSnapshot[];
  coverage: {
    assets: number;
    eligible: number;
    rejected: number;
    rejectionReasons: Readonly<Record<DecisionStatus, number>>;
  };
}

function rejection(code: DecisionStatus, detail: string): RejectionReason {
  return { code, detail };
}

function closedCandles(
  candles: readonly EvaluationCandle[],
  evaluationTime: number,
): EvaluationCandle[] {
  return candles
    .filter((candle) => candle.closeTime <= evaluationTime)
    .sort((a, b) => a.closeTime - b.closeTime);
}

function inputReference(asset: EvaluationAssetInput, candles: readonly EvaluationCandle[]): string {
  const first = candles[0]?.closeTime ?? null;
  const last = candles.at(-1)?.closeTime ?? null;
  return `${asset.source}:${asset.ticker}:${asset.timeframe}:${first ?? 'none'}-${last ?? 'none'}:${candles.length}`;
}

function emptyDecision(
  asset: EvaluationAssetInput,
  input: EvaluationInput,
  config: EvaluationConfig,
  candles: readonly EvaluationCandle[],
  status: DecisionStatus,
  detail: string,
): DecisionSnapshot {
  return {
    logicalKey: `${input.evaluationTime}:${asset.ticker}:${config.configurationId}`,
    evaluationTime: input.evaluationTime,
    dataAsOf: candles.at(-1)?.closeTime ?? null,
    asset: asset.ticker,
    source: asset.source,
    timeframe: asset.timeframe,
    strategyVersion: config.strategyVersion,
    modelVersion: config.modelVersion,
    configurationId: config.configurationId,
    inputReference: inputReference(asset, candles),
    inputSnapshot: candles,
    status,
    rejectionReasons: [rejection(status, detail)],
    proposedAction: 'REJECT',
    score: null,
    scoreComponents: null,
    regime: null,
    rationale: null,
    close: null,
    atr: null,
    allocationWeight: 0,
    allocatedAmount: 0,
    observedInputCount: candles.length,
  };
}

function scoredDecision(
  asset: EvaluationAssetInput,
  input: EvaluationInput,
  config: EvaluationConfig,
  candles: readonly EvaluationCandle[],
  result: CanonicalScore,
): DecisionSnapshot {
  const reasons: RejectionReason[] = [];
  const policy = RISK_PROFILE_POLICIES[config.riskProfile];
  if (policy.excludeHighVolatility && result.regime === 'HIGH_VOLATILITY') {
    reasons.push(rejection('HIGH_VOLATILITY', 'Risk profile excludes high-volatility regimes.'));
  }
  if (result.signal_score < policy.minimumScore) {
    reasons.push(
      rejection(
        'BELOW_MINIMUM_SCORE',
        `Score ${result.signal_score} is below the ${policy.minimumScore} minimum.`,
      ),
    );
  }
  if (policy.requirePositiveMomentum && result.components.momentumScore <= 50) {
    reasons.push(
      rejection('NON_POSITIVE_MOMENTUM', 'Aggressive profile requires positive momentum.'),
    );
  }
  const status = reasons[0]?.code ?? 'ELIGIBLE';
  return {
    logicalKey: `${input.evaluationTime}:${asset.ticker}:${config.configurationId}`,
    evaluationTime: input.evaluationTime,
    dataAsOf: candles.at(-1)?.closeTime ?? null,
    asset: asset.ticker,
    source: asset.source,
    timeframe: asset.timeframe,
    strategyVersion: config.strategyVersion,
    modelVersion: result.version,
    configurationId: config.configurationId,
    inputReference: inputReference(asset, candles),
    inputSnapshot: candles,
    status,
    rejectionReasons: reasons,
    proposedAction: status === 'ELIGIBLE' ? 'PROPOSE_ALLOCATION' : 'REJECT',
    score: result.signal_score,
    scoreComponents: result.components,
    regime: result.regime,
    rationale: result.rationale,
    close: result.close,
    atr: result.atr,
    allocationWeight: 0,
    allocatedAmount: 0,
    observedInputCount: candles.length,
  };
}

export function createEvaluationConfig(
  input: Omit<EvaluationConfig, 'configurationId'> & { configurationId?: string },
): EvaluationConfig {
  return {
    ...input,
    configurationId: input.configurationId ?? 'unhashed-configuration',
  };
}

export function evaluateInput(input: EvaluationInput, config: EvaluationConfig): EvaluationRun {
  const decisions = input.assets.map((asset) => {
    const closed = closedCandles(asset.candles, input.evaluationTime);
    if (asset.error) {
      return emptyDecision(
        asset,
        input,
        config,
        closed,
        'DATA_FETCH_FAILED',
        `Market-data fetch failed: ${asset.error}`,
      );
    }
    if (closed.length === 0) {
      return emptyDecision(
        asset,
        input,
        config,
        closed,
        'DATA_UNAVAILABLE',
        'No closed candles were supplied.',
      );
    }
    const dataAsOf = closed.at(-1)?.closeTime ?? input.evaluationTime;
    if (input.evaluationTime - dataAsOf > config.maxDataAgeMs) {
      return emptyDecision(
        asset,
        input,
        config,
        closed,
        'STALE_DATA',
        'Latest closed candle exceeds freshness policy.',
      );
    }
    if (closed.length < MIN_CANDLES) {
      return emptyDecision(
        asset,
        input,
        config,
        closed,
        'INSUFFICIENT_HISTORY',
        `Only ${closed.length} closed candles were available; ${MIN_CANDLES} are required.`,
      );
    }
    const result = evaluateCandles(closed);
    return result.status === 'OK'
      ? scoredDecision(asset, input, config, closed, result)
      : emptyDecision(
          asset,
          input,
          config,
          closed,
          'INSUFFICIENT_HISTORY',
          `The canonical model requires ${result.required} valid candles; ${result.received} were available.`,
        );
  });

  const eligible = decisions
    .filter((decision) => decision.status === 'ELIGIBLE')
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, ASSET_COUNT_BY_RISK[config.riskProfile]);
  const totalScore = eligible.reduce((sum, decision) => sum + (decision.score ?? 0), 0);
  const policy = RISK_PROFILE_POLICIES[config.riskProfile];
  const allocated = decisions.map((decision) => {
    const selected = eligible.some((candidate) => candidate.asset === decision.asset);
    if (!selected || totalScore <= 0) return decision;
    const allocationWeight = Math.min((decision.score ?? 0) / totalScore, policy.maxAllocation);
    return {
      ...decision,
      allocationWeight,
      allocatedAmount: Number((config.totalCapital * allocationWeight).toFixed(2)),
    };
  });

  const rejectionReasons = Object.fromEntries(
    (
      [
        'DATA_UNAVAILABLE',
        'DATA_FETCH_FAILED',
        'STALE_DATA',
        'INSUFFICIENT_HISTORY',
        'BELOW_MINIMUM_SCORE',
        'HIGH_VOLATILITY',
        'NON_POSITIVE_MOMENTUM',
      ] as const
    ).map((code) => [
      code,
      allocated.filter((decision) =>
        decision.rejectionReasons.some((reason) => reason.code === code),
      ).length,
    ]),
  ) as Record<DecisionStatus, number>;
  const eligibleCount = allocated.filter((decision) => decision.status === 'ELIGIBLE').length;
  return {
    evaluationTime: input.evaluationTime,
    configuration: config,
    decisions: allocated,
    coverage: {
      assets: allocated.length,
      eligible: eligibleCount,
      rejected: allocated.length - eligibleCount,
      rejectionReasons,
    },
  };
}

export function isRiskProfileCandidate(result: CanonicalScore, profile: RiskProfile): boolean {
  return qualifiesForRiskProfile(profile, result);
}
