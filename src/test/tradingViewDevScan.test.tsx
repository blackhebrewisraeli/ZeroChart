import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TradingViewDevScan } from '@/components/TradingViewDevScan';
import { evaluateScan } from '@/lib/marketScanner';
import {
  TRADINGVIEW_DEV_PROVIDER_ID,
  TRADINGVIEW_DEV_SCAN_KIND,
  TRADINGVIEW_DEV_SCAN_ROUTE,
  TRADINGVIEW_DEV_UNIVERSE_SOURCE,
  type TradingViewDevScan as DevScan,
} from '@/lib/tradingViewDevScan';
import { bars, EQUITY_NOW, split, wave } from './usEquityFixtures';

/** Labeled fixture: one synthetic equity series, not TradingView data. */
const VIEW: DevScan = {
  kind: TRADINGVIEW_DEV_SCAN_KIND,
  scanId: '20261028T170000Z-00000000',
  importedAt: new Date(EQUITY_NOW).toISOString(),
  source: {
    tool: 'get_ohlcv',
    interval: '1D',
    retrieval: { startedAt: '2026-10-28T16:58:00.000Z', completedAt: '2026-10-28T17:00:00.000Z' },
    symbols: { AAPL: 'NASDAQ:AAPL' },
    notice: 'regular session only; prices are split-adjusted only.',
    selectionRule: 'Labeled fixture universe.',
    pineAlerts: null,
  },
  scan: evaluateScan(
    [
      {
        ticker: 'AAPL',
        instrument: 'US:AAPL',
        equity: {
          provider: TRADINGVIEW_DEV_PROVIDER_ID,
          range: { from: '2026-01-12', to: '2026-10-27' },
          series: split(bars(wave)),
          fetchedAt: EQUITY_NOW,
          cached: false,
        },
      },
    ],
    {
      evaluationTime: EQUITY_NOW,
      universeSource: TRADINGVIEW_DEV_UNIVERSE_SOURCE,
      equityProvider: TRADINGVIEW_DEV_PROVIDER_ID,
    },
  ),
};

function serve(response: Response) {
  const fetch = vi.fn(async () => response);
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <TradingViewDevScan />
    </QueryClientProvider>,
  );
  return { fetch, ...view };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TradingViewDevScan', () => {
  it('shows the imported scan from the dev-server route', async () => {
    const { fetch } = serve(new Response(JSON.stringify(VIEW)));
    expect(await screen.findByText('TradingView alerts were not checked.')).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: 'TradingView development scan' }),
    ).not.toHaveAttribute('aria-busy', 'true');
    expect(fetch).toHaveBeenCalledWith(TRADINGVIEW_DEV_SCAN_ROUTE, { cache: 'no-store' });
  });

  it('says it is reading the import while the route has not answered', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TradingViewDevScan />
      </QueryClientProvider>,
    );
    const panel = screen.getByRole('region', { name: 'TradingView development scan' });
    expect(panel).toHaveAttribute('aria-busy', 'true');
    expect(panel).toHaveTextContent('Reading the local TradingView import…');
  });

  it('says nothing was imported, and how a scan is made, when the route has no file', async () => {
    serve(new Response(null, { status: 404 }));
    const panel = await screen.findByRole('region', { name: 'TradingView development scan' });
    await vi.waitFor(() =>
      expect(panel).toHaveTextContent('No TradingView scan has been imported on this machine'),
    );
    expect(panel).toHaveTextContent('npm run evaluate -- tradingview-import');
    expect(panel.querySelector('.scan-row')).toBeNull();
  });

  it('reports an unreadable file instead of a partial scan', async () => {
    serve(new Response(JSON.stringify({ kind: TRADINGVIEW_DEV_SCAN_KIND })));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not a TradingView development scan file.',
    );
    expect(screen.queryByText('Ranked valid assets')).not.toBeInTheDocument();
  });

  it('reports a server error', async () => {
    serve(new Response(null, { status: 403 }));
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 403');
  });
});
