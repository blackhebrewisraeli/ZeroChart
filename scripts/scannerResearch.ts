import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  CANONICAL_MODEL_VERSION,
  evaluateCandles,
  LONG_SETUP_MIN_SCORE,
  modelSetups,
  RISK_SETUP_MAX_SCORE,
  type MarketRegime,
  type ModelSetups,
} from '@/lib/canonicalModel';
import {
  formatCandleIssues,
  issue,
  validatePrices,
  type CandleIssue,
} from '@/lib/candleValidation';
import {
  compareTickers,
  equityRequestRange,
  evaluateScan,
  SCAN_EQUITY_REQUEST_SESSIONS,
  SCAN_MIN_CLOSED_CANDLES,
  SCANNER_VERSION,
  type ScanAssetStatus,
  type ScanFetchError,
} from '@/lib/marketScanner';
import {
  TRADINGVIEW_DEV_PROVIDER_ID,
  TRADINGVIEW_DEV_UNIVERSE_SOURCE,
} from '@/lib/tradingViewDevScan';
import {
  latestFinalSession,
  sessionClose,
  sessionFinalAt,
  tradingSessions,
  US_EQUITY_CALENDAR,
  US_EQUITY_DAILY_CANDLE_POLICY_VERSION,
  US_EQUITY_INSTRUMENTS,
  type EquityDailyBar,
} from '@/lib/usEquityDaily';
import { stableSerialize } from './evaluationStore';
import { renderScannerResearchReport } from './scannerResearchReport';
import {
  exportedSeries,
  importInputs,
  parseExport,
  SELECTION_RULE,
  selectDevScanUniverse,
  type TradingViewOhlcvExport,
} from './tradingViewImport';

/**
 * Retrospective study of the market scanner on the private TradingView export
 * of the 50-instrument development scan. Frozen before any score, rank or
 * forward price change was computed from that export; docs/scanner-research.v1.json
 * is the committed copy and docs/SCANNER_RESEARCH.md the method.
 */
export const RESEARCH_HORIZONS = [1, 5, 20] as const;
export type ResearchHorizon = (typeof RESEARCH_HORIZONS)[number];

export const RESEARCH_SPECIFICATION = {
  schemaVersion: '1',
  studyId: 'zerochart-scanner-retrospective-us-equity-v1',
  evidenceType: 'retrospective-historical-research',
  frozenAt: '2026-10-29T13:25:00.000Z',
  frozenBefore:
    "Fixed after inspecting only the export's bar dates, bar counts, bar timestamps and market-data notice; before any score, rank, setup or forward price change was computed from it.",
  interpretation:
    "Retrospective historical signal research on today's provider history. Not prospective evidence, not a backtest, not simulated fills, and not evidence of executable or profitable trading.",
  data: {
    source: 'tradingview-mcp get_ohlcv, interval 1D, 1000 bars per symbol',
    export: '20261029T103004Z.json',
    exportSha256: '66d5a8a74e034247b97c5ed713e6e73fdcd81f023b08e5a758b277a4cfdcd5b4',
    retrieval: { startedAt: '2026-10-29T10:30:04.843Z', completedAt: '2026-10-29T10:32:28.685Z' },
    cutoff:
      'retrieval.startedAt: a bar is used, as input or outcome, only if its session was final (9h after the scheduled close, FINAL_BAR_DELAY_MS) by then',
    adjustment:
      'SPLIT: TradingView states regular session only and split-adjusted only; prices carry no dividend adjustment and no split events are reported',
    mapping:
      "tradingViewSeries (scripts/tradingViewImport.ts): a bar's t must be the 09:30 America/New_York open of its session, or the whole series is rejected",
  },
  universe: {
    selectionRule: SELECTION_RULE,
    members: selectDevScanUniverse(),
    instrumentTypes: 'US_EQUITY_INSTRUMENTS: 38 stocks, 12 ETFs',
    symbols: 'TRADINGVIEW_SYMBOLS (scripts/tradingViewImport.ts)',
  },
  calendar: {
    sessions:
      "Observed: every session date present in at least one member's bars. Observed 2026 sessions must equal the published US_EQUITY_CALENDAR sessions exactly, or the study refuses to run.",
    observedSessions: 1001,
    firstSession: '2022-11-01',
    lastSession: '2026-10-28',
  },
  evaluationDates: {
    rule: "Every observed session from the 200th (the first on which every member's data allows a full window) to the latest session final at the cutoff; the same dates for every member",
    first: '2023-08-18',
    last: '2026-10-28',
    count: 802,
  },
  decision: {
    time: "Evaluation date D's bar becomes final 9h after D's scheduled close; the scanner is given only bars of sessions on or before D",
    earlyCloses:
      'Known only from 2026 (published calendar); an earlier early close shifts the decision timestamp, never which bars are supplied',
  },
  scanner: {
    scannerVersion: SCANNER_VERSION,
    modelVersion: CANONICAL_MODEL_VERSION,
    candlePolicyVersion: US_EQUITY_DAILY_CANDLE_POLICY_VERSION,
    historyWindowSessions: SCAN_MIN_CLOSED_CANDLES,
    historyWindow:
      'The latest 199 bars of sessions on or before D (SCAN_MIN_CLOSED_CANDLES), scored by evaluateCandles over that whole window, as the equity scan does',
    eligibility:
      'us-equity-daily-v1 rules against the observed calendar: a missing, duplicate or non-session bar or invalid OHLC inside the window is DATA_INVALID; a latest bar older than the session before D is STALE_DATA; fewer than 199 bars or no finite reading is INSUFFICIENT_HISTORY',
    ranking:
      'Within the equity cohort, stocks and ETFs together: score descending, then ticker in code-unit order, as evaluateScan ranks',
    parity:
      'On every evaluation date whose 200-session request range the published calendar covers, the replay must equal importInputs + evaluateScan on the same export, or the study refuses to run',
  },
  signals: {
    longSetup: `modelSetups long (Pine ZC LONG): score >= ${LONG_SETUP_MIN_SCORE} and MACD histogram / close >= +0.05%`,
    riskWarning: `modelSetups risk (Pine ZC RISK): score <= ${RISK_SETUP_MAX_SCORE} or HIGH_VOLATILITY regime`,
    rankGroups:
      'top5: ranks 1-5; top10: ranks 1-10; rank quintile q = ceil(5 x rank / members evaluated that date)',
    observation:
      'One asset on one evaluation date on which the condition holds; a standing setup repeats on every date it holds',
    transition:
      'An observation whose asset was EVALUATED on the previous evaluation date without the same condition. When the asset was not evaluated on the previous date the onset is unknown, so it is not a transition',
  },
  horizonsSessions: RESEARCH_HORIZONS,
  referencePrice:
    "OPEN of the first session after D, which opens after the decision time; D's close is never used as an entry",
  endpointPrice: 'OPEN of the session h observed sessions after the reference session',
  change: 'endpoint / reference - 1, in percent; price only, dividends excluded',
  maturity:
    'A horizon is measured only when its endpoint session is final at the cutoff; otherwise it is PENDING and excluded',
  benchmark:
    'SPY (AMEX:SPY, also a universe member) over the identical reference and endpoint sessions',
  comparisons: {
    universe:
      'Every EVALUATED member with an AVAILABLE outcome for that evaluation date and horizon',
    sameDateDifference:
      "Per observation: the asset's change minus that date's universe mean change, the asset included",
    byInstrumentType: 'Stock and ETF rows compare against the same-date universe of their own type',
    benchmarkDifference: "Per observation: the asset's change minus SPY's over the same sessions",
    groups: [
      'universe',
      'long-setup',
      'long-setup-transition',
      'risk-warning',
      'risk-warning-transition',
      'top5',
      'top10',
      'rank-quintile-1',
      'rank-quintile-2',
      'rank-quintile-3',
      'rank-quintile-4',
      'rank-quintile-5',
      'benchmark-spy',
    ],
    statistics: [
      'observations',
      'distinctAssets',
      'distinctDates',
      'mean',
      'median',
      'positiveFraction',
      'sameDateUniverseMean',
      'meanDifferenceVsUniverse',
      'medianDifferenceVsUniverse',
      'fractionAboveUniverse',
      'meanDifferenceVsBenchmark',
    ],
    breakdowns: ['instrument type', 'asset', 'calendar year of the evaluation date'],
  },
  missingData: {
    substitution: 'none: no forward-fill, interpolation or nearby-session substitution',
    pending: 'the endpoint session is not final at the cutoff',
    missing: 'the asset has no bar at the reference or endpoint session',
    invalid: 'the reference or endpoint bar fails OHLC validation',
    excluded:
      'A member not EVALUATED on D contributes no observation on D and stays in the coverage counts',
  },
  dependence:
    'Consecutive evaluation dates share all but one session of each horizon, standing setups repeat daily, and same-date observations share market moves. Observations are not independent trials; no significance test, p-value or confidence interval is reported.',
  notReported: [
    'portfolio or strategy returns',
    'trade win rates',
    'drawdown',
    'risk-adjusted alpha',
    'profit from risk warnings: a decline after a warning is not profit and no short position is assumed',
  ],
} as const;

