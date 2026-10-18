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

import { PortfolioProvider, usePortfolio } from '@/lib/portfolioStore';
import { PaperTradingTerminal } from '@/components/PaperTradingTerminal';
import { __resetAlertsStoreForTests, addAlert } from '@/lib/alertsStore';
import { runAlertPass } from '@/lib/alertEngine';

const NOW = Date.now();

function eth(price: number): Asset {
  return {
    ticker: 'ETH-USD',
    name: 'Ethereum',
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

let store: ReturnType<typeof usePortfolio>;
function Probe() {
  store = usePortfolio();
  return null;
}

function tree(price: number) {
  return (
    <PortfolioProvider>
      <PaperTradingTerminal assets={[eth(price)]} />
      <Probe />
    </PortfolioProvider>
  );
}

function stat(name: string) {
  return within(screen.getByRole('group', { name }));
}

describe('Paper Trading Terminal', () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetAlertsStoreForTests();
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  it('books a signal trade into paper_trading only, then closes it in one click', () => {
    const view = render(tree(1900));
    const realBefore = store.portfolios.real_tracking;
    expect(screen.getByText('No open paper positions')).toBeInTheDocument();
    expect(stat('Buying Power').getByText('$10,000.00')).toBeInTheDocument();

    // A fired price alert lands in the terminal's Tactical Signals feed.
    addAlert({ ticker: 'ETH-USD', targetPrice: 2000, condition: 'below' }, 'session');
    act(() => {
      runAlertPass({
        assets: [eth(1900)],
        livePrices: new Map<string, LivePrice>(),
        streamConnected: true,
        now: NOW,
      });
    });
    const card = screen.getByText('Price Alert').closest('.suggestion-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Trade' }));
    const ticket = within(screen.getByRole('dialog', { name: 'Trade ETH-USD' }));
    fireEvent.change(ticket.getByLabelText('Order amount (USD)'), { target: { value: '1000' } });
    fireEvent.click(ticket.getByRole('button', { name: 'Buy ETH-USD' }));
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Bought ETH-USD', {
      description: expect.stringMatching(/Paper Trading ledger/),
    });

    // Booked as a tactical fill in paper_trading; Core ledgers untouched.
    expect(store.portfolios.paper_trading.transactions).toEqual([
      expect.objectContaining({ type: 'buy', ticker: 'ETH-USD', intent: 'tactical' }),
    ]);
    expect(store.portfolios.long_term_sim.transactions).toEqual([]);
    expect(store.portfolios.long_term_sim.positions).toEqual([]);
    expect(store.portfolios.real_tracking).toBe(realBefore);

    // ...and shows up in the terminal: position row, fills ledger, buying power.
    const positions = within(screen.getByRole('region', { name: 'Open positions' }));
    expect(positions.getByText('ETH-USD')).toBeInTheDocument();
    const fills = within(screen.getByRole('region', { name: 'Recent Fills' }));
    const [fill] = within(fills.getByRole('table')).getAllByRole('row').slice(1);
    expect(within(fill!).getAllByRole('cell')[1]).toHaveTextContent('BUYTactical');
    expect(stat('Buying Power').getByText('$8,997.50')).toBeInTheDocument(); // 1,000 + 2.50 fee

    // Price rallies to 2,100: 0.5263 sh worth 1,105.26 against a 1,002.50 cost basis.
    view.rerender(tree(2100));
    expect(stat('Open Unrealized P&L').getByText('+$102.76')).toBeInTheDocument();
    expect(stat("Today's Realized P&L").getByText('$0.00')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close ETH-USD position' }));
    expect(toast.error).not.toHaveBeenCalled();

    // Proceeds 1,105.26 − 2.76 fee = 1,102.50, less the 1,002.50 cost basis.
    expect(stat("Today's Realized P&L").getByText('+$100.00')).toBeInTheDocument();
    expect(stat("Today's Realized P&L").getByText(/2 fills today/)).toBeInTheDocument();
    expect(stat('Open Unrealized P&L').getByText('$0.00')).toBeInTheDocument();
    expect(screen.getByText('No open paper positions')).toBeInTheDocument();
    expect(store.portfolios.paper_trading.transactions.map((t) => t.type)).toEqual(['buy', 'sell']);
    expect(store.portfolios.long_term_sim.transactions).toEqual([]);
  });

  it('cannot close a position without a live price to fill at', () => {
    render(tree(Number.NaN));
    act(() => {
      store.executeBuy('paper_trading', { ticker: 'ETH-USD', shares: 1, price: 1900 });
    });
    expect(screen.getByRole('button', { name: 'Close ETH-USD position' })).toBeDisabled();
  });
});
