import {
  CANONICAL_MODEL_VERSION,
  ATR_PERIOD,
  MACD_FAST,
  MACD_SIGNAL,
  MACD_SLOW,
  MIN_CANDLES,
  RSI_PERIOD,
  type CanonicalScore,
  type EngineCandle,
  evaluateCandles,
} from '@/lib/canonicalModel';
import {
  allocateScoreCandidates,
  selectPortfolioCandidates,
  type RiskProfile,
} from '@/lib/portfolioBuilder';
import {
  BINANCE_DAILY_CANDLE_POLICY_VERSION,
  formatCandleIssues,
  type CandleIssue,
  validateBinanceDailyCandles,
} from '@/lib/candleValidation';

export const EVALUATION_STRATEGY_VERSION = 'canonical-portfolio-v1';
export const DAILY_TIMEFRAME = '1d';
export const DEFAULT_MAX_DATA_AGE_MS = 48 * 60 * 60 * 1000;
export const DEFAULT_TOTAL_CAPITAL = 100_000;
export const EVALUATION_SCHEMA_VERSION = '2';
export const LEGACY_EVALUATION_SCHEMA_VERSION = '1';
export const SUPPORTED_STRATEGY_VERSIONS = [EVALUATION_STRATEGY_VERSION] as const;
export const SUPPORTED_MODEL_VERSIONS = [CANONICAL_MODEL_VERSION] as const;

export type DecisionStatus =
  | 'ELIGIBLE'
  | 'DATA_UNAVAILABLE'
  | 'DATA_FETCH_FAILED'
  | 'DATA_INVALID'
  | 'STALE_DATA'
  | 'INSUFFICIENT_HISTORY'
  | 'BELOW_MINIMUM_SCORE'
  | 'HIGH_VOLATILITY'
  | 'NON_POSITIVE_MOMENTUM';

export type ProposedAction = 'PROPOSE_ALLOCATION' | 'NO_PROPOSAL' | 'REJECT';