/** SHA-256 of the canonical specification: the study's identity in every result. */
export const RESEARCH_SPECIFICATION_ID = createHash('sha256')
  .update(stableSerialize(RESEARCH_SPECIFICATION))
  .digest('hex');

/**
 * v2 re-asks v1's comparisons against a volatility-matched baseline. It was
 * specified after v1's results were seen, so it tests one explanation of them
 * on the same data rather than confirming them. Every v1 convention not
 * restated here is copied unchanged. Frozen; not yet implemented or run.
 */
export const RESEARCH_SPECIFICATION_V2 = {
  ...RESEARCH_SPECIFICATION,
  schemaVersion: '2',
  studyId: 'zerochart-scanner-retrospective-us-equity-v2-volatility',
  basedOn: { studyId: RESEARCH_SPECIFICATION.studyId, specificationId: RESEARCH_SPECIFICATION_ID },
  frozenAt: '2026-10-29T13:54:00.000Z',
  frozenBefore:
    "Specified after v1's results were seen; fixed before any volatility-stratified figure was computed from the export.",
  interpretation:
    "Retrospective historical research on the same export as v1. It tests whether v1's rank, setup and warning differences remain against members of similar volatility; a match or a mismatch explains v1 on this data and is not independent confirmation, prospective evidence, a backtest or a trading result.",
  volatility: {
    measure:
      "ATR(14) / close of the scored window's last bar: the canonical model's own volatilityPercent input on the evaluation date, so no later bar is used",
    terciles:
      'On each evaluation date, within each population: order the EVALUATED members by the measure ascending, ties by ticker in code-unit order; tercile t = ceil(3 x position / members ordered). Tercile 1 is the quietest',
    whyTerciles:
      'Fixed in advance, not tuned: three groups leave about 16 of 50 members (about 12 of 38 stocks) per tercile and date; finer cells would be too thin',
  },
  populations: {
    all: 'Every universe member, as in v1',
    stocks:
      'The 38 stocks only: terciles, ranks and baselines computed among stocks alone, because v1 showed its rank pattern among stocks',
    excluded: 'ETFs alone: 12 members leave four per tercile, too few for a same-date tercile mean',
  },
  signals: {
    ...RESEARCH_SPECIFICATION.signals,
    rankGroups:
      "The scanner's order restricted to the population's EVALUATED members (rank among stocks, for stocks): top5: ranks 1-5; top10: ranks 1-10; rank quintile q = ceil(5 x rank / members ranked that date)",
  },
  comparisons: {
    volatilityMatchedBaseline:
      "Per observation: the mean change of the population's EVALUATED members in the same volatility tercile with an AVAILABLE outcome for that date and horizon, the asset included",
    volatilityTercileBaseline:
      "Volatility-tercile rows compare against the same-date population mean, as v1's groups did, to show how volatility alone was associated with the change",
    benchmarkDifference: "Per observation: the asset's change minus SPY's over the same sessions",
    composition:
      'For each v1 group: the share of its observations in volatility terciles 1, 2 and 3',
    groupsAgainstPopulation: [
      'volatility-tercile-1',
      'volatility-tercile-2',
      'volatility-tercile-3',
    ],
    groupsAgainstVolatilityMatched: [
      'universe',
      'long-setup',
      'long-setup-transition',
      'risk-warning',
      'risk-warning-transition',
      'top5',
      'top10',
      'rank-quintile-1',
      'rank-quintile-2',
      'rank-quintile-3',
      'rank-quintile-4',
      'rank-quintile-5',
    ],
    notRepeated: "v1's same-date universe rows and SPY row: unchanged inputs give v1's figures",
    statistics: [
      'observations',
      'distinctAssets',
      'distinctDates',
      'mean',
      'median',
      'positiveFraction',
      'baselineMean',
      'meanDifferenceVsBaseline',
      'medianDifferenceVsBaseline',
      'fractionAboveBaseline',
      'meanDifferenceVsBenchmark',
    ],
    breakdowns: ['population', 'asset', 'calendar year of the evaluation date'],
  },
  missingData: {
    ...RESEARCH_SPECIFICATION.missingData,
    baseline:
      'An observation whose same-date tercile has no AVAILABLE outcome has no baseline; it is excluded and counted',
  },
} as const;

