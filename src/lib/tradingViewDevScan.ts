/**
 * The TradingView development scan as the Markets page shows it: one local,
 * owner-initiated scan whose daily bars the owner's agent session retrieved
 * through TradingView's MCP server (`get_ohlcv`), scored here by the canonical
 * engine (`npm run evaluate -- tradingview-import`, scripts/tradingViewImport.ts).
 *
 * The app never calls TradingView. The Vite dev server alone serves this file
 * from the git-ignored scan store to the local machine (vite.config.ts); a
 * production build has neither the route nor the file.
 */
import type { MarketScan } from '@/lib/marketScanner';

export const TRADINGVIEW_DEV_SCAN_KIND = 'tradingview-dev-scan' as const;
export const TRADINGVIEW_DEV_PROVIDER_ID = 'tradingview-mcp-get_ohlcv';
export const TRADINGVIEW_DEV_UNIVERSE_SOURCE = 'tradingview-dev-scan';
/** The dev-server route, and the file it serves from `.zerochart-scans/`. */
export const TRADINGVIEW_DEV_SCAN_ROUTE = '/__zerochart/tradingview-dev-scan';
export const TRADINGVIEW_DEV_SCAN_FILE = 'tradingview-dev-scan.json';

/** Where the bars came from, as the agent recorded it. Times are ISO strings. */
export interface TradingViewDevSource {
  tool: 'get_ohlcv';
  interval: '1D';
  retrieval: { startedAt: string; completedAt: string };
  /** Ticker → exact exchange-qualified TradingView symbol requested. */
  symbols: Readonly<Record<string, string>>;
  /** TradingView's own market-data notice, verbatim (adjustment, session, delay). */
  notice: string;
  /** How the 50 were chosen, before any score was seen. */
  selectionRule: string;
  /** Symbols holding any TradingView alert when the agent checked; null when not checked. */
  pineAlerts: { checkedAt: string; symbols: readonly string[] } | null;
}

export interface TradingViewDevScan {
  kind: typeof TRADINGVIEW_DEV_SCAN_KIND;
  scanId: string;
  importedAt: string;
  source: TradingViewDevSource;
  scan: MarketScan;
}

/** Shape check at the dev-server boundary: a malformed file is an error, never a partial panel. */
export function parseTradingViewDevScan(raw: unknown): TradingViewDevScan {
  const value = raw as Partial<TradingViewDevScan> | null;
  const source = value?.source;
  const scan = value?.scan;
  if (
    value?.kind !== TRADINGVIEW_DEV_SCAN_KIND ||
    typeof value.scanId !== 'string' ||
    typeof value.importedAt !== 'string' ||
    !source ||
    typeof source.notice !== 'string' ||
    typeof source.symbols !== 'object' ||
    !scan ||
    !Array.isArray(scan.results) ||
    !Array.isArray(scan.cohorts)
  ) {
    throw new Error('Not a TradingView development scan file.');
  }
  return value as TradingViewDevScan;
}
