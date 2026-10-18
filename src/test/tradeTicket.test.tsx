import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import type { Asset } from '@/lib/assets';

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
      signOut: vi.fn(),
    },
  },
}));
vi.mock('@/lib/db', () => ({
  loadPortfolio: vi.fn(),
  savePortfolioStateV3: vi.fn(),
  PortfolioNotHydratedError: class PortfolioNotHydratedError extends Error {},
}));
vi.mock('sonner', () => ({
  toast: { dismiss: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));
vi.mock('@/components/AllocationChart', () => ({ AllocationChart: () => null }));
vi.mock('@/components/BacktestChart', () => ({ BacktestChart: () => null }));
vi.mock('@/components/PriceAlerts', () => ({ PriceAlerts: () => null }));
vi.mock('@/components/AuthModal', () => ({ AuthModal: () => null }));

import { AuthProvider } from '@/lib/authStore';
import { PortfolioProvider } from '@/lib/portfolioStore';
import { PortfolioDashboard } from '@/components/PortfolioDashboard';

function aapl(price: number): Asset {
  return {
    ticker: 'AAPL',
    name: 'Apple',
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
  };
}

function tree(price: number) {
  return (
    <PortfolioProvider>
      <AuthProvider>
        <PortfolioDashboard assets={[aapl(price)]} />
      </AuthProvider>
    </PortfolioProvider>
  );
}

function trade(side: 'Buy' | 'Sell', amount: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Trade' }));
  const ticket = within(screen.getByRole('dialog', { name: 'Trade AAPL' }));
  fireEvent.click(ticket.getByRole('button', { name: side }));
  fireEvent.change(ticket.getByLabelText('Order amount (USD)'), { target: { value: amount } });
  fireEvent.click(ticket.getByRole('button', { name: `${side} AAPL` }));
}

describe('Trade Ticket in Simulation mode', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  it('records a buy then a sell in the ledger with 25 bps fees and realized P&L', () => {
    const view = render(tree(100));

    // Funds the sim portfolio, not the live tracker.
    fireEvent.change(screen.getByLabelText('Cash amount'), { target: { value: '2000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Deposit' }));

    trade('Buy', '1000'); // 10 sh @ 100, fee $2.50
    view.rerender(tree(120));
    trade('Sell', '600'); // 5 sh @ 120, fee $1.50
    expect(toast.error).not.toHaveBeenCalled();

    // Proceeds 598.50 − cost (500 + 1.25 allocated fee) = +97.25.
    const strip = within(screen.getByRole('region', { name: 'P&L attribution' }));
    expect(strip.getByText('+$97.25')).toBeInTheDocument();
    // 5 open shares: 600 − (500 + 1.25) = +98.75, same on the headline KPI
    // and on the holding row, which is net of fees too.
    expect(strip.getByText('+$98.75')).toBeInTheDocument();
    expect(screen.getAllByText('+$98.75')).toHaveLength(3);
    expect(screen.getByText(/\$1,596\.00 available/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /trade ledger/i }));
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows.map((row) => within(row).getAllByRole('cell')[1]?.textContent)).toEqual([
      'SELL',
      'BUY',
      'DEPOSIT',
    ]);
    expect(within(rows[0]!).getByText('$1.50 · 25.0 bps')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('+$97.25')).toHaveClass('pnl-up');
    expect(within(rows[1]!).getByText('$2.50 · 25.0 bps')).toBeInTheDocument();
  });

  it("shows the engine's rejection and records nothing", () => {
    render(tree(100));

    trade('Buy', '1000');
    expect(toast.error).toHaveBeenLastCalledWith('Insufficient cash');

    fireEvent.change(screen.getByLabelText('Cash amount'), { target: { value: '200' } });
    fireEvent.click(screen.getByRole('button', { name: 'Deposit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    trade('Buy', '100');
    trade('Sell', '500');
    expect(toast.error).toHaveBeenLastCalledWith('Insufficient shares');
    expect(screen.getByText('2 ENTRIES')).toBeInTheDocument(); // deposit + buy
  });

  it('closing a Simulation holding sells it at the live price into the ledger', () => {
    const view = render(tree(100));
    fireEvent.change(screen.getByLabelText('Cash amount'), { target: { value: '2000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Deposit' }));
    trade('Buy', '1000'); // 10 sh @ 100, fee $2.50

    // No live price, nothing to fill at.
    view.rerender(tree(Number.NaN));
    expect(screen.getByRole('button', { name: /close position/i })).toBeDisabled();

    view.rerender(tree(120));
    fireEvent.click(screen.getByRole('button', { name: /close position/i }));
    expect(toast.error).not.toHaveBeenCalled();

    // 10 sh @ 120, fee $3.00: proceeds 1,197 − cost (1,000 + 2.50) = +194.50.
    const strip = within(screen.getByRole('region', { name: 'P&L attribution' }));
    expect(strip.getByText('+$194.50')).toBeInTheDocument();
    expect(screen.getByText('No simulation positions')).toBeInTheDocument();
    expect(screen.getByText(/\$2,194\.50 available/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /trade ledger/i }));
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(within(rows[0]!).getAllByRole('cell')[1]).toHaveTextContent('SELL');
    expect(within(rows[0]!).getByText('$3.00 · 25.0 bps')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('+$194.50')).toHaveClass('pnl-up');
  });

  it('closing a Live Tracking holding only removes it, even without a live price', () => {
    render(tree(100));
    fireEvent.click(screen.getByRole('tab', { name: 'Live Tracking' }));

    // Demo NVDA has no asset row, so no live price.
    fireEvent.click(screen.getAllByRole('button', { name: /close position/i })[0]!);
    expect(screen.getByText('1 POSITION')).toBeInTheDocument();
    expect(screen.getByText('0 ENTRIES')).toBeInTheDocument();
  });

  it('keeps Live Tracking trades as mock executions', () => {
    render(tree(100));
    fireEvent.click(screen.getByRole('tab', { name: 'Live Tracking' }));

    trade('Buy', '100');
    expect(toast.success).toHaveBeenCalledWith('Buy order submitted', expect.anything());
    expect(screen.getByText('0 ENTRIES')).toBeInTheDocument();
  });
});