export const RESEARCH_SPECIFICATION_V2_ID = createHash('sha256')
  .update(stableSerialize(RESEARCH_SPECIFICATION_V2))
  .digest('hex');

export type InstrumentType = 'stock' | 'etf';

/** One universe member as the study sees it: its final bars, or why the export has none. */
export interface ResearchMember {
  ticker: string;
  type: InstrumentType;
  /** Bars final at the cutoff, oldest first; empty when `error` is set. */
  bars: readonly EquityDailyBar[];
  error: ScanFetchError | null;
}

/** One member on one evaluation date, in the scanner's own terms. */
export interface ReplayResult {
  ticker: string;
  status: ScanAssetStatus;
  detail: string | null;
  /** Latest session of the window the result rests on. */
  dataAsOf: string | null;
  rank: number | null;
  score: number | null;
  regime: MarketRegime | null;
  setups: ModelSetups | null;
}

export interface ReplayDate {
  session: string;
  /** Every universe member, by ticker. */
  results: readonly ReplayResult[];
}

export type ResearchOutcome =
  | { status: 'AVAILABLE'; change: number }
  | { status: 'PENDING' | 'MISSING' | 'INVALID'; change: null };

/** Every bar the export holds: `tradingViewSeries` keeps sessions on or after `from`. */
const ALL_SESSIONS = '';

/** Each member's bars final at the cutoff (retrieval start), through the import's own mapping. */
export function researchMembers(file: TradingViewOhlcvExport): ResearchMember[] {
  const cutoff = Date.parse(file.retrieval.startedAt);
  const entries = new Map(file.instruments.map((entry) => [entry.ticker, entry]));
  return selectDevScanUniverse().map((ticker): ResearchMember => {
    const type = US_EQUITY_INSTRUMENTS[ticker] ?? 'stock';
    const exported = exportedSeries(entries.get(ticker), ticker, ALL_SESSIONS);
    if ('error' in exported) return { ticker, type, bars: [], error: exported.error };
    const bars = exported.series.bars
      .filter((bar) => sessionFinalAt(bar.session) <= cutoff)
      .sort((a, b) => compareTickers(a.session, b.session));
    return { ticker, type, bars, error: null };
  });
}

/**
 * The sessions the bars themselves define: TradingView sends no calendar and
 * the published one starts in 2026. Where the published one reaches, the
 * observed sessions must be exactly its sessions up to the latest session
 * final at the cutoff, or the study refuses to rest on them.
 */
export function observedSessions(members: readonly ResearchMember[], cutoff: number): string[] {
  const sessions = [
    ...new Set(members.flatMap((member) => member.bars.map((bar) => bar.session))),
  ].sort(compareTickers);
  const published = sessions.filter(
    (session) => Number(session.slice(0, 4)) >= US_EQUITY_CALENDAR.firstYear,
  );
  const first = published[0];
  const last = published.at(-1);
  const required = latestFinalSession(cutoff);
  if (
    first !== undefined &&
    last !== undefined &&
    (published.join() !== tradingSessions(first, last).join() || last !== required)
  ) {
    throw new Error(
      `Observed sessions ${first}..${last} are not the published calendar's sessions through ${required}.`,
    );
  }
  return sessions;
}

/** The first session on which every member with a full window's worth of bars has one. */
export function firstFullWindowIndex(
  members: readonly ResearchMember[],
  index: ReadonlyMap<string, number>,
): number {
  const full = members.flatMap((member) => {
    const bar = member.bars[SCAN_MIN_CLOSED_CANDLES - 1];
    return bar ? [index.get(bar.session) ?? Number.POSITIVE_INFINITY] : [];
  });
  return Math.max(SCAN_MIN_CLOSED_CANDLES - 1, ...full);
}

/**
 * us-equity-daily-v1's window checks against the observed calendar. Every
 * bar's session is in it by construction, so only OHLC validity, duplicates
 * and gaps remain; the bars carry no split events and are SPLIT-adjusted.
 * Issues are only formatted, which leaves out timestamps, so none is computed.
 */
