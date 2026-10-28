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
 * Each asset class is its own cohort, ranked only within itself: the same
 * formula does not make a crypto score and an equity score comparable in risk
 * or predictive value. Crypto runs on Binance spot (binance-daily-v1). US
 * equities and ETFs run on us-equity-daily-v1 sessions, but only through an
 * injected, licensed EquityDailyProvider; with none configured (the case
 * today) they are UNSUPPORTED, as forex always is.
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
import {
  latestFinalSession,
  sessionsBack,
  US_EQUITY_CALENDAR,
  US_EQUITY_DAILY_CANDLE_POLICY_VERSION,
  usEquityInstrument,
  validateUsEquityDailySeries,
  type EquityDailyProvider,
  type EquityDailySeries,
} from '@/lib/usEquityDaily';

/** Bump whenever a change can move a scan's results, ranking or coverage. */
export const SCANNER_VERSION = 'market-scan-v2';
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
/**
 * Sessions requested per equity: the 199-session window plus one, so a
 * provider one session behind (still fresh) leaves a full window.
 */
export const SCAN_EQUITY_REQUEST_SESSIONS = SCAN_MIN_CLOSED_CANDLES + 1;

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
  /** Crypto: Binance klines, fetched during this scan. */
  candles?: readonly Candle[];
  /** Equities: the provider series for `range`, and when it was fetched (earlier, if cached). */
  equity?: {
    provider: string;
    range: { from: string; to: string };
    series?: EquityDailySeries;
    fetchedAt?: number;
    cached?: boolean;
  };
  error?: ScanFetchError;
}

/** Where a scan's candles come from. Credentials live inside the provider, never here. */
export interface ScanSources {
  crypto: (ticker: string) => Promise<readonly Candle[]>;
  /** A licensed equity adapter; absent, equities are UNSUPPORTED. */
  equity?: EquityDailyProvider;
  /** Equity series already fetched, keyed by provider, symbol and session range. */
  equityCache?: Map<string, { fetchedAt: number; series: EquityDailySeries }>;
  /** Clock for an equity series' fetch time. */
  now?: () => number;
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
  /** Equities: when the series was fetched; earlier than the scan when served from cache. */
  fetchedAt: number | null;
  cached: boolean;
  /** 1-based, score descending then ticker; null unless EVALUATED. */
  rank: number | null;
  /** The canonical engine's reading: score, components, raw inputs, regime, rationale. */
  model: CanonicalScore | null;
  setups: ModelSetups | null;
  riskProfiles: Readonly<Record<RiskProfile, boolean>> | null;
}

/** COMPLETE only when every supported asset was scored. */
export type ScanStatus = 'COMPLETE' | 'PARTIAL' | 'FAILED';

interface ScanCoverage {
  configured: number;
  supported: number;
  evaluated: number;
  unsupported: number;
  /** Supported but not scored: fetch, rate-limit, validity, freshness or history failures. */
  notEvaluated: number;
  byStatus: Readonly<Record<ScanAssetStatus, number>>;
}

/** One asset class as scanned: its data source, policy and coverage. Ranked only within itself. */
export interface ScanCohort {
  assetClass: TickerKind;
  timeframe: typeof SCAN_TIMEFRAME;
  /** Candle source; null when the class is not scanned. */
  provider: string | null;
  candlePolicyVersion: string | null;
  calendar: string;
  /** Closed candles (sessions, for equities) each ranked score rests on. */
  minClosedCandles: number;
  freshness: string;
  status: ScanStatus | 'UNSUPPORTED';
  coverage: ScanCoverage;
  dataAsOf: { oldest: number | null; newest: number | null };
}

export interface MarketScan {
  scannerVersion: typeof SCANNER_VERSION;
  modelVersion: typeof CANONICAL_MODEL_VERSION;
  timeframe: typeof SCAN_TIMEFRAME;
  universe: { source: string; members: readonly string[] };
  /** When collection started: no candle closing after it counts as closed. */
  evaluationTime: number;
  /** COMPLETE only when every supported asset in every cohort was scored. */
  status: ScanStatus;
  coverage: ScanCoverage;
  /** The asset classes in the universe, crypto then equity then forex. */
  cohorts: readonly ScanCohort[];
  /** Each cohort's evaluated assets in its own rank order, then every other member by ticker. */
  results: readonly ScanAssetResult[];
}

