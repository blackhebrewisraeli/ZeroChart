/**
 * Market opportunity scanner: one canonical-model pass over every asset in a
 * configured universe (the assets_status rows), ranked and explained, with
 * the assets it could not evaluate reported instead of dropped.
 *
 * Two phases so a scan can be reproduced offline: `collectScanInputs` fetches
 * candles with bounded concurrency and records every failure, and
 * `evaluateScan` is pure — the same inputs and evaluation time always give the
 * same scan.
 *
 * Three answers stay separate: the rank (score order), the setup conditions
 * Pine evaluates on a closed bar (`modelSetups`), and risk-profile eligibility
 * (`qualifiesForRiskProfile`). None of them is an order or a BUY signal.
 *
 * Only crypto has a validated daily candle source (Binance spot, the
 * binance-daily-v1 policy). Equities and forex are UNSUPPORTED until they get
 * a provider and a session-calendar candle policy of their own; their scores
 * would not be comparable to the 24/7 UTC crypto days anyway.
 */
import { CandleProviderDataError, ProviderRateLimitError, type Candle } from '@/lib/binance';
import {
  CANONICAL_MODEL_VERSION,
  evaluateCandles,
  modelSetups,
  type CanonicalScore,
  type ModelSetups,
} from '@/lib/canonicalModel';
import {
  BINANCE_DAILY_CANDLE_POLICY_VERSION,
  formatCandleIssues,
  validateBinanceDailyCandles,
} from '@/lib/candleValidation';
import {
  qualifiesForRiskProfile,
  RISK_PROFILE_POLICIES,
  type RiskProfile,
} from '@/lib/portfolioBuilder';
import { classifyTicker, toBinanceSymbol, type TickerKind } from '@/lib/ticker';

/** Bump whenever a change can move a scan's results, ranking or coverage. */
export const SCANNER_VERSION = 'market-scan-v1';
export const SCAN_TIMEFRAME = '1d';
/** The request every other score in the app makes (roboAdvisor's scoreTicker). */
export const SCAN_CANDLE_REQUEST = 200;
export const SCAN_MODEL_WINDOW = 200;
/**
 * A full request minus the still-open candle. Ranking only full windows keeps
 * every ranked score smoothed over the same history; a younger listing is
 * reported as INSUFFICIENT_HISTORY instead of ranked.
 */
export const SCAN_MIN_CLOSED_CANDLES = SCAN_CANDLE_REQUEST - 1;
/** The freshness bound scoreTicker and the evaluation lab already apply. */
export const SCAN_MAX_DATA_AGE_MS = 48 * 60 * 60 * 1000;
/** Requests in flight at once; 4 × weight 2 stays far under Binance's per-minute budget. */
export const SCAN_CONCURRENCY = 4;

export type ScanAssetStatus =
  | 'EVALUATED'
  | 'UNSUPPORTED'
  | 'FETCH_FAILED'
  | 'RATE_LIMITED'
  | 'DATA_INVALID'
  | 'STALE_DATA'
  | 'INSUFFICIENT_HISTORY';

export const SCAN_ASSET_STATUSES: readonly ScanAssetStatus[] = [
  'EVALUATED',
  'UNSUPPORTED',
  'FETCH_FAILED',
  'RATE_LIMITED',
  'DATA_INVALID',
  'STALE_DATA',
  'INSUFFICIENT_HISTORY',
];

const STATUS_LABELS: Record<ScanAssetStatus, string> = {
  EVALUATED: 'Evaluated',
  UNSUPPORTED: 'Not scanned',
  FETCH_FAILED: 'Fetch failed',
  RATE_LIMITED: 'Rate limited',
  DATA_INVALID: 'Invalid data',
  STALE_DATA: 'Stale data',
  INSUFFICIENT_HISTORY: 'Short history',
};

/** Short display label for a result's status ("Not scanned", "Stale data", ...). */
export function scanStatusLabel(result: Pick<ScanAssetResult, 'status'>): string {
  return STATUS_LABELS[result.status];
}

export interface ScanFetchError {
  code: 'FETCH_FAILED' | 'RATE_LIMITED' | 'DATA_INVALID';
  detail: string;
}

/** One universe member as collected: raw provider candles, or why there are none. */
export interface ScanInput {
  ticker: string;
  /** The provider instrument scored for the ticker; null when its class is unsupported. */
  instrument: string | null;
  candles?: readonly Candle[];
  error?: ScanFetchError;
}

