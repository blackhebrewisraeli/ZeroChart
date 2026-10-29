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
    expect(
      await screen.findByRole('region', { name: 'TradingView development scan' }),
    ).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(TRADINGVIEW_DEV_SCAN_ROUTE, { cache: 'no-store' });
    expect(screen.getByText('TradingView alerts were not checked.')).toBeInTheDocument();
  });

  it('renders nothing when no scan was imported', async () => {
    const { fetch, container } = serve(new Response(null, { status: 404 }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container).toBeEmptyDOMElement();
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