function windowIssues(
  window: readonly EquityDailyBar[],
  index: ReadonlyMap<string, number>,
): CandleIssue[] {
  const issues: CandleIssue[] = [];
  window.forEach((bar, i) => {
    issues.push(...validatePrices({ ...bar, timestamp: Number.NaN, closeTime: Number.NaN }, i));
    const previous = window[i - 1];
    if (!previous) return;
    const gap = (index.get(bar.session) ?? 0) - (index.get(previous.session) ?? 0);
    if (gap === 0) {
      const detail = `${bar.session} appears more than once; duplicates are not deduplicated.`;
      issues.push(issue('DUPLICATE_SESSION', i, {}, detail));
    } else if (gap > 1) {
      const detail = `${gap - 1} session(s) missing before ${bar.session}; none are filled.`;
      issues.push(issue('MISSING_SESSION', i, {}, detail));
    }
  });
  return issues;
}

/**
 * assessEquity's decision order, on the bars the scan would have requested on
 * the evaluation date; also the model's ATR/close when it scored the member.
 */
function assess(
  member: ResearchMember,
  at: number,
  sessions: readonly string[],
  index: ReadonlyMap<string, number>,
): { result: ReplayResult; volatility: number | null } {
  const result = (value: ReplayResult) => ({ result: value, volatility: null });
  const session = sessions[at] ?? '';
  const base: ReplayResult = {
    ticker: member.ticker,
    status: 'EVALUATED',
    detail: null,
    dataAsOf: null,
    rank: null,
    score: null,
    regime: null,
    setups: null,
  };
  if (member.error)
    return result({ ...base, status: member.error.code, detail: member.error.detail });
  // The scan requests the 200 sessions ending at the evaluation date, then scores the last 199.
  const from = sessions[Math.max(0, at - SCAN_EQUITY_REQUEST_SESSIONS + 1)] ?? '';
  const window = member.bars
    .filter((bar) => bar.session >= from && bar.session <= session)
    .slice(-SCAN_MIN_CLOSED_CANDLES);
  const observed = { ...base, dataAsOf: window.at(-1)?.session ?? null };
  const issues = windowIssues(window, index);
  if (issues.length > 0) {
    const detail = `${US_EQUITY_DAILY_CANDLE_POLICY_VERSION}: ${formatCandleIssues(issues)}`;
    return result({ ...observed, status: 'DATA_INVALID', detail });
  }
  const latest = observed.dataAsOf === null ? undefined : index.get(observed.dataAsOf);
  if (latest !== undefined && latest < at - 1) {
    const detail = `Latest final session is ${observed.dataAsOf}; the scan needs ${session} or the session before it.`;
    return result({ ...observed, status: 'STALE_DATA', detail });
  }
  if (window.length < SCAN_MIN_CLOSED_CANDLES) {
    const detail = `${window.length} final sessions; the scan ranks only full ${SCAN_MIN_CLOSED_CANDLES}-session windows.`;
    return result({ ...observed, status: 'INSUFFICIENT_HISTORY', detail });
  }
  const model = evaluateCandles(window);
  if (model.status !== 'OK') {
    const detail = 'The canonical model had no finite reading on the last closed candle.';
    return result({ ...observed, status: 'INSUFFICIENT_HISTORY', detail });
  }
  return {
    result: {
      ...observed,
      score: model.signal_score,
      regime: model.regime,
      setups: modelSetups(model),
    },
    volatility: model.inputs.volatilityPercent,
  };
}

/**
 * The scan as it would have read on `sessions[at]` (no bar of a later session
 * is passed in), with each EVALUATED member's ATR/close by ticker.
 */
export function replayWithVolatility(
  members: readonly ResearchMember[],
  sessions: readonly string[],
  at: number,
  index: ReadonlyMap<string, number> = new Map(sessions.map((session, i) => [session, i])),
): { date: ReplayDate; volatility: Map<string, number> } {
  const assessed = members.map((member) => assess(member, at, sessions, index));
  const results = assessed.map(({ result }) => result);
  const ranked = results
    .filter((result) => result.score !== null)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || compareTickers(a.ticker, b.ticker));
  const ranks = new Map(ranked.map((result, i) => [result.ticker, i + 1]));
  return {
    date: {
      session: sessions[at] ?? '',
      results: results.map((result) => ({ ...result, rank: ranks.get(result.ticker) ?? null })),
    },
    volatility: new Map(
      assessed.flatMap(({ result, volatility }) =>
        volatility === null ? [] : [[result.ticker, volatility] as const],
      ),
    ),
  };
}

/** The scan as it would have read on `sessions[at]`: no bar of a later session is passed in. */
export function replayDate(
  members: readonly ResearchMember[],
  sessions: readonly string[],
  at: number,
  index?: ReadonlyMap<string, number>,
): ReplayDate {
  return replayWithVolatility(members, sessions, at, index).date;
}

/** Session → the member's one bar for it, or null when it has more than one. */
export function barsBySession(bars: readonly EquityDailyBar[]): Map<string, EquityDailyBar | null> {
  const map = new Map<string, EquityDailyBar | null>();
  for (const bar of bars) map.set(bar.session, map.has(bar.session) ? null : bar);
  return map;
}

function validBar(bar: EquityDailyBar | null): bar is EquityDailyBar {
  return bar !== null && validatePrices({ ...bar, timestamp: 0, closeTime: 0 }, 0).length === 0;
}

/**
 * OPEN of the session after `sessions[at]` to OPEN `horizon` sessions later.
 * The evaluation date's own close is never the reference.
 */
export function measureOutcome(
  bars: ReadonlyMap<string, EquityDailyBar | null>,
  sessions: readonly string[],
  at: number,
  horizon: number,
): ResearchOutcome {
  const reference = sessions[at + 1];
  const endpoint = sessions[at + 1 + horizon];
  if (reference === undefined || endpoint === undefined) return { status: 'PENDING', change: null };
  const start = bars.get(reference);
  const end = bars.get(endpoint);
  if (start === undefined || end === undefined) return { status: 'MISSING', change: null };
  if (!validBar(start) || !validBar(end)) return { status: 'INVALID', change: null };
  return { status: 'AVAILABLE', change: (end.open / start.open - 1) * 100 };
}

