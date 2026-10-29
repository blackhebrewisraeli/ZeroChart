import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketScanSummary } from '@/components/MarketScanSummary';
import type { Candle } from '@/lib/binance';
import { explainResult } from '@/lib/scanReview';
import { evaluateScan, UNSUPPORTED_DETAIL, type ScanInput } from '@/lib/marketScanner';
import {
  TRADINGVIEW_DEV_PROVIDER_ID,
  TRADINGVIEW_DEV_UNIVERSE_SOURCE,
  type TradingViewDevSource,
} from '@/lib/tradingViewDevScan';
import { bars, EQUITY_NOW, falling, rising, split, wave } from './usEquityFixtures';

const DAY = 86_400_000;
const TODAY = Date.UTC(2026, 9, 28);
const NOW = TODAY + 17 * 60 * 60_000;

// Freshness is judged against the clock: pin it to the fixtures' scan time.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

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
    expect(panel.querySelector('.market-scan-head')).toHaveTextContent('Complete');
    expect(within(panel).getByText('2 of 2 supported')).toBeInTheDocument();
    expect(within(panel).getByText('2 (1 equity, 1 forex)')).toBeInTheDocument();
    expect(
      within(panel).getByText('None — all 2 supported assets were evaluated.'),
    ).toBeInTheDocument();
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
    expect(within(panel).getByRole('region', { name: 'Crypto results' })).toBeInTheDocument();
    expect(
      within(panel).queryByRole('region', { name: 'Equities & ETFs results' }),
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
    expect(panel.querySelector('.market-scan-head')).toHaveTextContent('Incomplete');
    expect(within(panel).getByText('1 of 2 supported')).toBeInTheDocument();
    for (const view of ['Long setups', 'Risk warnings']) {
      fireEvent.click(within(panel).getByRole('tab', { name: new RegExp(view) }));
      expect(
        within(panel).getByText(
          "None among the 1 evaluated. This class's scan is incomplete, so this is not a full answer.",
        ),
      ).toBeInTheDocument();
    }
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
    const equities = within(panel).getByRole('region', { name: 'Equities & ETFs results' });
    expect(
      within(equities).getByText(
        /predictive performance on equities and ETFs has not been validated/,
      ),
    ).toBeInTheDocument();
    expect(within(equities).queryByText('BTC-USD')).not.toBeInTheDocument();
  });

  it('never offers an action: no links, and only review controls', () => {
    const panel = renderScan([supported('BTC-USD')]);
    fireEvent.click(within(panel).getByRole('tab', { name: /All ranked/ }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Explain BTC-USD' }));
    for (const scope of [panel, screen.getByRole('dialog')]) {
      expect(within(scope).queryByRole('link')).not.toBeInTheDocument();
      for (const button of within(scope).queryAllByRole('button')) {
        expect(button).toHaveAccessibleName(/^(Explain|Close|Reset|Clear)/);
      }
      expect(scope.textContent).not.toMatch(/trade now|buy now|place order|broker/i);
    }
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
    expect(within(panel).getByText('Historical dev import')).toBeInTheDocument();
    expect(within(panel).getByText('Requested')).toBeInTheDocument();
    expect(within(panel).getByText('3 assets')).toBeInTheDocument();
    expect(within(panel).getByText('Not evaluated').nextSibling).toHaveTextContent('1');
    fireEvent.click(within(panel).getByRole('tab', { name: /All ranked/ }));
    const rows = [...panel.querySelectorAll<HTMLElement>('.scan-row')];
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
    expect(within(panel).queryByRole('link')).not.toBeInTheDocument();
    expect(panel.textContent).not.toMatch(/\blive\b/i);
  });

  it('says there are no qualifying setups as a full answer only when the scan is complete', () => {
    const { panel } = renderDev([equity('AAPL', wave)]);
    for (const view of ['Long setups', 'Risk warnings']) {
      fireEvent.click(within(panel).getByRole('tab', { name: new RegExp(view) }));
      expect(
        within(panel).getByText('None — all 1 supported assets were evaluated.'),
      ).toBeInTheDocument();
    }
  });

  it('explains a risk setup with the readings behind it', () => {
    // Labeled fixture: closes alternating 6% apart, so ATR/close sits far above the 4% band.
    const { panel } = renderDev([equity('AAPL', (i) => (i % 2 === 0 ? 100 : 106))]);
    fireEvent.click(within(panel).getByRole('tab', { name: /Risk warnings/ }));
    const [item] = panel.querySelectorAll('.scan-row');
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

describe('Scan review: views, explanation and comparison', () => {
  const choppy = (i: number) => (i % 2 === 0 ? 100 : 106);
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
  const fourEquities = () => [
    equity('AAPL', wave),
    equity('MSFT', rising),
    equity('NVDA', falling),
    equity('SPY', choppy),
  ];
  const source: TradingViewDevSource = {
    tool: 'get_ohlcv',
    interval: '1D',
    retrieval: { startedAt: '2026-10-28T16:58:00.000Z', completedAt: '2026-10-28T17:00:00.000Z' },
    symbols: { AAPL: 'NASDAQ:AAPL', MSFT: 'NASDAQ:MSFT', NVDA: 'NASDAQ:NVDA', SPY: 'AMEX:SPY' },
    notice: 'regular session only; prices are split-adjusted only.',
    selectionRule: 'Labeled fixture universe.',
    pineAlerts: { checkedAt: '2026-10-28T17:01:00.000Z', symbols: [] },
  };

  function renderReview(inputs: ScanInput[], devSource?: TradingViewDevSource) {
    const scan = evaluateScan(inputs, {
      evaluationTime: EQUITY_NOW,
      universeSource: devSource ? TRADINGVIEW_DEV_UNIVERSE_SOURCE : 'assets_status',
      equityProvider: TRADINGVIEW_DEV_PROVIDER_ID,
    });
    render(
      <MarketScanSummary
        scan={scan}
        completedAt={EQUITY_NOW}
        scanning={false}
        failed={false}
        {...(devSource && { source: devSource })}
      />,
    );
    const panel = screen.getByRole('region', {
      name: devSource ? 'TradingView development scan' : 'Market scan',
    });
    const view = (name: string) =>
      fireEvent.click(within(panel).getByRole('tab', { name: new RegExp(name) }));
    const rows = () => [...panel.querySelectorAll<HTMLElement>('.scan-row')];
    return { scan, panel, view, rows };
  }

  it('separates long setups, risk warnings and every ranked asset, and filters by recorded fields', () => {
    const { scan, panel, view, rows } = renderReview(fourEquities());
    const evaluated = scan.results.filter((result) => result.status === 'EVALUATED');
    const risky = evaluated.filter((result) => result.setups?.risk);
    expect(risky.length).toBeGreaterThan(0);
    expect(within(panel).getByRole('tab', { name: /All ranked/ })).toHaveTextContent('All ranked4');

    view('Risk warnings');
    expect(rows().map((row) => row.querySelector('.market-scan-ticker')?.textContent)).toEqual(
      risky.map((result) => result.ticker),
    );
    expect(rows().every((row) => row.textContent?.includes('Risk warning'))).toBe(true);

    view('All ranked');
    expect(rows().map((row) => row.querySelector('.market-scan-rank')?.textContent)).toEqual([
      '#1',
      '#2',
      '#3',
      '#4',
    ]);

    const search = within(panel).getByRole('searchbox', { name: 'Search ticker or symbol' });
    fireEvent.change(search, { target: { value: 'msf' } });
    expect(rows()).toHaveLength(1);
    expect(within(panel).getByText('Showing 1 of 4 ranked assets.')).toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(rows()).toHaveLength(0);
    expect(
      within(panel).getByText(/No ranked assets match these filters \(4 hidden\)/),
    ).toBeInTheDocument();
    expect(within(panel).queryByText(/None — all/)).not.toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Clear filters' }));
    expect(rows()).toHaveLength(4);
    expect(search).toHaveValue('');

    const spy = evaluated.find((result) => result.ticker === 'SPY')!;
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Filter by regime' }), {
      target: { value: spy.model!.regime },
    });
    expect(rows().map((row) => row.querySelector('.market-scan-ticker')?.textContent)).toContain(
      'SPY',
    );
    expect(rows().every((row) => row.textContent?.includes('High-volatility'))).toBe(true);
  });

  it('explains one asset from its recorded values only, and closes back to its row', () => {
    const { scan, panel, view } = renderReview(fourEquities());
    view('All ranked');
    const spy = scan.results.find((result) => result.ticker === 'SPY')!;
    const explainButton = within(panel).getByRole('button', { name: 'Explain SPY' });
    explainButton.focus();
    fireEvent.click(explainButton);
    const dialog = screen.getByRole('dialog', { name: 'SPY explanation' });
    const fact = (name: string) =>
      within(dialog).getAllByText(name, { selector: 'dt' })[0]!.nextElementSibling?.textContent;
    expect(fact('RSI(14)')).toBe(spy.model!.inputs.rsi.toFixed(1));
    expect(fact('ATR(14) / price')).toBe(
      `${(spy.model!.inputs.volatilityPercent * 100).toFixed(2)}%`,
    );
    expect(fact('Source')).toBe('TradingView MCP get_ohlcv');
    expect(fact('Model')).toBe('1.0.0 · scanner market-scan-v2');
    expect(fact('Last evaluated')).toBe('27 Oct session (New York)');
    expect(
      within(dialog)
        .getByText('ZC RISK', { selector: '.scan-check-head > span' })
        .closest('.scan-check'),
    ).toHaveTextContent('Holds');
    expect(dialog).toHaveTextContent(
      'sets the High-volatility regime, which holds ZC RISK on its own',
    );
    expect(dialog).toHaveTextContent(
      /predictive performance on equities and ETFs has not been validated/,
    );
    expect(dialog).toHaveTextContent('This scan does not read TradingView alerts.');
    expect(dialog.textContent).not.toMatch(/confidence|chance|undervalued|fair value/i);
    expect(within(dialog).queryByRole('link')).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(explainButton).toHaveFocus();
  });

  it('compares up to three assets of one cohort with the values the explanation gives', () => {
    const { scan, panel, view } = renderReview(fourEquities());
    view('All ranked');
    const compare = (ticker: string) =>
      within(panel).getByRole('checkbox', { name: `Compare ${ticker}` });
    for (const ticker of ['AAPL', 'MSFT', 'NVDA']) fireEvent.click(compare(ticker));
    expect(compare('SPY')).toBeDisabled();
    expect(compare('SPY').closest('label')).toHaveAttribute('title', 'Compare at most 3 assets');

    const table = within(panel).getByRole('region', { name: 'Equities & ETFs comparison' });
    const header = [...table.querySelectorAll('thead th')].map(
      (th) => th.querySelector('.market-scan-ticker')?.textContent,
    );
    expect(header).toEqual([undefined, 'AAPL', 'MSFT', 'NVDA']);
    const row = (name: string) =>
      [...within(table).getByRole('rowheader', { name }).parentElement!.querySelectorAll('td')].map(
        (cell) => cell.textContent,
      );
    const compared = ['AAPL', 'MSFT', 'NVDA'].map((ticker) =>
      scan.results.find((r) => r.ticker === ticker)!,
    );
    expect(row('Score')).toEqual(compared.map((result) => String(result.model!.signal_score)));
    expect(row('Rank')).toEqual(compared.map((result) => `#${result.rank} of 4`));
    compared.forEach((result, index) => {
      const explanation = explainResult(result.model!, result.setups!);
      expect(row('ZC LONG')[index]!.startsWith('Holds')).toBe(explanation.long.holds);
      expect(row('ZC RISK')[index]!.startsWith('Holds')).toBe(result.setups!.risk);
      expect(row('Regime')[index]).toContain(explanation.regimeRule);
    });

    fireEvent.click(within(table).getByRole('button', { name: 'Remove MSFT from comparison' }));
    expect(row('Score')).toHaveLength(2);
    expect(compare('SPY')).toBeEnabled();
    fireEvent.click(within(table).getByRole('button', { name: 'Clear' }));
    expect(
      within(panel).queryByRole('region', { name: 'Equities & ETFs comparison' }),
    ).not.toBeInTheDocument();
  });

  it('never compares across asset classes', () => {
    const { panel, view } = renderReview([
      supported('BTC-USD'),
      equity('AAPL', wave),
      equity('MSFT', rising),
    ]);
    view('All ranked');
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Compare BTC-USD' }));
    const aapl = within(panel).getByRole('checkbox', { name: 'Compare AAPL' });
    expect(aapl).toBeDisabled();
    expect(aapl.closest('label')).toHaveAttribute(
      'title',
      'Compare assets from one asset class only',
    );
    expect(within(panel).getByRole('region', { name: 'Crypto comparison' })).toHaveTextContent(
      'Select up to 2 more crypto to compare.',
    );
  });

  it('marks an old import stale, never live, in the results and the explanation', () => {
    vi.setSystemTime(Date.UTC(2026, 10, 6, 12));
    const { panel, view } = renderReview(fourEquities(), source);
    expect(within(panel).getByText('Historical dev import')).toBeInTheDocument();
    const asOf = panel.querySelector('.scan-asof')!;
    expect(asOf).toHaveTextContent('sessions to 27 Oct close (New York)');
    expect(asOf).toHaveTextContent(
      /Stale: \d+ newer sessions are final, and this scan does not refresh/,
    );
    expect(panel.textContent).not.toMatch(/\blive\b/i);
    view('All ranked');
    fireEvent.click(within(panel).getByRole('button', { name: 'Explain AAPL' }));
    const dialog = screen.getByRole('dialog', { name: 'AAPL explanation' });
    expect(dialog).toHaveTextContent('Historical import');
    expect(dialog).toHaveTextContent(/Stale: \d+ newer sessions are final/);
    expect(dialog).toHaveTextContent('No TradingView alert existed on NASDAQ:AAPL when checked');
    expect(dialog.textContent).not.toMatch(/\blive\b/i);
  });

  it('marks crypto stale past 48h and keeps an incomplete rank qualified', () => {
    vi.setSystemTime(NOW + 3 * DAY);
    const panel = renderScan([
      supported('BTC-USD'),
      {
        ticker: 'ETH-USD',
        instrument: 'BINANCE:ETHUSDT',
        error: { code: 'FETCH_FAILED', detail: 'HTTP 503' },
      },
    ]);
    expect(panel.querySelector('.scan-asof')).toHaveTextContent(
      /Stale: latest candle closed \d+h \d\dm ago, past 48h/,
    );
    fireEvent.click(within(panel).getByRole('tab', { name: /All ranked/ }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Explain BTC-USD' }));
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'This scan is incomplete: the rank is among 1 evaluated, not all 2 supported.',
    );
  });
});
