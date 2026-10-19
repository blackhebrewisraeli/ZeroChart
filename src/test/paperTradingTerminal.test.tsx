import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import type { Asset } from '@/lib/assets';
import type { LivePrice } from '@/lib/livePriceStore';

vi.mock('@/lib/supabaseClient', () => ({ supabase: {} }));
vi.mock('@/lib/db', () => ({
  loadPortfolio: vi.fn(),
  savePortfolioStateV3: vi.fn(),
  PortfolioNotHydratedError: class PortfolioNotHydratedError extends Error {},
}));
vi.mock('sonner', () => ({
  toast: { dismiss: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));
// Keep the terminal chart hermetic: no canvas, no Binance network.
vi.mock('@/components/LightweightChart', () => ({
  CandlestickChart: () => <div data-testid="quant-chart" />,
}));
vi.mock('@/lib/binance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/binance')>()),
  fetchHistoricalCandles: vi.fn(async () => []),
}));

import { PortfolioProvider, usePortfolio } from '@/lib/portfolioStore';
import { PaperTradingTerminal } from '@/components/PaperTradingTerminal';
import { __resetAlertsStoreForTests, addAlert } from '@/lib/alertsStore';
import { runAlertPass } from '@/lib/alertEngine';

const NOW = Date.now();

function asset(ticker: string, name: string, price: number): Asset {
  return {
    ticker,
    name,
    current_price: price,
    stable_signal: null,
    radar_signal: null,
    stable_explanation: null,
    radar_explanation: null,
    risk_pct: null,
    reward_pct: null,
    volume_spike: null,
    rsi_14: null,
    sma_50: null,
    sma_200: null,
    change_24h: null,
    updated_at: new Date(NOW - 60_000).toISOString(),
  };
}

const assets = (ethPrice: number) => [
  asset('BTC-USD', 'Bitcoin', 60_000),
  asset('ETH-USD', 'Ethereum', ethPrice),
];

let store: ReturnType<typeof usePortfolio>;
function Probe() {
  store = usePortfolio();
  return null;
}

function tree(ethPrice: number) {
  return (
    <PortfolioProvider>
      <PaperTradingTerminal assets={assets(ethPrice)} />
      <Probe />
    </PortfolioProvider>
  );
}

function stat(name: string) {
  return within(screen.getByRole('group', { name }));
}

/** Fires an ETH-USD price alert so it lands in the Tactical Signals feed. */
function fireEthAlert(price: number) {
  addAlert({ ticker: 'ETH-USD', targetPrice: 2000, condition: 'below' }, 'session');
  act(() => {
    runAlertPass({
      assets: assets(price),
      livePrices: new Map<string, LivePrice>(),
      streamConnected: true,
      now: NOW,
    });
  });
  return screen.getByText('Price Alert').closest('.suggestion-card') as HTMLElement;
}