export interface ParityCheck {
  status: 'MATCH' | 'MISMATCH' | 'NOT_COMPARABLE';
  datesCompared: number;
  first: string | null;
  last: string | null;
  mismatches: Array<{
    session: string;
    ticker: string;
    field: string;
    replay: unknown;
    scanner: unknown;
  }>;
}

/**
 * Runs the actual scanner (importInputs + evaluateScan, the published
 * calendar's validator) on every replayed date it can serve, and compares.
 */
export function scannerParity(
  file: TradingViewOhlcvExport,
  replay: readonly ReplayDate[],
): ParityCheck {
  const compared = replay.filter(
    (date) => equityRequestRange(sessionFinalAt(date.session))?.to === date.session,
  );
  const mismatches: ParityCheck['mismatches'] = [];
  for (const date of compared) {
    const evaluationTime = sessionFinalAt(date.session);
    const scan = evaluateScan(importInputs(file, evaluationTime), {
      evaluationTime,
      universeSource: TRADINGVIEW_DEV_UNIVERSE_SOURCE,
      equityProvider: TRADINGVIEW_DEV_PROVIDER_ID,
    });
    const scanned = new Map(scan.results.map((result) => [result.ticker, result]));
    for (const result of date.results) {
      const actual = scanned.get(result.ticker);
      const fields: Record<string, [unknown, unknown]> = {
        status: [result.status, actual?.status],
        dataAsOf: [
          result.dataAsOf === null ? null : sessionClose(result.dataAsOf),
          actual?.dataAsOf,
        ],
        rank: [result.rank, actual?.rank],
        score: [result.score, actual?.model?.signal_score ?? null],
        regime: [result.regime, actual?.model?.regime ?? null],
        setups: [result.setups, actual?.setups],
      };
      for (const [field, [replayed, scanner]] of Object.entries(fields)) {
        if (stableSerialize(replayed) !== stableSerialize(scanner)) {
          mismatches.push({
            session: date.session,
            ticker: result.ticker,
            field,
            replay: replayed,
            scanner,
          });
        }
      }
    }
  }
  let status: ParityCheck['status'] = mismatches.length === 0 ? 'MATCH' : 'MISMATCH';
  if (compared.length === 0) status = 'NOT_COMPARABLE';
  return {
    status,
    datesCompared: compared.length,
    first: compared[0]?.session ?? null,
    last: compared.at(-1)?.session ?? null,
    mismatches,
  };
}

/** An EVALUATED member on one evaluation date, with what followed. */
export interface StudyObservation {
  ticker: string;
  type: InstrumentType;
  session: string;
  rank: number;
  quintile: number;
  long: boolean;
  risk: boolean;
  longTransition: boolean;
  riskTransition: boolean;
  /** Set when the condition holds but the previous date was not evaluated: onset unknown. */
  longOnsetUnknown: boolean;
  riskOnsetUnknown: boolean;
  outcomes: Record<ResearchHorizon, ResearchOutcome>;
}

/**
 * Asset-date observations from consecutive replayed dates. A condition is a
 * transition only when the same member was EVALUATED the date before without it.
 */
export function studyObservations(
  replay: readonly ReplayDate[],
  types: ReadonlyMap<string, InstrumentType>,
  outcomeOf: (ticker: string, date: number, horizon: ResearchHorizon) => ResearchOutcome,
): StudyObservation[] {
  return replay.flatMap((date, k) => {
    const previous = new Map(
      (replay[k - 1]?.results ?? []).map((result) => [result.ticker, result]),
    );
    const evaluated = date.results.filter((result) => result.rank !== null);
    return evaluated.map((result): StudyObservation => {
      const before = previous.get(result.ticker);
      const known = before?.status === 'EVALUATED';
      const long = result.setups?.long ?? false;
      const risk = result.setups?.risk ?? false;
      const rank = result.rank ?? 0;
      return {
        ticker: result.ticker,
        type: types.get(result.ticker) ?? 'stock',
        session: date.session,
        rank,
        quintile: Math.ceil((5 * rank) / evaluated.length),
        long,
        risk,
        longTransition: long && known && before.setups?.long === false,
        riskTransition: risk && known && before.setups?.risk === false,
        longOnsetUnknown: long && !known,
        riskOnsetUnknown: risk && !known,
        outcomes: Object.fromEntries(
          RESEARCH_HORIZONS.map((horizon) => [horizon, outcomeOf(result.ticker, k, horizon)]),
        ) as Record<ResearchHorizon, ResearchOutcome>,
      };
    });
  });
}

export type GroupId = (typeof RESEARCH_SPECIFICATION.comparisons.groups)[number];
export type MemberGroupId = Exclude<GroupId, 'benchmark-spy'>;

export const GROUP_MEMBERSHIP: Record<MemberGroupId, (observation: StudyObservation) => boolean> = {
  universe: () => true,
  'long-setup': (o) => o.long,
  'long-setup-transition': (o) => o.longTransition,
  'risk-warning': (o) => o.risk,
  'risk-warning-transition': (o) => o.riskTransition,
  top5: (o) => o.rank <= 5,
  top10: (o) => o.rank <= 10,
  'rank-quintile-1': (o) => o.quintile === 1,
  'rank-quintile-2': (o) => o.quintile === 2,
  'rank-quintile-3': (o) => o.quintile === 3,
  'rank-quintile-4': (o) => o.quintile === 4,
  'rank-quintile-5': (o) => o.quintile === 5,
};
export const MEMBER_GROUPS = Object.keys(GROUP_MEMBERSHIP) as MemberGroupId[];

