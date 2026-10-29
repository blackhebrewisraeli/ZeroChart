import { useQuery } from '@tanstack/react-query';
import { MarketScanSummary } from '@/components/MarketScanSummary';
import { parseTradingViewDevScan, TRADINGVIEW_DEV_SCAN_ROUTE } from '@/lib/tradingViewDevScan';

/**
 * The local TradingView development scan, under `vite dev` only. Absent file:
 * nothing renders. Unreadable file: an error, never a partial scan.
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
  if (query.isError) {
    return (
      <section className="market-scan" aria-label="TradingView development scan">
        <p role="alert" className="market-scan-empty">
          The TradingView development scan could not be read ({query.error.message}). Re-run{' '}
          <code>npm run evaluate -- tradingview-import</code>.
        </p>
      </section>
    );
  }
  if (!query.data) return null;
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
