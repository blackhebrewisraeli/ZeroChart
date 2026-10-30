import { useQuery } from '@tanstack/react-query';
import { Radar } from 'lucide-react';
import type { ReactNode } from 'react';
import { MarketScanSummary } from '@/components/MarketScanSummary';
import { Segmented } from '@/components/Segmented';
import { parseTradingViewDevScan, TRADINGVIEW_DEV_SCAN_ROUTE } from '@/lib/tradingViewDevScan';

/** The section's frame while there is no scan to show, so it is never mistaken for the Market scan. */
function DevScanState({
  busy = false,
  alert = false,
  children,
}: Readonly<{ busy?: boolean; alert?: boolean; children: ReactNode }>) {
  return (
    <section
      className="market-scan market-scan-devscan"
      aria-label="TradingView development scan"
      aria-busy={busy}
    >
      <div className="market-scan-head">
        <span className="market-scan-title">
          <Radar size={14} /> TradingView development scan
        </span>
      </div>
      <p role={alert ? 'alert' : undefined} className="market-scan-empty">
        {children}
      </p>
    </section>
  );
}

/**
 * The local import, shared by the picker and the review: entering the review never
 * re-reads it, so both always show the same state. Reloading the page re-reads the
 * file; nothing here fetches bars.
 */
function useTradingViewDevScan() {
  return useQuery({
    queryKey: ['tradingview-dev-scan'],
    queryFn: async () => {
      const response = await fetch(TRADINGVIEW_DEV_SCAN_ROUTE, { cache: 'no-store' });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parseTradingViewDevScan(await response.json());
    },
    enabled: import.meta.env.DEV,
    staleTime: Infinity,
    retryOnMount: false,
    retry: false,
  });
}

/**
 * The local TradingView development scan, under `vite dev` only. Loading,
 * nothing imported and an unreadable file each say so; a partial scan is
 * never shown from a malformed file.
 */
export function TradingViewDevScan() {
  const query = useTradingViewDevScan();
  if (query.isPending) {
    return <DevScanState busy>Reading the local TradingView import…</DevScanState>;
  }
  if (query.isError) {
    return (
      <DevScanState alert>
        The TradingView development scan could not be read ({query.error.message}). Re-run{' '}
        <code>npm run evaluate -- tradingview-import</code>.
      </DevScanState>
    );
  }
  if (!query.data) {
    return (
      <DevScanState>
        No TradingView scan has been imported on this machine, and the Market scan does not include
        one. The owner&rsquo;s agent session retrieves the bars; then{' '}
        <code>npm run evaluate -- tradingview-import</code> scores them (owner runbook in
        docs/MARKET_SCANNER.md).
      </DevScanState>
    );
  }
  const { scan, importedAt, source } = query.data;
  return (
    <MarketScanSummary
      scan={scan}
      completedAt={Date.parse(importedAt)}
      scanning={false}
      failed={false}
      source={source}
    />
  );
}

export type MarketsSource = 'market-data' | 'tradingview';

/**
 * Which source the Markets section reviews, under `vite dev` only. Each source
 * renders its own list, scores, ranks and coverage; switching unmounts the
 * other, so no selection, explanation or comparison carries across.
 */
export function MarketsSources({
  source,
  onSource,
  marketData,
}: Readonly<{
  source: MarketsSource;
  onSource: (source: MarketsSource) => void;
  marketData: ReactNode;
}>) {
  const query = useTradingViewDevScan();
  let state = 'None';
  if (query.isPending) state = 'Loading';
  else if (query.isError) state = 'Unreadable';
  else if (query.data) state = String(query.data.scan.coverage.evaluated);
  return (
    <>
      <Segmented
        value={source}
        ariaLabel="Markets source"
        className="scan-views markets-source"
        onChange={onSource}
        options={[
          { value: 'market-data', label: 'Market data' },
          {
            value: 'tradingview',
            label: (
              <>
                TradingView import <span className="segment-tag">{state}</span>
              </>
            ),
          },
        ]}
      />
      {source === 'tradingview' ? <TradingViewDevScan /> : marketData}
    </>
  );
}
