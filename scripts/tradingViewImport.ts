import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CandleProviderDataError } from '@/lib/binance';
import {
  compareTickers,
  EQUITY_CALENDAR_ERROR,
  equityRequestRange,
  type ScanFetchError,
  type ScanInput,
} from '@/lib/marketScanner';
import {
  TRADINGVIEW_DEV_PROVIDER_ID,
  TRADINGVIEW_DEV_SCAN_FILE,
  TRADINGVIEW_DEV_SCAN_KIND,
  TRADINGVIEW_DEV_UNIVERSE_SOURCE,
  type TradingViewDevScan,
} from '@/lib/tradingViewDevScan';
import {
  latestFinalSession,
  sessionOpen,
  US_EQUITY_INSTRUMENTS,
  usEquityInstrument,
  type EquityDailyBar,
  type EquityDailySeries,
} from '@/lib/usEquityDaily';
import { saveScan, type ScanSnapshot } from './marketScanStore';

/**
 * The local handoff between the owner's agent session and the scanner. The
 * agent calls TradingView's MCP `get_ohlcv` and writes each response verbatim
 * into one export file (git-ignored `.zerochart-tradingview/`); this module
 * maps it into the us-equity-daily-v1 seam, scores it with the canonical
 * engine and writes an ordinary scan snapshot plus the file the Markets page
 * shows in development. Nothing here calls TradingView.
 */

export const DEV_SCAN_SIZE = 50;
export const SELECTION_RULE =
  'The 50 configured US equities and ETFs (US_EQUITY_INSTRUMENTS, the 90 equity rows of assets_status) with the lowest sha256(ticker) hex digests, fixed before any data was fetched or scored.';

/** Deterministic and blind to outcomes: the digest of the ticker alone orders the universe. */
export function selectDevScanUniverse(
  tickers: readonly string[] = Object.keys(US_EQUITY_INSTRUMENTS),
): string[] {
  const digest = (ticker: string) => createHash('sha256').update(ticker).digest('hex');
  return tickers
    .filter((ticker) => Object.hasOwn(US_EQUITY_INSTRUMENTS, ticker))
    .map((ticker) => [digest(ticker), ticker] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(0, DEV_SCAN_SIZE)
    .map(([, ticker]) => ticker)
    .sort(compareTickers);
}

/**
 * Resolved one by one with TradingView's `search_symbols` on 2026-10-29: each
 * ticker had exactly one listing on a US primary venue (NASDAQ, NYSE, AMEX =
 * NYSE Arca, CBOE = Cboe BZX). Off-exchange (BOATS, BCS, Pyth), CFD and foreign
 * listings were excluded. An exchange is never inferred from the ticker.
 */
export const TRADINGVIEW_SYMBOLS: Readonly<Record<string, string>> = Object.fromEntries(
  'NASDAQ:AAL NASDAQ:AAPL NYSE:ABBV NASDAQ:ABNB NYSE:ACN NASDAQ:AMD NASDAQ:AMZN CBOE:ARKK NYSE:AXP NYSE:BA NYSE:BAC NYSE:C NYSE:CAT NYSE:CRM NASDAQ:CSCO AMEX:GLD NYSE:GS NYSE:HD NASDAQ:HOOD NYSE:IBM NASDAQ:INTC AMEX:IWM NYSE:KO NASDAQ:META NYSE:MRK NYSE:MS NASDAQ:MSFT NYSE:NKE NASDAQ:NVDA NYSE:ORCL NYSE:PFE NYSE:PG NYSE:PINS NASDAQ:PLTR NASDAQ:RIVN NYSE:RTX NASDAQ:SHOP AMEX:SLV NYSE:SNAP AMEX:SPY NASDAQ:TSLA NYSE:UNH AMEX:VOO AMEX:VTI NYSE:VZ AMEX:XLB AMEX:XLE AMEX:XLP AMEX:XLU AMEX:XLY'
    .split(' ')
    .map((symbol) => [symbol.slice(symbol.indexOf(':') + 1), symbol]),
);

/** What the agent writes: one entry per selected ticker, the MCP response verbatim or its error. */
export interface TradingViewOhlcvExport {
  schemaVersion: '1';
  source: 'tradingview-mcp';
  retrieval: { startedAt: string; completedAt: string };
  pineAlerts?: { checkedAt: string; symbols: string[] } | null;
  instruments: Array<{
    ticker: string;
    symbol: string;
    /** When the agent received the response. */
    receivedAt?: string;
    response?: unknown;
    error?: string;
  }>;
}

interface OhlcvResponse {
  success?: unknown;
  symbol?: unknown;
  interval?: unknown;
  notice?: unknown;
  bars?: unknown;
}

const NEW_YORK_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });

function iso(time: number): string {
  return new Date(time).toISOString();
}

/**
 * Maps one `get_ohlcv` 1D response into the us-equity-daily-v1 seam. The
 * adjustment basis comes only from TradingView's notice. A daily bar's `t` must
 * be its session's 09:30 New York open (observed on 2026-10-29), so a bar keyed
 * any other way is rejected, never re-dated. Bars before `from` are dropped;
 * later ones are kept for the validator to exclude and count.
 */
export function tradingViewSeries(
  response: unknown,
  expected: { symbol: string; from: string },
): EquityDailySeries {
  const body = (response ?? {}) as OhlcvResponse;
  if (body.success !== true) throw new Error(`get_ohlcv did not succeed for ${expected.symbol}`);
  if (body.symbol !== expected.symbol) {
    throw new CandleProviderDataError(
      `the response is for ${String(body.symbol)}, not ${expected.symbol}`,
    );
  }
  if (body.interval !== '1D') {
    throw new CandleProviderDataError(`interval ${String(body.interval)}, not 1D`);
  }
  const notice = typeof body.notice === 'string' ? body.notice : '';
  if (!/split-adjusted only/i.test(notice) || !/regular session only/i.test(notice)) {
    throw new CandleProviderDataError(
      'TradingView did not state split-adjusted, regular-session bars, so the adjustment basis is unresolved',
    );
  }
  if (!Array.isArray(body.bars)) throw new CandleProviderDataError('no bars array');
  const bars: EquityDailyBar[] = [];
  for (const row of body.bars as Array<Record<string, unknown> | null>) {
    const values = [row?.['t'], row?.['o'], row?.['h'], row?.['l'], row?.['c'], row?.['v']];
    if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      throw new CandleProviderDataError(`non-numeric bar ${JSON.stringify(row)}`);
    }
    const [t, open, high, low, close, volume] = values as number[];
    const time = t! * 1000;
    const session = NEW_YORK_DATE.format(time);
    if (session < expected.from) continue;
    if (sessionOpen(session) !== time) {
      throw new CandleProviderDataError(
        `bar t=${t} (${iso(time)}) is not the 09:30 America/New_York open of ${session}`,
      );
    }
    bars.push({ session, open: open!, high: high!, low: low!, close: close!, volume: volume! });
  }
  // TradingView's OHLCV reports no split events, so UNADJUSTED_SPLIT cannot be checked.
  return { adjustment: 'SPLIT', bars, splits: [] };
}

function invalid(message: string): never {
  throw new Error(`Invalid TradingView export: ${message}`);
}

/** NaN-safe: an unparseable time is never inside the window. */
function within(time: number, from: number, to: number): boolean {
  return Number.isFinite(time) && time >= from && time <= to;
}

function checkEntry(
  entry: TradingViewOhlcvExport['instruments'][number] | null,
  seen: Set<string>,
  window: { from: number; to: number },
): void {
  if (typeof entry?.ticker !== 'string' || typeof entry.symbol !== 'string')
    invalid('every instrument needs ticker and symbol');
  if (!Object.hasOwn(TRADINGVIEW_SYMBOLS, entry.ticker))
    invalid(`${entry.ticker} is not in the dev-scan universe`);
  if (seen.has(entry.ticker)) invalid(`${entry.ticker} appears twice`);
  seen.add(entry.ticker);
  if (
    entry.response !== undefined &&
    !within(Date.parse(entry.receivedAt ?? ''), window.from, window.to)
  )
    invalid(`${entry.ticker}: receivedAt must fall inside the retrieval window`);
}

/** Trust-boundary check on the agent's file; the bars themselves are checked per instrument. */
export function parseExport(raw: unknown): TradingViewOhlcvExport {
  const file = raw as Partial<TradingViewOhlcvExport> | null;
  if (file?.schemaVersion !== '1' || file.source !== 'tradingview-mcp')
    invalid('schemaVersion 1, source tradingview-mcp expected');
  const from = Date.parse(file.retrieval?.startedAt ?? '');
  const to = Date.parse(file.retrieval?.completedAt ?? '');
  if (!within(from, from, to)) invalid('retrieval.startedAt/completedAt are not ordered ISO times');
  if (!Array.isArray(file.instruments)) invalid('instruments must be an array');
  const seen = new Set<string>();
  for (const entry of file.instruments) checkEntry(entry, seen, { from, to });
  return file as TradingViewOhlcvExport;
}