export interface ScanAssetResult {
  ticker: string;
  assetClass: TickerKind;
  instrument: string | null;
  status: ScanAssetStatus;
  /** Why the asset was not evaluated; null when it was. */
  detail: string | null;
  /** Close time of the latest closed candle the result rests on. */
  dataAsOf: number | null;
  closedCandles: number;
  /** 1-based, score descending then ticker; null unless EVALUATED. */
  rank: number | null;
  /** The canonical engine's reading: score, components, raw inputs, regime, rationale. */
  model: CanonicalScore | null;
  setups: ModelSetups | null;
  riskProfiles: Readonly<Record<RiskProfile, boolean>> | null;
}

/** COMPLETE only when every supported asset was scored. */
export type ScanStatus = 'COMPLETE' | 'PARTIAL' | 'FAILED';

export interface MarketScan {
  scannerVersion: typeof SCANNER_VERSION;
  modelVersion: typeof CANONICAL_MODEL_VERSION;
  candlePolicyVersion: typeof BINANCE_DAILY_CANDLE_POLICY_VERSION;
  timeframe: typeof SCAN_TIMEFRAME;
  modelWindow: number;
  minClosedCandles: number;
  maxDataAgeMs: number;
  universe: { source: string; members: readonly string[] };
  /** When collection started: no candle closing after it counts as closed. */
  evaluationTime: number;
  status: ScanStatus;
  coverage: {
    configured: number;
    supported: number;
    evaluated: number;
    unsupported: number;
    /** Supported but not scored: fetch, rate-limit, validity, freshness or history failures. */
    notEvaluated: number;
    byStatus: Readonly<Record<ScanAssetStatus, number>>;
  };
  dataAsOf: { oldest: number | null; newest: number | null };
  /** Evaluated assets in rank order, then every other member by ticker. */
  results: readonly ScanAssetResult[];
}

const UNSUPPORTED_DETAIL: Record<TickerKind, string> = {
  crypto: '',
  equity:
    'No validated daily candle source for equities: they need a licensed provider and an exchange-session candle policy.',
  forex:
    'No validated daily candle source for forex: it needs a licensed provider and a session candle policy.',
};