/** One measured change with what it is compared against on the same date. */
export interface ResearchPoint {
  ticker: string;
  session: string;
  change: number;
  baseline: number;
  benchmark: number | null;
}

export interface GroupStats {
  observations: number;
  distinctAssets: number;
  distinctDates: number;
  mean: number | null;
  median: number | null;
  positiveFraction: number | null;
  sameDateUniverseMean: number | null;
  meanDifferenceVsUniverse: number | null;
  medianDifferenceVsUniverse: number | null;
  fractionAboveUniverse: number | null;
  meanDifferenceVsBenchmark: number | null;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return null;
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? null)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function fraction(flags: readonly boolean[]): number | null {
  return flags.length === 0 ? null : flags.filter(Boolean).length / flags.length;
}

export function summarize(points: readonly ResearchPoint[]): GroupStats {
  const changes = points.map((point) => point.change);
  const differences = points.map((point) => point.change - point.baseline);
  const benchmarked = points.flatMap((point) =>
    point.benchmark === null ? [] : [point.change - point.benchmark],
  );
  return {
    observations: points.length,
    distinctAssets: new Set(points.map((point) => point.ticker)).size,
    distinctDates: new Set(points.map((point) => point.session)).size,
    mean: mean(changes),
    median: median(changes),
    positiveFraction: fraction(changes.map((change) => change > 0)),
    sameDateUniverseMean: mean(points.map((point) => point.baseline)),
    meanDifferenceVsUniverse: mean(differences),
    medianDifferenceVsUniverse: median(differences),
    fractionAboveUniverse: fraction(differences.map((difference) => difference > 0)),
    meanDifferenceVsBenchmark: mean(benchmarked),
  };
}

export function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

/** How much of a group one asset, or a few, make up. */
export function concentration(points: readonly ResearchPoint[]): {
  largestAssetShare: number | null;
  assetsForHalf: number | null;
} {
  if (points.length === 0) return { largestAssetShare: null, assetsForHalf: null };
  const counts = [...groupBy(points, (point) => point.ticker).values()]
    .map((group) => group.length)
    .sort((a, b) => b - a);
  let covered = 0;
  let assets = 0;
  for (const count of counts) {
    if (covered * 2 >= points.length) break;
    covered += count;
    assets += 1;
  }
  return { largestAssetShare: (counts[0] ?? 0) / points.length, assetsForHalf: assets };
}

export interface HorizonResults {
  horizon: ResearchHorizon;
  /** Outcome status of every EVALUATED asset-date. */
  outcomes: Record<ResearchOutcome['status'], number>;
  groups: Record<GroupId, GroupStats>;
  byType: Record<MemberGroupId, Record<InstrumentType, GroupStats>>;
  byYear: Record<GroupId, Record<string, GroupStats>>;
  byAsset: Record<
    MemberGroupId,
    { concentration: ReturnType<typeof concentration>; assets: Record<string, GroupStats> }
  >;
}

export function meansBy<T extends StudyObservation>(
  observations: readonly T[],
  horizon: ResearchHorizon,
  key: (observation: T) => string,
): Map<string, number> {
  return new Map(
    [...groupBy(observations, key)].map(([group, members]) => [
      group,
      mean(members.map((member) => member.outcomes[horizon].change ?? Number.NaN)) ?? Number.NaN,
    ]),
  );
}

function byYear(points: readonly ResearchPoint[]): Record<string, GroupStats> {
  return Object.fromEntries(
    [...groupBy(points, (point) => point.session.slice(0, 4))]
      .sort(([a], [b]) => compareTickers(a, b))
      .map(([year, group]) => [year, summarize(group)]),
  );
}

export function horizonResults(
  observations: readonly StudyObservation[],
  horizon: ResearchHorizon,
  benchmark: ReadonlyMap<string, number | null>,
): HorizonResults {
  const outcomes = { AVAILABLE: 0, PENDING: 0, MISSING: 0, INVALID: 0 };
  for (const observation of observations) outcomes[observation.outcomes[horizon].status] += 1;
  const measured = observations.filter((o) => o.outcomes[horizon].status === 'AVAILABLE');
  const dateMeans = meansBy(measured, horizon, (o) => o.session);
  const typeMeans = meansBy(measured, horizon, (o) => `${o.session}|${o.type}`);
  const point = (o: StudyObservation, baseline: number | undefined): ResearchPoint => ({
    ticker: o.ticker,
    session: o.session,
    change: o.outcomes[horizon].change ?? Number.NaN,
    baseline: baseline ?? Number.NaN,
    benchmark: benchmark.get(o.session) ?? null,
  });
  const pointsOf = (id: MemberGroupId) =>
    measured.filter(GROUP_MEMBERSHIP[id]).map((o) => point(o, dateMeans.get(o.session)));
  const benchmarkPoints = [...benchmark].flatMap(([session, change]): ResearchPoint[] => {
    const baseline = dateMeans.get(session);
    return change === null || baseline === undefined
      ? []
      : [{ ticker: 'SPY', session, change, baseline, benchmark: change }];
  });
  const memberGroups = (build: (id: MemberGroupId) => unknown) =>
    Object.fromEntries(MEMBER_GROUPS.map((id) => [id, build(id)]));
  return {
    horizon,
    outcomes,
    groups: {
      ...memberGroups((id) => summarize(pointsOf(id))),
      'benchmark-spy': summarize(benchmarkPoints),
    } as HorizonResults['groups'],
    byType: memberGroups((id) => {
      const typed = (type: InstrumentType) =>
        measured
          .filter((o) => o.type === type && GROUP_MEMBERSHIP[id](o))
          .map((o) => point(o, typeMeans.get(`${o.session}|${type}`)));
      return { stock: summarize(typed('stock')), etf: summarize(typed('etf')) };
    }) as HorizonResults['byType'],
    byYear: {
      ...memberGroups((id) => byYear(pointsOf(id))),
      'benchmark-spy': byYear(benchmarkPoints),
    } as HorizonResults['byYear'],
    byAsset: memberGroups((id) => {
      const points = pointsOf(id);
      return {
        concentration: concentration(points),
        assets: Object.fromEntries(
          [...groupBy(points, (p) => p.ticker)]
            .sort(([a], [b]) => compareTickers(a, b))
            .map(([ticker, group]) => [ticker, summarize(group)]),
        ),
      };
    }) as HorizonResults['byAsset'],
  };
}

