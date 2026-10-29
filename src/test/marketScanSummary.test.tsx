import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarketScanSummary } from '@/components/MarketScanSummary';
import type { Candle } from '@/lib/binance';
import { evaluateScan, UNSUPPORTED_DETAIL, type ScanInput } from '@/lib/marketScanner';
import {
  TRADINGVIEW_DEV_PROVIDER_ID,
  TRADINGVIEW_DEV_UNIVERSE_SOURCE,
  type TradingViewDevSource,
} from '@/lib/tradingViewDevScan';
import { bars, EQUITY_NOW, rising, split, wave } from './usEquityFixtures';

const DAY = 86_400_000;
const TODAY = Date.UTC(2026, 9, 28);
const NOW = TODAY + 17 * 60 * 60_000;

/** Labeled fixture: 199 closed daily candles of a gentle wave (no setup fires). */
function candles(): Candle[] {
  const first = TODAY - 199 * DAY;
  return Array.from({ length: 199 }, (_, i) => {
    const close = 100 + Math.sin(i / 6) * 8;
    return {
      timestamp: first + i * DAY,
      closeTime: first + i * DAY + DAY - 1,
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
    };
  });
}

const supported = (ticker: string): ScanInput => ({
  ticker,
  instrument: `BINANCE:${ticker.replace('-USD', 'USDT')}`,
  candles: candles(),
});

function scanOf(inputs: ScanInput[]) {
  return evaluateScan(inputs, { evaluationTime: NOW, universeSource: 'assets_status' });
}

function renderScan(inputs: ScanInput[]) {
  render(
    <MarketScanSummary scan={scanOf(inputs)} completedAt={NOW} scanning={false} failed={false} />,
  );
  return screen.getByRole('region', { name: 'Market scan' });
}

