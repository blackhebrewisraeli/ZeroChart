import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketScanSummary } from '@/components/MarketScanSummary';
import { MarketsSources, type MarketsSource } from '@/components/TradingViewDevScan';
import type { Candle } from '@/lib/binance';
import { REGIME_LABELS } from '@/lib/canonicalModel';
import { evaluateScan, type ScanInput } from '@/lib/marketScanner';
import {
  TRADINGVIEW_DEV_PROVIDER_ID,
  TRADINGVIEW_DEV_SCAN_KIND,
  TRADINGVIEW_DEV_SCAN_ROUTE,
  TRADINGVIEW_DEV_UNIVERSE_SOURCE,
  type TradingViewDevScan as DevScan,
} from '@/lib/tradingViewDevScan';
import { bars, EQUITY_NOW, falling, rising, split, wave } from './usEquityFixtures';

const DAY = 86_400_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(EQUITY_NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Labeled fixture: 199 closed daily crypto candles of a gentle wave, standing in for Binance. */
function crypto(ticker: string): ScanInput {
  const today = EQUITY_NOW - (EQUITY_NOW % DAY);
  const first = today - 199 * DAY;
  return {
    ticker,
    instrument: `BINANCE:${ticker.replace('-USD', 'USDT')}`,
    candles: Array.from({ length: 199 }, (_, i): Candle => {
      const close = 100 + Math.sin(i / 6) * 8;
      return {
        timestamp: first + i * DAY,
        closeTime: first + i * DAY + DAY - 1,
        open: close,
        high: close * 1.01,
        low: close * 0.99,
        close,
      };
    }),
  };
}

/** Labeled fixture: synthetic equity series, not TradingView data. */
function equity(ticker: string, path: (i: number) => number): ScanInput {
  return {
    ticker,
    instrument: `US:${ticker}`,
    equity: {
      provider: TRADINGVIEW_DEV_PROVIDER_ID,
      range: { from: '2026-01-12', to: '2026-10-27' },
      series: split(bars(path)),
      fetchedAt: EQUITY_NOW - 60_000,
      cached: false,
    },
  };
}

const MARKET_SCAN = evaluateScan([crypto('BTC-USD'), crypto('ETH-USD')], {
  evaluationTime: EQUITY_NOW,
  universeSource: 'assets_status',
});

function importOf(inputs: ScanInput[]): DevScan {
  return {
    kind: TRADINGVIEW_DEV_SCAN_KIND,
    scanId: '20261028T170000Z-00000000',
    importedAt: new Date(EQUITY_NOW).toISOString(),
    source: {
      tool: 'get_ohlcv',
      interval: '1D',
      retrieval: { startedAt: '2026-10-28T16:58:00.000Z', completedAt: '2026-10-28T17:00:00.000Z' },
      symbols: { AAPL: 'NASDAQ:AAPL', MSFT: 'NASDAQ:MSFT', NVDA: 'NASDAQ:NVDA', SPY: 'AMEX:SPY' },
      notice: 'regular session only; prices are split-adjusted only.',
      selectionRule: 'Labeled fixture universe.',
      pineAlerts: { checkedAt: '2026-10-28T17:01:00.000Z', symbols: [] },
    },
    scan: evaluateScan(inputs, {
      evaluationTime: EQUITY_NOW,
      universeSource: TRADINGVIEW_DEV_UNIVERSE_SOURCE,
      equityProvider: TRADINGVIEW_DEV_PROVIDER_ID,
    }),
  };
}

const IMPORT = importOf([
  equity('AAPL', wave),
  equity('MSFT', rising),
  equity('NVDA', falling),
  equity('SPY', (i) => (i % 2 === 0 ? 100 : 106)),
]);

function Markets() {
  const [source, setSource] = useState<MarketsSource>('market-data');
  return (
    <MarketsSources
      source={source}
      onSource={setSource}
      marketData={
        <>
          <MarketScanSummary
            scan={MARKET_SCAN}
            completedAt={EQUITY_NOW}
            scanning={false}
            failed={false}
          />
          <div aria-label="Markets table" role="table" />
        </>
      }
    />
  );
}

function serve(respond: () => Promise<Response>) {
  const fetch = vi.fn((_url: string, _init?: RequestInit) => respond());
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Markets />
    </QueryClientProvider>,
  );
  const pick = (name: RegExp) => fireEvent.click(screen.getByRole('tab', { name }));
  /** Waits for the picker to name the import's state, then opens the review. */
  const open = async (state: string) => {
    await screen.findByRole('tab', { name: `TradingView import ${state}` });
    pick(/TradingView import/);
    return screen.getByRole('region', { name: 'TradingView development scan' });
  };
  return { fetch, pick, open };
}