function failure(error: unknown): ScanFetchError {
  if (error instanceof CandleProviderDataError) {
    return { code: 'DATA_INVALID', detail: `MALFORMED_PROVIDER_ROW: ${error.message}` };
  }
  return { code: 'FETCH_FAILED', detail: error instanceof Error ? error.message : String(error) };
}

/** One scan input per selected ticker: a series, or the reason there is none. Never drops one. */
export function importInputs(file: TradingViewOhlcvExport, evaluationTime: number): ScanInput[] {
  const range = equityRequestRange(evaluationTime);
  const entries = new Map(file.instruments.map((entry) => [entry.ticker, entry]));
  return selectDevScanUniverse().map((ticker): ScanInput => {
    const input: ScanInput = { ticker, instrument: usEquityInstrument(ticker) };
    if (range === null) return { ...input, error: EQUITY_CALENDAR_ERROR };
    input.equity = { provider: TRADINGVIEW_DEV_PROVIDER_ID, range };
    const symbol = TRADINGVIEW_SYMBOLS[ticker]!;
    const entry = entries.get(ticker);
    if (!entry) {
      return {
        ...input,
        error: { code: 'FETCH_FAILED', detail: `${symbol} was never retrieved.` },
      };
    }
    if (entry.symbol !== symbol) {
      const detail = `${entry.symbol} was retrieved; the instrument map names ${symbol}.`;
      return { ...input, error: { code: 'DATA_INVALID', detail } };
    }
    if (entry.response === undefined) {
      const detail = `TradingView get_ohlcv (${symbol}): ${entry.error ?? 'no response recorded'}`;
      return { ...input, error: { code: 'FETCH_FAILED', detail } };
    }
    try {
      const series = tradingViewSeries(entry.response, { symbol, from: range.from });
      Object.assign(input.equity, {
        series,
        fetchedAt: Date.parse(entry.receivedAt!),
        cached: false,
      });
      return input;
    } catch (error) {
      return { ...input, error: failure(error) };
    }
  });
}

/**
 * Scores an export and records it. The evaluation time is when retrieval
 * ended; a retrieval during which another session became final is refused, so
 * every symbol rests on the same required session.
 */
export async function importTradingViewScan(options: {
  file: string;
  store: string;
  repositoryCommit: string;
  now?: () => number;
}): Promise<{ path: string; snapshot: ScanSnapshot; view: TradingViewDevScan }> {
  const file = parseExport(JSON.parse(await readFile(options.file, 'utf8')));
  const startedAt = Date.parse(file.retrieval.startedAt);
  const evaluationTime = Date.parse(file.retrieval.completedAt);
  if (latestFinalSession(startedAt) !== latestFinalSession(evaluationTime)) {
    throw new Error(
      `A session became final during retrieval (${file.retrieval.startedAt} → ${file.retrieval.completedAt}); retrieve again.`,
    );
  }
  const inputs = importInputs(file, evaluationTime);
  const { path, snapshot } = await saveScan({
    inputs,
    evaluationTime,
    universeSource: TRADINGVIEW_DEV_UNIVERSE_SOURCE,
    equityProvider: TRADINGVIEW_DEV_PROVIDER_ID,
    repositoryCommit: options.repositoryCommit,
    store: options.store,
    completedAt: (options.now ?? Date.now)(),
  });
  const notices = file.instruments.flatMap((entry) => {
    const notice = (entry.response as OhlcvResponse | undefined)?.notice;
    return typeof notice === 'string' ? [notice] : [];
  });
  const view: TradingViewDevScan = {
    kind: TRADINGVIEW_DEV_SCAN_KIND,
    scanId: snapshot.scanId,
    importedAt: snapshot.completedAt,
    source: {
      tool: 'get_ohlcv',
      interval: '1D',
      retrieval: file.retrieval,
      symbols: TRADINGVIEW_SYMBOLS,
      notice: [...new Set(notices)].join('\n') || 'No market-data notice was returned.',
      selectionRule: SELECTION_RULE,
      pineAlerts: file.pineAlerts ?? null,
    },
    scan: snapshot.scan,
  };
  await writeFile(
    join(resolve(options.store), TRADINGVIEW_DEV_SCAN_FILE),
    `${JSON.stringify(view, null, 2)}\n`,
  );
  return { path, snapshot, view };
}