describe('MarketScanSummary', () => {
  it('says "none" only as a full answer when every supported asset was scored', () => {
    const panel = renderScan([
      supported('BTC-USD'),
      supported('ETH-USD'),
      { ticker: 'AAPL', instrument: null },
      { ticker: 'EURUSD=X', instrument: null },
    ]);
    expect(within(panel).getByText('Complete')).toBeInTheDocument();
    expect(within(panel).getByText('2 of 2 supported')).toBeInTheDocument();
    expect(within(panel).getByText('2 (1 equity, 1 forex)')).toBeInTheDocument();
    expect(
      within(panel).getAllByText('None — all 2 supported assets were evaluated.'),
    ).toHaveLength(2);
    expect(within(panel).getByText(/Completed 28 Oct, 17:00 UTC/)).toBeInTheDocument();
    const coverage = within(panel).getByRole('region', { name: 'Coverage by asset class' });
    expect(within(coverage).getAllByRole('listitem')).toHaveLength(3);
    expect(within(coverage).getByText('2 of 2 evaluated')).toBeInTheDocument();
    expect(
      within(coverage).getByText(
        'Binance spot klines · binance-daily-v1 · candles to 27 Oct close (UTC)',
      ),
    ).toBeInTheDocument();
    expect(within(coverage).getAllByText('Not scanned · 1')).toHaveLength(2);
    expect(within(coverage).getByText(UNSUPPORTED_DETAIL.equity)).toBeInTheDocument();
    expect(within(panel).getByRole('region', { name: 'Crypto setups' })).toBeInTheDocument();
    expect(
      within(panel).queryByRole('region', { name: 'Equities & ETFs setups' }),
    ).not.toBeInTheDocument();
  });

  it('separates an incomplete scan from "no qualifying setups" and lists what failed', () => {
    const panel = renderScan([
      supported('BTC-USD'),
      {
        ticker: 'ETH-USD',
        instrument: 'BINANCE:ETHUSDT',
        error: { code: 'FETCH_FAILED', detail: 'HTTP 503' },
      },
    ]);
    expect(within(panel).getByText('Incomplete')).toBeInTheDocument();
    expect(within(panel).getByText('1 of 2 supported')).toBeInTheDocument();
    expect(
      within(panel).getAllByText(
        "None among the 1 evaluated. This class's scan is incomplete, so this is not a full answer.",
      ),
    ).toHaveLength(2);
    expect(within(panel).queryByText(/None — all/)).not.toBeInTheDocument();
    const failures = within(panel).getByRole('region', { name: 'Not evaluated this scan' });
    expect(within(failures).getByText('ETH-USD')).toBeInTheDocument();
    expect(within(failures).getByText('Fetch failed')).toBeInTheDocument();
    expect(within(failures).getByText('HTTP 503')).toBeInTheDocument();
  });

  it('ranks equities in their own section, says their performance is unvalidated, and shows cached age', () => {
    const equity = (ticker: string, path: (i: number) => number, fetchedAt: number): ScanInput => ({
      ticker,
      instrument: `US:${ticker}`,
      equity: {
        provider: 'fixture-eod',
        range: { from: '2026-01-09', to: '2026-10-27' },
        series: split(bars(path)),
        fetchedAt,
        cached: fetchedAt < EQUITY_NOW,
      },
    });
    const scan = evaluateScan(
      [
        { ...supported('BTC-USD'), candles: candles() },
        equity('AAPL', wave, EQUITY_NOW),
        equity('MSFT', rising, EQUITY_NOW - (3 * 60 + 5) * 60_000),
      ],
      {
        evaluationTime: EQUITY_NOW,
        universeSource: 'assets_status',
        equityProvider: 'fixture-eod',
      },
    );
    render(
      <MarketScanSummary scan={scan} completedAt={EQUITY_NOW} scanning={false} failed={false} />,
    );
    const panel = screen.getByRole('region', { name: 'Market scan' });
    const coverage = within(panel).getByRole('region', { name: 'Coverage by asset class' });
    expect(
      within(coverage).getByText(
        'fixture-eod · us-equity-daily-v1 · sessions to 27 Oct close (New York) · 1 from cache, fetched up to 3h 05m before this scan',
      ),
    ).toBeInTheDocument();
    const equities = within(panel).getByRole('region', { name: 'Equities & ETFs setups' });
    expect(
      within(equities).getByText(
        /predictive performance on equities and ETFs has not been validated/,
      ),
    ).toBeInTheDocument();
    expect(within(equities).queryByText('BTC-USD')).not.toBeInTheDocument();
  });

  it('never offers an action: no buttons or links in the panel', () => {
    const panel = renderScan([supported('BTC-USD')]);
    expect(within(panel).queryByRole('button')).not.toBeInTheDocument();
    expect(within(panel).queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows scanning and failure states without a stale result', () => {
    const { rerender } = render(
      <MarketScanSummary scan={undefined} completedAt={0} scanning failed={false} />,
    );
    expect(screen.getByText('Scanning…')).toBeInTheDocument();
    rerender(<MarketScanSummary scan={undefined} completedAt={0} scanning={false} failed />);
    expect(
      screen.getByText('The market scan could not run. Scores are unavailable.'),
    ).toBeInTheDocument();
  });
});

describe('MarketScanSummary as the TradingView development scan', () => {
  const source: TradingViewDevSource = {
    tool: 'get_ohlcv',
    interval: '1D',
    retrieval: { startedAt: '2026-10-28T16:58:00.000Z', completedAt: '2026-10-28T17:00:00.000Z' },
    symbols: { AAPL: 'NASDAQ:AAPL', MSFT: 'NASDAQ:MSFT', SPY: 'AMEX:SPY' },
    notice: 'regular session only; prices are split-adjusted only.',
    selectionRule: 'Labeled fixture universe.',
    pineAlerts: { checkedAt: '2026-10-28T17:01:00.000Z', symbols: ['BINANCE:BTCUSDT'] },
  };
  const equity = (ticker: string, path: (i: number) => number): ScanInput => ({
    ticker,
    instrument: `US:${ticker}`,
    equity: {
      provider: TRADINGVIEW_DEV_PROVIDER_ID,
      range: { from: '2026-01-12', to: '2026-10-27' },
      series: split(bars(path)),
      fetchedAt: EQUITY_NOW - 60_000,
      cached: false,
    },
  });

  function renderDev(inputs: ScanInput[], devSource = source) {
    const scan = evaluateScan(inputs, {
      evaluationTime: EQUITY_NOW,
      universeSource: TRADINGVIEW_DEV_UNIVERSE_SOURCE,
      equityProvider: TRADINGVIEW_DEV_PROVIDER_ID,
    });
    render(
      <MarketScanSummary
        scan={scan}
        completedAt={EQUITY_NOW}
        scanning={false}
        failed={false}
        source={devSource}
      />,
    );
    return { scan, panel: screen.getByRole('region', { name: 'TradingView development scan' }) };
  }

  it('labels its origin, ranks every valid asset with components, and keeps failures', () => {
    const failed: ScanInput = {
      ticker: 'SPY',
      instrument: 'US:SPY',
      error: { code: 'FETCH_FAILED', detail: 'TradingView get_ohlcv (AMEX:SPY): HTTP 429' },
    };
    const { scan, panel } = renderDev([equity('AAPL', wave), equity('MSFT', rising), failed]);
    expect(within(panel).getByText('Local dev data')).toBeInTheDocument();
    expect(within(panel).getByText('Requested')).toBeInTheDocument();
    expect(within(panel).getByText('3 assets')).toBeInTheDocument();
    expect(within(panel).getByText('Not evaluated').nextSibling).toHaveTextContent('1');
    const ranked = panel.querySelector('.market-scan-ranked')!;
    const rows = within(ranked as HTMLElement).getAllByRole('listitem');
    const evaluated = scan.results.filter((result) => result.status === 'EVALUATED');
    expect(rows).toHaveLength(evaluated.length);
    expect(rows[0]).toHaveTextContent(`#1${evaluated[0]!.ticker}`);
    expect(rows[0]).toHaveTextContent(source.symbols[evaluated[0]!.ticker]!);
    expect(rows[0]).toHaveTextContent(/RSI \d+\.\d → \d+ ×0\.\d\d · MACD hist [+-]\d/);
    const failures = within(panel).getByRole('region', { name: 'Not evaluated this scan' });
    expect(within(failures).getByText(/HTTP 429/)).toBeInTheDocument();
    const notes = within(panel).getByRole('region', { name: 'Source and limitations' });
    expect(
      within(notes).getByText(/No TradingView alert exists on any of these symbols/),
    ).toBeInTheDocument();
    expect(within(notes).getByText(/dividends are not adjusted/)).toBeInTheDocument();
    expect(within(panel).queryByRole('button')).not.toBeInTheDocument();
  });

  it('says there are no qualifying setups as a full answer only when the scan is complete', () => {
    const { panel } = renderDev([equity('AAPL', wave)]);
    expect(
      within(panel).getAllByText('None — all 1 supported assets were evaluated.'),
    ).toHaveLength(2);
  });

  it('explains a risk setup with the readings behind it', () => {
    // Labeled fixture: closes alternating 6% apart, so ATR/close sits far above the 4% band.
    const { panel } = renderDev([equity('AAPL', (i) => (i % 2 === 0 ? 100 : 106))]);
    const risk = within(panel).getByText('Risk setups').closest('.market-scan-setups')!;
    const item = within(risk as HTMLElement).getByRole('listitem');
    expect(item).toHaveTextContent('AAPL');
    expect(item).toHaveTextContent('High-volatility');
    expect(item).toHaveTextContent(/ATR \d+\.\d\d% → \d+ ×0\.30/);
  });

  it('names a symbol that does hold a TradingView alert, without calling a setup an alert', () => {
    const pineAlerts = { checkedAt: '2026-10-28T17:01:00.000Z', symbols: ['NASDAQ:AAPL'] };
    const { panel } = renderDev([equity('AAPL', wave)], { ...source, pineAlerts });
    expect(
      within(panel).getByText(
        "TradingView alerts exist on NASDAQ:AAPL; a setup here is still ZeroChart's calculation, not proof an alert fired.",
      ),
    ).toBeInTheDocument();
  });
});