describe('Paper Desk', () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetAlertsStoreForTests();
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  it('defaults the chart to the top card of the Tactical Signals feed', () => {
    // BTC wins the legacy signal score (volume spike, above SMA 50) but has no
    // factor data; ETH is the feed's only Multi-Factor BUY.
    const ranked = [
      { ...asset('BTC-USD', 'Bitcoin', 60_000), volume_spike: 2, sma_50: 50_000 },
      { ...asset('ETH-USD', 'Ethereum', 1900), rsi_14: 25, change_24h: 0.02, risk_pct: 0.004 },
    ];
    render(
      <PortfolioProvider>
        <PaperTradingTerminal assets={ranked} />
      </PortfolioProvider>,
    );
    const feed = within(screen.getByRole('region', { name: 'Tactical signals' }));
    expect(feed.getAllByText(/-USD$/)[0]).toHaveTextContent('ETH-USD');
    expect(screen.getByRole('combobox', { name: 'Chart symbol' })).toHaveValue('ETH-USD');
  });

  it('keeps the default chart on a listed asset when the top alert is for an unlisted ticker', () => {
    render(
      <PortfolioProvider>
        <PaperTradingTerminal assets={[asset('BTC-USD', 'Bitcoin', 60_000)]} />
      </PortfolioProvider>,
    );
    fireEthAlert(1900);
    expect(screen.getByRole('combobox', { name: 'Chart symbol' })).toHaveValue('BTC-USD');
    expect(screen.getByRole('region', { name: 'Quick order' })).toBeInTheDocument();
  });

  it('clicking a tactical signal charts its ticker and opens a paper-bound ticket', () => {
    render(tree(1900));
    const symbol = screen.getByRole('combobox', { name: 'Chart symbol' });
    expect(symbol).toHaveValue('BTC-USD');

    const card = fireEthAlert(1900);
    fireEvent.click(within(card).getByText('Triggered at $1,900.00.'));
    expect(symbol).toHaveValue('ETH-USD');
    expect(screen.getByRole('region', { name: 'ETH-USD historical chart' })).toBeInTheDocument();
    const quickOrder = within(screen.getByRole('region', { name: 'Quick order' }));
    expect(quickOrder.getByRole('button', { name: 'Trade ETH-USD' })).toBeInTheDocument();

    // The card's Trade button opens the ticket on the paper ledger.
    fireEvent.click(within(card).getByRole('button', { name: 'Trade' }));
    expect(screen.getByRole('dialog', { name: 'Trade ETH-USD' })).toHaveTextContent(
      'recorded in your Paper Trading ledger',
    );
  });

  it('books, resizes and closes strictly in paper_trading with exact cash, lots and P&L', () => {
    const view = render(tree(1900));
    const realBefore = store.portfolios.real_tracking;
    const simBefore = store.portfolios.long_term_sim;
    expect(stat('Paper Cash').getByText('$100,000.00')).toBeInTheDocument();
    expect(screen.getByText('No open paper positions')).toBeInTheDocument();

    const card = fireEthAlert(1900);
    fireEvent.click(within(card).getByRole('button', { name: 'Trade' }));
    const ticket = within(screen.getByRole('dialog', { name: 'Trade ETH-USD' }));
    fireEvent.change(ticket.getByLabelText('Order amount (USD)'), { target: { value: '1000' } });
    fireEvent.click(ticket.getByRole('button', { name: 'Buy ETH-USD' }));
    expect(toast.error).not.toHaveBeenCalled();
    expect(stat('Paper Cash').getByText('$98,997.50')).toBeInTheDocument(); // 1,000 + 2.50 fee

    // +25%: 0.1316 sh at 1,900 = 250 + 0.625 fee, as a second FIFO lot.
    fireEvent.click(screen.getByRole('button', { name: 'Add 25% to ETH-USD' }));
    expect(stat('Paper Cash').getByText('$98,746.88')).toBeInTheDocument();
    const [position] = store.portfolios.paper_trading.positions;
    expect(position?.shares).toBeCloseTo(1250 / 1900, 9);
    expect(position?.lots).toHaveLength(2);

    // Rally to 2,100, trim 25%: FIFO sells from the first lot at 1,904.75/sh cost.
    view.rerender(tree(2100));
    fireEvent.click(screen.getByRole('button', { name: 'Trim ETH-USD by 25%' }));
    expect(stat('Session Realized P&L').getByText('+$31.25')).toBeInTheDocument();
    expect(stat('Paper Cash').getByText('$99,091.41')).toBeInTheDocument();
    const lots = store.portfolios.paper_trading.positions[0]?.lots ?? [];
    expect(lots.map((lot) => lot.shares)).toEqual([
      expect.closeTo((1000 / 1900) * 1 - (1250 / 1900) * 0.25, 9),
      expect.closeTo(250 / 1900, 9),
    ]);

    // 1-click close of the rest: +93.75, ending exactly 125 above the start.
    fireEvent.click(screen.getByRole('button', { name: 'Close ETH-USD position' }));
    expect(toast.error).not.toHaveBeenCalled();
    expect(stat('Session Realized P&L').getByText('+$125.00')).toBeInTheDocument();
    expect(stat('Paper Cash').getByText('$100,125.00')).toBeInTheDocument();
    expect(stat('Win Rate').getByText('100%')).toBeInTheDocument();
    expect(stat('Win Rate').getByText('2 of 2 closes')).toBeInTheDocument();
    expect(stat('Execution Drag').getByText('$6.58')).toBeInTheDocument();
    expect(stat('Execution Drag').getByText(/4 fills/)).toBeInTheDocument();
    expect(screen.getByText('No open paper positions')).toBeInTheDocument();

    const paper = store.portfolios.paper_trading;
    expect(paper.realizedPnl).toBeCloseTo(125, 9);
    expect(paper.transactions.map((t) => [t.type, t.intent])).toEqual([
      ['buy', 'tactical'],
      ['buy', 'tactical'],
      ['sell', 'tactical'],
      ['sell', 'tactical'],
    ]);
    // Core ledgers never saw any of it.
    expect(store.portfolios.real_tracking).toBe(realBefore);
    expect(store.portfolios.long_term_sim).toBe(simBefore);

    // The ledger tab lists every fill, newest first.
    fireEvent.click(screen.getByRole('button', { name: 'Trade Ledger (4)' }));
    const ledger = within(screen.getByRole('region', { name: 'Paper Trade Ledger' }));
    const rows = within(ledger.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows.map((row) => within(row).getAllByRole('cell')[1]?.textContent)).toEqual([
      'SELLTactical',
      'SELLTactical',
      'BUYTactical',
      'BUYTactical',
    ]);
  });

  it('tops up and resets only the paper account', () => {
    render(tree(1900));
    act(() => {
      store.executeBuy('paper_trading', { ticker: 'ETH-USD', shares: 1, price: 1900 });
    });
    const realBefore = store.portfolios.real_tracking;
    const simBefore = store.portfolios.long_term_sim;

    fireEvent.click(screen.getByRole('button', { name: /Top Up/ }));
    expect(stat('Paper Cash').getByText('$108,100.00')).toBeInTheDocument(); // 98,100 + 10,000

    fireEvent.click(screen.getByRole('button', { name: /Reset/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset to $100,000.00' }));
    expect(stat('Paper Cash').getByText('$100,000.00')).toBeInTheDocument();
    expect(screen.getByText('No open paper positions')).toBeInTheDocument();
    expect(store.portfolios.paper_trading.transactions).toEqual([]);
    expect(store.portfolios.real_tracking).toBe(realBefore);
    expect(store.portfolios.long_term_sim).toBe(simBefore);
  });

  it('cannot resize or close a position without a live price to fill at', () => {
    render(tree(Number.NaN));
    act(() => {
      store.executeBuy('paper_trading', { ticker: 'ETH-USD', shares: 1, price: 1900 });
    });
    expect(screen.getByRole('button', { name: 'Close ETH-USD position' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add 25% to ETH-USD' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Trim ETH-USD by 25%' })).toBeDisabled();
  });
});