export interface EvaluationConfig {
  strategyVersion: string;
  modelVersion: string;
  universe: readonly string[];
  timeframe: typeof DAILY_TIMEFRAME;
  riskProfile: RiskProfile;
  totalCapital: number;
  maxDataAgeMs: number;
  candleValidation?: {
    policyVersion: typeof BINANCE_DAILY_CANDLE_POLICY_VERSION;
    modelWindow: number;
  };
  executionTiming: 'next_observation_after_closed_candle';
  costs: {
    feeBps: number;
    slippageBps: number;
  };
  exitBehavior: 'none_in_evaluation_lab';
  benchmark: 'not_applicable_without_executable_exits';
  assumptions: readonly string[];
  limitations: readonly string[];
  modelParameters: {
    rsiPeriod: number;
    macdFast: number;
    macdSlow: number;
    macdSignal: number;
    atrPeriod: number;
    minimumCandles: number;
  };
  eligibility: {
    minimumScore: number;
    excludeHighVolatility: boolean;
    requirePositiveMomentum: boolean;
  };
  allocation: {
    maxAllocation: number;
    maxHoldings: number;
    method: 'score_proportional';
  };
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
  validationIssues?: readonly CandleIssue[];
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
  selectionStatus: 'SELECTED' | 'QUALIFIED_NOT_SELECTED' | 'NOT_ELIGIBLE';
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
  schemaVersion: typeof EVALUATION_SCHEMA_VERSION | typeof LEGACY_EVALUATION_SCHEMA_VERSION;
  runKey: string;
  evaluationTime: number;
  input: EvaluationInput;
  inputHash: string;
  configuration: EvaluationConfig;
  decisions: readonly DecisionSnapshot[];
  coverage: {
    assets: number;
    eligible: number;
    selected: number;
    qualifiedNotSelected: number;
    rejected: number;
    rejectionReasons: Readonly<Record<DecisionStatus, number>>;
  };
  observationPeriod: {
    start: number | null;
    end: number | null;
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

function modelCandles(
  asset: EvaluationAssetInput,
  evaluationTime: number,
  config: EvaluationConfig,
): { candles: EvaluationCandle[]; invalidDetail: string | null } {
  if (!config.candleValidation || asset.source !== 'binance-rest') {
    return { candles: closedCandles(asset.candles, evaluationTime), invalidDetail: null };
  }
  const validation = validateBinanceDailyCandles(asset.candles, {
    evaluationTime,
    maxDataAgeMs: config.maxDataAgeMs,
    modelWindow: config.candleValidation.modelWindow,
  });
  return {
    candles: validation.closed,
    invalidDetail: validation.structurallyValid
      ? null
      : `${validation.policyVersion}: ${formatCandleIssues(validation.issues)}`,
  };
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
    selectionStatus: 'NOT_ELIGIBLE',
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
  if (config.eligibility.excludeHighVolatility && result.regime === 'HIGH_VOLATILITY') {
    reasons.push(rejection('HIGH_VOLATILITY', 'Risk profile excludes high-volatility regimes.'));
  }
  if (result.signal_score < config.eligibility.minimumScore) {
    reasons.push(
      rejection(
        'BELOW_MINIMUM_SCORE',
        `Score ${result.signal_score} is below the ${config.eligibility.minimumScore} minimum.`,
      ),
    );
  }
  if (config.eligibility.requirePositiveMomentum && result.components.momentumScore <= 50) {
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
    selectionStatus: 'NOT_ELIGIBLE',
    rejectionReasons: reasons,
    proposedAction: 'NO_PROPOSAL',
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

export function normalizeEvaluationInput(input: EvaluationInput): EvaluationInput {
  return {
    evaluationTime: input.evaluationTime,
    assets: [...input.assets]
      .sort((a, b) => a.ticker.localeCompare(b.ticker))
      .map((asset) => ({
        ...asset,
        candles: [...asset.candles].sort((a, b) => a.closeTime - b.closeTime),
      })),
  };
}

export function assertSupportedEvaluationVersion(config: EvaluationConfig): void {
  if (
    !SUPPORTED_MODEL_VERSIONS.includes(
      config.modelVersion as (typeof SUPPORTED_MODEL_VERSIONS)[number],
    ) ||
    !SUPPORTED_STRATEGY_VERSIONS.includes(
      config.strategyVersion as (typeof SUPPORTED_STRATEGY_VERSIONS)[number],
    )
  ) {
    throw new Error(
      `Unsupported historical evaluation version: ${config.strategyVersion}/${config.modelVersion}`,
    );
  }
  if (
    config.candleValidation &&
    config.candleValidation.policyVersion !== BINANCE_DAILY_CANDLE_POLICY_VERSION
  ) {
    throw new Error(
      `Unsupported candle-validation policy: ${config.candleValidation.policyVersion}`,
    );
  }
  if (
    config.modelParameters.rsiPeriod !== RSI_PERIOD ||
    config.modelParameters.macdFast !== MACD_FAST ||
    config.modelParameters.macdSlow !== MACD_SLOW ||
    config.modelParameters.macdSignal !== MACD_SIGNAL ||
    config.modelParameters.atrPeriod !== ATR_PERIOD ||
    config.modelParameters.minimumCandles !== MIN_CANDLES
  ) {
    throw new Error(
      `Incompatible model parameters for ${config.modelVersion}: stored parameters do not match the supported implementation`,
    );
  }
}

export function evaluateInput(
  input: EvaluationInput,
  config: EvaluationConfig,
  inputHash = 'unhashed-input',
): EvaluationRun {
  const normalizedInput = normalizeEvaluationInput(input);
  const decisions = normalizedInput.assets.map((asset) => {
    const validated = modelCandles(asset, normalizedInput.evaluationTime, config);
    const closed = validated.candles;
    if (asset.validationIssues?.length) {
      return emptyDecision(
        asset,
        input,
        config,
        closed,
        'DATA_INVALID',
        `Candle validation failed: ${formatCandleIssues(asset.validationIssues)}`,
      );
    }
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
    if (validated.invalidDetail) {
      return emptyDecision(
        asset,
        input,
        config,
        closed,
        'DATA_INVALID',
        `Candle validation failed: ${validated.invalidDetail}`,
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
    if (normalizedInput.evaluationTime - dataAsOf > config.maxDataAgeMs) {
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
      : result.status === 'DATA_INVALID'
        ? emptyDecision(
            asset,
            input,
            config,
            closed,
            'DATA_INVALID',
            `Candle validation failed: ${formatCandleIssues(result.issues)}`,
          )
        : result.status === 'STALE_DATA'
          ? emptyDecision(
              asset,
              input,
              config,
              closed,
              'STALE_DATA',
              'Latest closed candle exceeds freshness policy.',
            )
          : emptyDecision(
              asset,
              input,
              config,
              closed,
              'INSUFFICIENT_HISTORY',
              `The canonical model requires ${result.required} valid candles; ${result.received} were available.`,
            );
  });

  const qualified = decisions.filter((decision) => decision.status === 'ELIGIBLE');
  const selected = selectPortfolioCandidates(
    qualified.map((decision) => ({
      ticker: decision.asset,
      score: decision.score ?? 0,
    })),
    config.riskProfile,
    config.allocation.maxHoldings,
  );
  const allocations = new Map(
    allocateScoreCandidates(
      selected,
      config.riskProfile,
      config.totalCapital,
      config.allocation.maxAllocation,
    ).map((allocation) => [allocation.ticker, allocation]),
  );
  const allocated = decisions.map((decision) => {
    if (decision.status !== 'ELIGIBLE') return decision;
    const allocation = allocations.get(decision.asset);
    if (!allocation) {
      return { ...decision, selectionStatus: 'QUALIFIED_NOT_SELECTED' as const };
    }
    return {
      ...decision,
      selectionStatus: 'SELECTED' as const,
      proposedAction: 'PROPOSE_ALLOCATION' as const,
      allocationWeight: allocation.weight,
      allocatedAmount: allocation.allocatedAmount,
    };
  });

  const rejectionReasons = Object.fromEntries(
    (
      [
        'DATA_UNAVAILABLE',
        'DATA_FETCH_FAILED',
        'DATA_INVALID',
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
  const selectedCount = allocated.filter(
    (decision) => decision.selectionStatus === 'SELECTED',
  ).length;
  const qualifiedNotSelected = allocated.filter(
    (decision) => decision.selectionStatus === 'QUALIFIED_NOT_SELECTED',
  ).length;
  const periodValues = normalizedInput.assets.flatMap((asset) =>
    asset.candles
      .filter((candle) => candle.closeTime <= input.evaluationTime)
      .flatMap((candle) => [candle.timestamp, candle.closeTime]),
  );
  const periodStart = periodValues.length > 0 ? Math.min(...periodValues) : null;
  const periodEnd = periodValues.length > 0 ? Math.max(...periodValues) : null;
  return {
    schemaVersion: config.candleValidation
      ? EVALUATION_SCHEMA_VERSION
      : LEGACY_EVALUATION_SCHEMA_VERSION,
    runKey: `${normalizedInput.evaluationTime}:${config.configurationId}`,
    evaluationTime: normalizedInput.evaluationTime,
    input: normalizedInput,
    inputHash,
    configuration: config,
    decisions: allocated,
    coverage: {
      assets: allocated.length,
      eligible: eligibleCount,
      selected: selectedCount,
      qualifiedNotSelected,
      rejected: allocated.length - eligibleCount,
      rejectionReasons,
    },
    observationPeriod: { start: periodStart, end: periodEnd },
  };
}