/** Code-unit order, so ties break the same way in every runtime and locale. */
export function compareTickers(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** The universe as scanned: unique tickers in code-unit order. */
export function scanUniverse(tickers: readonly string[]): string[] {
  return [...new Set(tickers)].sort(compareTickers);
}

/** The instrument the scanner scores for a ticker, or null without a supported source. */
export function scanInstrument(ticker: string): string | null {
  if (classifyTicker(ticker) !== 'crypto') return null;
  const symbol = toBinanceSymbol(ticker);
  return symbol ? `BINANCE:${symbol}` : null;
}

function fetchError(error: unknown): ScanFetchError {
  if (error instanceof ProviderRateLimitError) {
    const retry = error.retryAfterMs === null ? '' : ` (retry after ${error.retryAfterMs / 1000}s)`;
    return { code: 'RATE_LIMITED', detail: `${error.message}${retry}` };
  }
  if (error instanceof CandleProviderDataError) {
    return { code: 'DATA_INVALID', detail: `MALFORMED_PROVIDER_ROW: ${error.message}` };
  }
  return {
    code: 'FETCH_FAILED',
    detail: error instanceof Error ? error.message : 'Unknown market-data error',
  };
}

/**
 * Fetches candles for every supported member, at most `concurrency` at once.
 * Never rejects: a failure is recorded on its member. After a rate-limit
 * answer no further request is sent this scan; the members still queued are
 * recorded as RATE_LIMITED rather than retried against the provider's limit.
 */
export async function collectScanInputs(
  universe: readonly string[],
  fetchCandles: (ticker: string) => Promise<readonly Candle[]>,
  concurrency = SCAN_CONCURRENCY,
): Promise<ScanInput[]> {
  const inputs: ScanInput[] = scanUniverse(universe).map((ticker) => ({
    ticker,
    instrument: scanInstrument(ticker),
  }));
  const queue = inputs.filter((input) => input.instrument !== null);
  let limited: ProviderRateLimitError | null = null;
  const worker = async () => {
    for (let input = queue.shift(); input; input = queue.shift()) {
      if (limited) {
        input.error = {
          code: 'RATE_LIMITED',
          detail: `Not requested: ${limited.message} earlier in this scan.`,
        };
        continue;
      }
      try {
        input.candles = await fetchCandles(input.ticker); // NOSONAR(S9382): one request per worker is the bound
      } catch (error) {
        input.error = fetchError(error);
        if (error instanceof ProviderRateLimitError) limited = error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return inputs;
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

function assess(input: ScanInput, evaluationTime: number): ScanAssetResult {
  const assetClass = classifyTicker(input.ticker);
  const base: ScanAssetResult = {
    ticker: input.ticker,
    assetClass,
    instrument: input.instrument,
    status: 'UNSUPPORTED',
    detail: null,
    dataAsOf: null,
    closedCandles: 0,
    rank: null,
    model: null,
    setups: null,
    riskProfiles: null,
  };
  if (input.instrument === null) return { ...base, detail: UNSUPPORTED_DETAIL[assetClass] };
  if (input.error) return { ...base, status: input.error.code, detail: input.error.detail };

  const validation = validateBinanceDailyCandles(input.candles ?? [], {
    evaluationTime,
    maxDataAgeMs: SCAN_MAX_DATA_AGE_MS,
    modelWindow: SCAN_MODEL_WINDOW,
  });
  const observed = {
    ...base,
    dataAsOf: validation.latestCloseTime,
    closedCandles: validation.closed.length,
  };
  if (!validation.structurallyValid) {
    return {
      ...observed,
      status: 'DATA_INVALID',
      detail: `${validation.policyVersion}: ${formatCandleIssues(validation.issues)}`,
    };
  }
  if (validation.fresh === false && validation.latestCloseTime !== null) {
    return {
      ...observed,
      status: 'STALE_DATA',
      detail: `Latest closed candle closed ${iso(validation.latestCloseTime)}, more than 48h before the scan.`,
    };
  }
  if (validation.closed.length < SCAN_MIN_CLOSED_CANDLES) {
    return {
      ...observed,
      status: 'INSUFFICIENT_HISTORY',
      detail: `${validation.closed.length} closed daily candles; the scan ranks only full ${SCAN_MIN_CLOSED_CANDLES}-candle windows.`,
    };
  }
  const result = evaluateCandles(validation.closed);
  if (result.status !== 'OK') {
    return {
      ...observed,
      status: 'INSUFFICIENT_HISTORY',
      detail: 'The canonical model had no finite reading on the last closed candle.',
    };
  }
  return {
    ...observed,
    status: 'EVALUATED',
    model: result,
    setups: modelSetups(result),
    riskProfiles: Object.fromEntries(
      (Object.keys(RISK_PROFILE_POLICIES) as RiskProfile[]).map((profile) => [
        profile,
        qualifiesForRiskProfile(profile, result),
      ]),
    ) as Record<RiskProfile, boolean>,
  };
}

function scanStatus(supported: number, evaluated: number): ScanStatus {
  if (supported > 0 && evaluated === supported) return 'COMPLETE';
  return evaluated > 0 ? 'PARTIAL' : 'FAILED';
}

/** Scores and ranks collected inputs. Pure: no clock, no network. */
export function evaluateScan(
  inputs: readonly ScanInput[],
  options: { evaluationTime: number; universeSource: string },
): MarketScan {
  const assessed = [...inputs]
    .sort((a, b) => compareTickers(a.ticker, b.ticker))
    .map((input) => assess(input, options.evaluationTime));
  const ranked = assessed
    .filter((result) => result.status === 'EVALUATED')
    .sort(
      (a, b) =>
        (b.model?.signal_score ?? 0) - (a.model?.signal_score ?? 0) ||
        compareTickers(a.ticker, b.ticker),
    )
    .map((result, index) => ({ ...result, rank: index + 1 }));
  const others = assessed.filter((result) => result.status !== 'EVALUATED');
  const byStatus = Object.fromEntries(
    SCAN_ASSET_STATUSES.map((status) => [
      status,
      assessed.filter((result) => result.status === status).length,
    ]),
  ) as Record<ScanAssetStatus, number>;
  const supported = assessed.length - byStatus.UNSUPPORTED;
  const asOf = ranked.flatMap((result) => (result.dataAsOf === null ? [] : [result.dataAsOf]));
  return {
    scannerVersion: SCANNER_VERSION,
    modelVersion: CANONICAL_MODEL_VERSION,
    candlePolicyVersion: BINANCE_DAILY_CANDLE_POLICY_VERSION,
    timeframe: SCAN_TIMEFRAME,
    modelWindow: SCAN_MODEL_WINDOW,
    minClosedCandles: SCAN_MIN_CLOSED_CANDLES,
    maxDataAgeMs: SCAN_MAX_DATA_AGE_MS,
    universe: { source: options.universeSource, members: assessed.map((result) => result.ticker) },
    evaluationTime: options.evaluationTime,
    status: scanStatus(supported, ranked.length),
    coverage: {
      configured: assessed.length,
      supported,
      evaluated: ranked.length,
      unsupported: byStatus.UNSUPPORTED,
      notEvaluated: supported - ranked.length,
      byStatus,
    },
    dataAsOf: {
      oldest: asOf.length > 0 ? Math.min(...asOf) : null,
      newest: asOf.length > 0 ? Math.max(...asOf) : null,
    },
    results: [...ranked, ...others],
  };
}
