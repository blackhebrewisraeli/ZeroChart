import { useQuery } from '@tanstack/react-query';
import { Radar } from 'lucide-react';
import type { ReactNode } from 'react';
import { MarketScanSummary } from '@/components/MarketScanSummary';
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
 * The local TradingView development scan, under `vite dev` only. Loading,
 * nothing imported and an unreadable file each say so; a partial scan is
 * never shown from a malformed file.
 */
export function TradingViewDevScan() {
  const query = useQuery({
    queryKey: ['tradingview-dev-scan'],
    queryFn: async () => {
      const response = await fetch(TRADINGVIEW_DEV_SCAN_ROUTE, { cache: 'no-store' });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parseTradingViewDevScan(await response.json());
    },
    enabled: import.meta.env.DEV,
    staleTime: Infinity,
    retry: false,
  });
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