export interface StudyResults {
  schemaVersion: '1';
  specificationId: string;
  studyId: string;
  evidenceType: string;
  specification: typeof RESEARCH_SPECIFICATION;
  export: { sha256: string; retrieval: TradingViewOhlcvExport['retrieval'] };
  calendar: { observedSessions: number; first: string | null; last: string | null };
  evaluationDates: { count: number; first: string | null; last: string | null };
  parity: ParityCheck;
  coverage: {
    members: number;
    types: Record<InstrumentType, number>;
    assetDates: number;
    byStatus: Record<ScanAssetStatus, number>;
    fullyEvaluatedDates: number;
    minEvaluatedPerDate: number | null;
    /** Members not EVALUATED on some date, with how often and why. */
    exclusions: Record<string, Partial<Record<ScanAssetStatus, number>>>;
    signals: Record<
      'long' | 'risk',
      { observations: number; transitions: number; onsetUnknown: number; standing: number }
    >;
  };
  horizons: HorizonResults[];
  replay: ReplayDate[];
}

const STATUSES: readonly ScanAssetStatus[] = [
  'EVALUATED',
  'UNSUPPORTED',
  'FETCH_FAILED',
  'RATE_LIMITED',
  'DATA_INVALID',
  'STALE_DATA',
  'INSUFFICIENT_HISTORY',
];

function coverageOf(
  members: readonly ResearchMember[],
  replay: readonly ReplayDate[],
  observations: readonly StudyObservation[],
): StudyResults['coverage'] {
  const byStatus = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<
    ScanAssetStatus,
    number
  >;
  const exclusions: StudyResults['coverage']['exclusions'] = {};
  for (const result of replay.flatMap((date) => date.results)) {
    byStatus[result.status] += 1;
    if (result.status === 'EVALUATED') continue;
    const counts = (exclusions[result.ticker] ??= {});
    counts[result.status] = (counts[result.status] ?? 0) + 1;
  }
  const evaluatedPerDate = replay.map(
    (date) => date.results.filter((result) => result.status === 'EVALUATED').length,
  );
  const signal = (holds: 'long' | 'risk') => {
    const held = observations.filter((o) => o[holds]);
    const transitions = held.filter((o) => o[`${holds}Transition`]).length;
    const onsetUnknown = held.filter((o) => o[`${holds}OnsetUnknown`]).length;
    return {
      observations: held.length,
      transitions,
      onsetUnknown,
      standing: held.length - transitions - onsetUnknown,
    };
  };
  return {
    members: members.length,
    types: {
      stock: members.filter((member) => member.type === 'stock').length,
      etf: members.filter((member) => member.type === 'etf').length,
    },
    assetDates: replay.length * members.length,
    byStatus,
    fullyEvaluatedDates: evaluatedPerDate.filter((count) => count === members.length).length,
    minEvaluatedPerDate: evaluatedPerDate.length > 0 ? Math.min(...evaluatedPerDate) : null,
    exclusions,
    signals: { long: signal('long'), risk: signal('risk') },
  };
}

/** What every study version shares: the replay, its observations and SPY's outcomes. */
export interface PreparedStudy {
  members: ResearchMember[];
  sessions: string[];
  replay: ReplayDate[];
  /** Per replayed date: each EVALUATED member's ATR/close. */
  volatility: ReadonlyMap<string, number>[];
  observations: StudyObservation[];
  /** SPY's change per evaluation date for one horizon. */
  benchmark: (horizon: ResearchHorizon) => Map<string, number | null>;
}

export function prepareStudy(file: TradingViewOhlcvExport): PreparedStudy {
  const cutoff = Date.parse(file.retrieval.startedAt);
  const members = researchMembers(file);
  const sessions = observedSessions(members, cutoff);
  const index = new Map(sessions.map((session, i) => [session, i]));
  const start = firstFullWindowIndex(members, index);
  const replayed = sessions
    .slice(start)
    .map((_, k) => replayWithVolatility(members, sessions, start + k, index));
  const replay = replayed.map(({ date }) => date);
  const bars = new Map(members.map((member) => [member.ticker, barsBySession(member.bars)]));
  const outcome = (ticker: string, k: number, horizon: number) =>
    measureOutcome(bars.get(ticker) ?? new Map(), sessions, start + k, horizon);
  return {
    members,
    sessions,
    replay,
    volatility: replayed.map(({ volatility }) => volatility),
    observations: studyObservations(
      replay,
      new Map(members.map((member) => [member.ticker, member.type])),
      outcome,
    ),
    benchmark: (horizon) =>
      new Map(replay.map((date, k) => [date.session, outcome('SPY', k, horizon).change])),
  };
}

/** The coverage and identity every study version reports first. */
export function studyBase(
  file: TradingViewOhlcvExport,
  exportSha256: string,
  study: PreparedStudy,
) {
  const { members, sessions, replay, observations } = study;
  return {
    export: { sha256: exportSha256, retrieval: file.retrieval },
    calendar: {
      observedSessions: sessions.length,
      first: sessions[0] ?? null,
      last: sessions.at(-1) ?? null,
    },
    evaluationDates: {
      count: replay.length,
      first: replay[0]?.session ?? null,
      last: replay.at(-1)?.session ?? null,
    },
    parity: scannerParity(file, replay),
    coverage: coverageOf(members, replay, observations),
  };
}