export const UNSUPPORTED_DETAIL: Record<TickerKind, string> = {
  crypto: '',
  equity:
    'No licensed daily-candle provider is configured for US equities and ETFs, so they are not scanned. Their session-calendar policy (us-equity-daily-v1) is in place.',
  forex:
    'No validated daily candle source for forex: it needs a licensed provider and a session candle policy.',
};

const UNMAPPED_EQUITY_DETAIL =
  'Not in the US equity instrument map: an instrument is never inferred from the ticker alone.';

const COHORT_ORDER: readonly TickerKind[] = ['crypto', 'equity', 'forex'];

/** Code-unit order, so ties break the same way in every runtime and locale. */
export function compareTickers(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** The universe as scanned: unique tickers in code-unit order. */
export function scanUniverse(tickers: readonly string[]): string[] {
  return [...new Set(tickers)].sort(compareTickers);
}

/**
 * The Binance instrument for a crypto ticker; null for every other class.
 * Equities have no browser-side source: their instrument (`usEquityInstrument`)
 * is scanned only through a server-side EquityDailyProvider.
 */
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

/** The equity cache key: one entry per provider, symbol and session range. */
export function equityCacheKey(
  provider: string,
  ticker: string,
  range: { from: string; to: string },
) {
  return `${provider}|${ticker}|${range.from}|${range.to}`;
}

/**
 * Runs one provider's requests, at most `concurrency` at once. After a
 * rate-limit answer this queue sends nothing more this scan; its remaining
 * members are recorded as RATE_LIMITED rather than retried against the
 * limit. Other providers' queues are unaffected.
 */
async function drain(
  queue: ScanInput[],
  concurrency: number,
  request: (input: ScanInput) => Promise<void>,
): Promise<void> {
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
        await request(input); // NOSONAR(S9382): one request per worker is the bound
      } catch (error) {
        input.error = fetchError(error);
        if (error instanceof ProviderRateLimitError) limited = error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
}

/**
 * Fetches candles for every supported member: at most one request each, none
 * for an equity already cached for the same session range. Never rejects: a
 * failure is recorded on its member.
 */
export async function collectScanInputs(
  universe: readonly string[],
  sources: ScanSources,
  options: { evaluationTime: number; concurrency?: number | undefined },
): Promise<ScanInput[]> {
  const provider = sources.equity;
  const inputs: ScanInput[] = scanUniverse(universe).map((ticker) => ({
    ticker,
    instrument:
      classifyTicker(ticker) === 'equity' && provider
        ? usEquityInstrument(ticker)
        : scanInstrument(ticker),
  }));
  const supported = inputs.filter((input) => input.instrument !== null);
  const crypto = supported.filter((input) => classifyTicker(input.ticker) === 'crypto');
  const equities = supported.filter((input) => classifyTicker(input.ticker) === 'equity');

  const equityQueue: ScanInput[] = [];
  if (provider) {
    const to = latestFinalSession(options.evaluationTime);
    const from = to === null ? null : sessionsBack(to, SCAN_EQUITY_REQUEST_SESSIONS);
    for (const input of equities) {
      if (to === null || from === null) {
        input.error = {
          code: 'DATA_INVALID',
          detail: `CALENDAR_OUT_OF_RANGE: the ${SCAN_EQUITY_REQUEST_SESSIONS}-session window is outside the published calendar (${US_EQUITY_CALENDAR.firstYear}–${US_EQUITY_CALENDAR.lastYear}).`,
        };
        continue;
      }
      const range = { from, to };
      input.equity = { provider: provider.id, range };
      const hit = sources.equityCache?.get(equityCacheKey(provider.id, input.ticker, range));
      if (hit)
        Object.assign(input.equity, { series: hit.series, fetchedAt: hit.fetchedAt, cached: true });
      else equityQueue.push(input);
    }
  }
  const now = sources.now ?? Date.now;
  await Promise.all([
    drain(crypto, options.concurrency ?? SCAN_CONCURRENCY, async (input) => {
      input.candles = await sources.crypto(input.ticker);
    }),
    provider &&
      drain(equityQueue, Math.min(provider.concurrency, SCAN_CONCURRENCY), async (input) => {
        const equity = input.equity!;
        const series = await provider.fetchDaily(input.ticker, equity.range);
        const fetchedAt = now();
        sources.equityCache?.set(equityCacheKey(provider.id, input.ticker, equity.range), {
          fetchedAt,
          series,
        });
        Object.assign(equity, { series, fetchedAt, cached: false });
      }),
  ]);
  return inputs;
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

/** The canonical model on a validated window, with its setups and risk-profile fit. */
function scored(observed: ScanAssetResult, closed: readonly Candle[]): ScanAssetResult {
  const result = evaluateCandles(closed);
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

function assessCrypto(
  input: ScanInput,
  base: ScanAssetResult,
  evaluationTime: number,
): ScanAssetResult {
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
  return scored(observed, validation.closed);
}

function assessEquity(
  equity: NonNullable<ScanInput['equity']>,
  base: ScanAssetResult,
  evaluationTime: number,
): ScanAssetResult {
  const validation = validateUsEquityDailySeries(
    equity.series ?? { adjustment: 'SPLIT', bars: [], splits: [] },
    {
      evaluationTime,
      modelWindow: SCAN_MIN_CLOSED_CANDLES,
    },
  );
  const observed = {
    ...base,
    dataAsOf: validation.latestCloseTime,
    closedCandles: validation.windowSessions,
  };
  if (!validation.structurallyValid) {
    return {
      ...observed,
      status: 'DATA_INVALID',
      detail: `${validation.policyVersion}: ${formatCandleIssues(validation.issues)}`,
    };
  }
  if (validation.fresh === false) {
    return {
      ...observed,
      status: 'STALE_DATA',
      detail: `Latest final session is ${validation.latestSession}; the scan needs ${validation.requiredSession} or the session before it.`,
    };
  }
  if (validation.closed.length < SCAN_MIN_CLOSED_CANDLES) {
    return {
      ...observed,
      status: 'INSUFFICIENT_HISTORY',
      detail: `${validation.closed.length} final sessions; the scan ranks only full ${SCAN_MIN_CLOSED_CANDLES}-session windows.`,
    };
  }
  return scored(observed, validation.closed);
}

function assess(
  input: ScanInput,
  evaluationTime: number,
  equityProvider: string | null,
): ScanAssetResult {
  const assetClass = classifyTicker(input.ticker);
  const base: ScanAssetResult = {
    ticker: input.ticker,
    assetClass,
    instrument: input.instrument,
    status: 'UNSUPPORTED',
    detail: null,
    dataAsOf: null,
    closedCandles: 0,
    fetchedAt: input.equity?.fetchedAt ?? null,
    cached: input.equity?.cached ?? false,
    rank: null,
    model: null,
    setups: null,
    riskProfiles: null,
  };
  if (input.instrument === null) {
    const unmapped = assetClass === 'equity' && equityProvider !== null;
    return { ...base, detail: unmapped ? UNMAPPED_EQUITY_DETAIL : UNSUPPORTED_DETAIL[assetClass] };
  }
  if (input.error) return { ...base, status: input.error.code, detail: input.error.detail };
  return input.equity
    ? assessEquity(input.equity, base, evaluationTime)
    : assessCrypto(input, base, evaluationTime);
}

function scanStatus(supported: number, evaluated: number): ScanStatus {
  if (supported > 0 && evaluated === supported) return 'COMPLETE';
  return evaluated > 0 ? 'PARTIAL' : 'FAILED';
}

function coverageOf(results: readonly ScanAssetResult[]): ScanCoverage {
  const byStatus = Object.fromEntries(
    SCAN_ASSET_STATUSES.map((status) => [
      status,
      results.filter((result) => result.status === status).length,
    ]),
  ) as Record<ScanAssetStatus, number>;
  const supported = results.length - byStatus.UNSUPPORTED;
  return {
    configured: results.length,
    supported,
    evaluated: byStatus.EVALUATED,
    unsupported: byStatus.UNSUPPORTED,
    notEvaluated: supported - byStatus.EVALUATED,
    byStatus,
  };
}

/** Score descending, then ticker: the same inputs always give the same order. */
function rankWithin(results: readonly ScanAssetResult[]): ScanAssetResult[] {
  return results
    .filter((result) => result.status === 'EVALUATED')
    .sort(
      (a, b) =>
        (b.model?.signal_score ?? 0) - (a.model?.signal_score ?? 0) ||
        compareTickers(a.ticker, b.ticker),
    )
    .map((result, index) => ({ ...result, rank: index + 1 }));
}

function cohortOf(
  assetClass: TickerKind,
  ranked: readonly ScanAssetResult[],
  all: readonly ScanAssetResult[],
  equityProvider: string | null,
): ScanCohort {
  const coverage = coverageOf(all);
  const asOf = ranked.flatMap((result) => (result.dataAsOf === null ? [] : [result.dataAsOf]));
  const source = {
    crypto: {
      provider: 'binance-spot-klines',
      candlePolicyVersion: BINANCE_DAILY_CANDLE_POLICY_VERSION,
      calendar: 'UTC days, 24/7',
      freshness: 'Latest closed candle at most 48h old',
    },
    equity: {
      provider: equityProvider,
      candlePolicyVersion: equityProvider === null ? null : US_EQUITY_DAILY_CANDLE_POLICY_VERSION,
      calendar: `US regular session, America/New_York (${US_EQUITY_CALENDAR.source})`,
      freshness: 'Latest final session or the one before; a bar is final 9h after the close',
    },
    forex: { provider: null, candlePolicyVersion: null, calendar: 'none', freshness: 'none' },
  }[assetClass];
  return {
    assetClass,
    timeframe: SCAN_TIMEFRAME,
    ...source,
    minClosedCandles: SCAN_MIN_CLOSED_CANDLES,
    status:
      coverage.supported === 0 ? 'UNSUPPORTED' : scanStatus(coverage.supported, ranked.length),
    coverage,
    dataAsOf: {
      oldest: asOf.length > 0 ? Math.min(...asOf) : null,
      newest: asOf.length > 0 ? Math.max(...asOf) : null,
    },
  };
}

/** Scores and ranks collected inputs, each cohort within itself. Pure: no clock, no network. */
export function evaluateScan(
  inputs: readonly ScanInput[],
  options: { evaluationTime: number; universeSource: string; equityProvider?: string | null },
): MarketScan {
  const equityProvider = options.equityProvider ?? null;
  const assessed = [...inputs]
    .sort((a, b) => compareTickers(a.ticker, b.ticker))
    .map((input) => assess(input, options.evaluationTime, equityProvider));
  const cohorts: ScanCohort[] = [];
  const ranked: ScanAssetResult[] = [];
  for (const assetClass of COHORT_ORDER) {
    const members = assessed.filter((result) => result.assetClass === assetClass);
    if (members.length === 0) continue;
    const cohortRanked = rankWithin(members);
    ranked.push(...cohortRanked);
    cohorts.push(cohortOf(assetClass, cohortRanked, members, equityProvider));
  }
  const coverage = coverageOf(assessed);
  return {
    scannerVersion: SCANNER_VERSION,
    modelVersion: CANONICAL_MODEL_VERSION,
    timeframe: SCAN_TIMEFRAME,
    universe: { source: options.universeSource, members: assessed.map((result) => result.ticker) },
    evaluationTime: options.evaluationTime,
    status: scanStatus(coverage.supported, coverage.evaluated),
    coverage,
    cohorts,
    results: [...ranked, ...assessed.filter((result) => result.status !== 'EVALUATED')],
  };
}