const json = (body: unknown) => () => Promise.resolve(new Response(JSON.stringify(body)));

function rowsOf(panel: HTMLElement) {
  return [...panel.querySelectorAll<HTMLElement>('.scan-row')];
}

describe('Markets source: market data or the local TradingView import', () => {
  it('opens on market data and names the import by its evaluated count, without showing it', async () => {
    serve(json(IMPORT));
    expect(await screen.findByRole('tab', { name: 'TradingView import 4' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(screen.getByRole('tab', { name: 'Market data' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('region', { name: 'Market scan' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Markets table' })).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'TradingView development scan' }),
    ).not.toBeInTheDocument();
  });

  it('lists every imported asset with the snapshot rank, score, regime and setups, and nothing else', async () => {
    const { open } = serve(json(IMPORT));
    const panel = await open('4');
    expect(screen.queryByRole('region', { name: 'Market scan' })).not.toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Markets table' })).not.toBeInTheDocument();

    const evaluated = IMPORT.scan.results.filter((result) => result.status === 'EVALUATED');
    const longs = evaluated.filter((result) => result.setups?.long).length;
    const risks = evaluated.filter((result) => result.setups?.risk).length;
    // The primary list is every ranked asset, not only those meeting a setup.
    expect(within(panel).getByRole('tab', { name: /All ranked/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(panel).getByRole('tab', { name: /Long setups/ })).toHaveTextContent(
      `Long setups${longs}`,
    );
    expect(within(panel).getByRole('tab', { name: /Risk warnings/ })).toHaveTextContent(
      `Risk warnings${risks}`,
    );

    const rows = rowsOf(panel);
    expect(rows).toHaveLength(evaluated.length);
    rows.forEach((row, index) => {
      const result = evaluated[index]!;
      const model = result.model!;
      const head = row.querySelector('.market-scan-item-head')!;
      expect(head.querySelector('.market-scan-rank')).toHaveTextContent(`#${result.rank}`);
      expect(head.querySelector('.market-scan-ticker')).toHaveTextContent(result.ticker);
      expect(head.querySelector('.market-scan-score')).toHaveTextContent(
        String(model.signal_score),
      );
      expect(head.querySelector('.market-scan-regime')).toHaveTextContent(
        REGIME_LABELS[model.regime],
      );
      expect(head.querySelector('.is-long') !== null).toBe(result.setups!.long);
      expect(head.querySelector('.is-risk') !== null).toBe(result.setups!.risk);
      expect(row).toHaveTextContent(model.rationale);
    });
    expect(panel.textContent).not.toMatch(/BTC|ETH|Binance spot/);
  });

  it('keeps zero long setups a full answer while every asset stays reviewable', async () => {
    const { open } = serve(json(IMPORT));
    const panel = await open('4');
    expect(IMPORT.scan.results.some((result) => result.setups?.long)).toBe(false);
    fireEvent.click(within(panel).getByRole('tab', { name: /Long setups/ }));
    expect(
      within(panel).getByText('None — all 4 supported assets were evaluated.'),
    ).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('tab', { name: /All ranked/ }));
    expect(rowsOf(panel)).toHaveLength(4);
    expect(panel).toHaveTextContent('#1 is not a buy');
    expect(panel).toHaveTextContent('Not a probability, a valuation or a demonstrated expected');
    expect(panel).toHaveTextContent('found higher ranks followed by smaller price changes');
  });

  it('never carries a comparison or an explanation from one source to the other', async () => {
    const { pick } = serve(json(IMPORT));
    await screen.findByRole('tab', { name: 'TradingView import 4' });
    const market = screen.getByRole('region', { name: 'Market scan' });
    fireEvent.click(within(market).getByRole('tab', { name: /All ranked/ }));
    fireEvent.click(within(market).getByRole('checkbox', { name: 'Compare BTC-USD' }));
    fireEvent.click(within(market).getByRole('checkbox', { name: 'Compare ETH-USD' }));
    expect(screen.getByRole('region', { name: 'Crypto comparison' })).toBeInTheDocument();
    fireEvent.click(within(market).getByRole('button', { name: 'Explain BTC-USD' }));
    expect(screen.getByRole('dialog', { name: 'BTC-USD explanation' })).toBeInTheDocument();

    pick(/TradingView import/);
    const panel = await screen.findByRole('region', { name: 'TradingView development scan' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Crypto comparison' })).not.toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Compare AAPL' }));
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Compare MSFT' }));
    expect(screen.getByRole('region', { name: 'Equities & ETFs comparison' })).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Explain AAPL' }));
    expect(screen.getByRole('dialog', { name: 'AAPL explanation' })).toBeInTheDocument();

    pick(/Market data/);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'Equities & ETFs comparison' }),
    ).not.toBeInTheDocument();
    // The market-data review starts over too: its earlier comparison is gone.
    expect(screen.queryByRole('region', { name: 'Crypto comparison' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Market scan' })).not.toHaveTextContent('AAPL');

    pick(/TradingView import/);
    expect(
      screen.queryByRole('region', { name: 'Equities & ETFs comparison' }),
    ).not.toBeInTheDocument();
  });

  it('reads only the local import route, once, however the review is used', async () => {
    const { fetch, pick, open } = serve(json(IMPORT));
    const panel = await open('4');
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Compare AAPL' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Explain AAPL' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    pick(/Market data/);
    pick(/TradingView import/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(TRADINGVIEW_DEV_SCAN_ROUTE, { cache: 'no-store' });
  });
});

describe('Markets source: import states', () => {
  it('says the import is loading, in the picker and the review', () => {
    const { pick } = serve(() => new Promise<Response>(() => {}));
    pick(/TradingView import Loading/);
    expect(screen.getByRole('region', { name: 'TradingView development scan' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(screen.getByText('Reading the local TradingView import…')).toBeInTheDocument();
  });

  it('says nothing was imported, and shows no market data in its place', async () => {
    const { open } = serve(() => Promise.resolve(new Response('', { status: 404 })));
    await open('None');
    expect(
      screen.getByText(/No TradingView scan has been imported on this machine/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Market scan' })).not.toBeInTheDocument();
  });

  it('says an unreadable import could not be read', async () => {
    const { fetch, open } = serve(json({ kind: 'something-else' }));
    await open('Unreadable');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The TradingView development scan could not be read (Not a TradingView development scan file.)',
    );
  });

  it('marks a partial import incomplete and lists what failed', async () => {
    const partial = importOf([
      equity('AAPL', wave),
      equity('MSFT', rising),
      {
        ticker: 'SPY',
        instrument: 'US:SPY',
        error: { code: 'FETCH_FAILED', detail: 'TradingView get_ohlcv (AMEX:SPY): HTTP 429' },
      },
    ]);
    const { open } = serve(json(partial));
    const panel = await open('2');
    expect(within(panel).getAllByText('Incomplete').length).toBeGreaterThan(0);
    expect(within(panel).getByText('Failed').nextSibling).toHaveTextContent('1');
    expect(
      within(within(panel).getByRole('region', { name: 'Not evaluated this scan' })).getByText(
        /HTTP 429/,
      ),
    ).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('tab', { name: /Long setups/ }));
    expect(panel).toHaveTextContent('not a full answer');
  });

  it('marks an import stale once two newer sessions are final', async () => {
    vi.setSystemTime(EQUITY_NOW + 4 * DAY);
    const { open } = serve(json(IMPORT));
    const panel = await open('4');
    expect(within(panel).getByText('Stale', { selector: '.market-scan-status' })).toBeVisible();
  });
});