/** The whole study on one parsed export. Pure: the same export always gives the same results. */
export function runStudy(file: TradingViewOhlcvExport, exportSha256: string): StudyResults {
  const study = prepareStudy(file);
  const {
    export: exported,
    calendar,
    evaluationDates,
    parity,
    coverage,
  } = studyBase(file, exportSha256, study);
  return {
    schemaVersion: '1',
    specificationId: RESEARCH_SPECIFICATION_ID,
    studyId: RESEARCH_SPECIFICATION.studyId,
    evidenceType: RESEARCH_SPECIFICATION.evidenceType,
    specification: RESEARCH_SPECIFICATION,
    export: exported,
    calendar,
    evaluationDates,
    parity,
    coverage,
    horizons: RESEARCH_HORIZONS.map((horizon) =>
      horizonResults(study.observations, horizon, study.benchmark(horizon)),
    ),
    replay: study.replay,
  };
}

/** Writes results once; a rerun must reproduce them byte for byte. */
export async function saveResearchResults(
  path: string,
  content: string,
): Promise<'CREATED' | 'UNCHANGED' | 'CONFLICT'> {
  await mkdir(resolve(path, '..'), { recursive: true });
  try {
    await writeFile(path, content, { flag: 'wx' });
    return 'CREATED';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return (await readFile(path, 'utf8')) === content ? 'UNCHANGED' : 'CONFLICT';
  }
}

/** The run must rest on exactly what the specification froze, or it is not this study. */
export function frozenFactDifferences(
  results: Pick<StudyResults, 'calendar' | 'evaluationDates' | 'export' | 'parity'>,
): string[] {
  const spec = RESEARCH_SPECIFICATION;
  const expected: Record<string, [unknown, unknown]> = {
    'calendar.observedSessions': [
      results.calendar.observedSessions,
      spec.calendar.observedSessions,
    ],
    'calendar.firstSession': [results.calendar.first, spec.calendar.firstSession],
    'calendar.lastSession': [results.calendar.last, spec.calendar.lastSession],
    'evaluationDates.first': [results.evaluationDates.first, spec.evaluationDates.first],
    'evaluationDates.last': [results.evaluationDates.last, spec.evaluationDates.last],
    'evaluationDates.count': [results.evaluationDates.count, spec.evaluationDates.count],
    'data.retrieval': [
      stableSerialize(results.export.retrieval),
      stableSerialize(spec.data.retrieval),
    ],
    'parity.status': [results.parity.status, 'MATCH'],
  };
  return Object.entries(expected).flatMap(([field, [actual, frozen]]) =>
    actual === frozen ? [] : [`${field}: ${String(actual)} (frozen ${String(frozen)})`],
  );
}

/** Aggregates only: no ticker, price or per-asset figure, so it can be shared after review. */
export function researchSummary(results: StudyResults) {
  const { exclusions, ...coverage } = results.coverage;
  return {
    specificationId: results.specificationId,
    studyId: results.studyId,
    evidenceType: results.evidenceType,
    calendar: results.calendar,
    evaluationDates: results.evaluationDates,
    parity: { ...results.parity, mismatches: results.parity.mismatches.length },
    coverage: { ...coverage, membersWithExclusions: Object.keys(exclusions).length },
    horizons: results.horizons.map(({ horizon, outcomes, groups, byType }) => ({
      horizon,
      outcomes,
      groups,
      byType,
    })),
  };
}

export const RESEARCH_OUTPUT_DIR = '.zerochart-reports';

export async function runScannerResearch(options: {
  file: string;
  outputDir: string;
  repositoryCommit: string;
  now?: () => number;
}) {
  const { file, exportSha256 } = await loadFrozenExport(options.file);
  const results = runStudy(file, exportSha256);
  return {
    ...(await writeStudy(results, RESEARCH_SPECIFICATION_ID, options, renderScannerResearchReport)),
    results,
  };
}

/** The parsed export, only if it is the file every study version was frozen on. */
export async function loadFrozenExport(path: string) {
  const raw = await readFile(path);
  const exportSha256 = createHash('sha256').update(raw).digest('hex');
  if (exportSha256 !== RESEARCH_SPECIFICATION.data.exportSha256) {
    throw new Error(
      `The study is frozen on export ${RESEARCH_SPECIFICATION.data.exportSha256}; this file is ${exportSha256}.`,
    );
  }
  return { file: parseExport(JSON.parse(raw.toString('utf8'))), exportSha256 };
}

/**
 * Refuses results that depart from the frozen facts, writes them once under
 * the specification's ID, and renders the private report unless they conflict.
 */
export async function writeStudy<T extends Parameters<typeof frozenFactDifferences>[0]>(
  results: T,
  specificationId: string,
  options: { outputDir: string; repositoryCommit: string; now?: () => number },
  render: (
    results: T,
    meta: { generatedAt: string; repositoryCommit: string; resultHash: string },
  ) => string,
) {
  const differences = frozenFactDifferences(results);
  if (differences.length > 0) {
    const sample = results.parity.mismatches.slice(0, 5).map((item) => JSON.stringify(item));
    throw new Error(
      `The run departs from the frozen study: ${[...differences, ...sample].join('; ')}`,
    );
  }
  const content = `${JSON.stringify(results)}\n`;
  const resultHash = createHash('sha256').update(content).digest('hex');
  const name = `scanner-research-${specificationId.slice(0, 12)}`;
  const root = resolve(options.outputDir);
  const resultsPath = join(root, `${name}.json`);
  const status = await saveResearchResults(resultsPath, content);
  const reportPath = join(root, `${name}.html`);
  if (status !== 'CONFLICT') {
    const html = render(results, {
      generatedAt: new Date((options.now ?? Date.now)()).toISOString(),
      repositoryCommit: options.repositoryCommit,
      resultHash,
    });
    await writeFile(reportPath, html, 'utf8');
  }
  return { status, resultHash, resultsPath, reportPath };
}
