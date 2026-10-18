import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PortfolioTransaction } from '@/lib/portfolioAccounting';
import type { Asset } from '@/lib/assets';
import { executionDrag, frictionBps, tradeLedgerCsv } from '@/lib/tradeLedger';

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
vi.mock('@/components/TradeTicket', () => ({ FEE_RATE: 0.0025, TradeTicket: () => null }));
vi.mock('@/components/AuthModal', () => ({ AuthModal: () => null }));

import { AuthProvider } from '@/lib/authStore';
import { PortfolioProvider, usePortfolio } from '@/lib/portfolioStore';
import { PortfolioDashboard } from '@/components/PortfolioDashboard';

function trade(overrides: Partial<PortfolioTransaction>): PortfolioTransaction {
  return {
    id: 'tx',
    portfolioType: 'long_term_sim',
    type: 'buy',
    amount: 0,
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('trade ledger helpers', () => {
  const buy = trade({
    type: 'buy',
    ticker: 'AAPL',
    shares: 10,
    price: 100,
    fee: 2,
    slippage: 3,
    intent: 'rebalance',
  });
  const sell = trade({ type: 'sell', ticker: 'AAPL', shares: 4, price: 120, fee: 1 });
  const deposit = trade({ type: 'deposit', amount: 500, note: 'Top-up, "monthly"' });

  it('sums fees + slippage across fills only', () => {
    expect(executionDrag([buy, sell, deposit])).toBe(6);
    expect(executionDrag([])).toBe(0);
  });

  it('expresses friction in bps of notional, null for cash movements', () => {
    expect(frictionBps(buy)).toBe(50);
    expect(frictionBps(sell)).toBeCloseTo(20.8333, 4);
    expect(frictionBps(deposit)).toBeNull();
  });

  it('exports RFC 4180 CSV with a header row and quoted user text', () => {
    const lines = tradeLedgerCsv([buy, sell, deposit]).split('\r\n');
    expect(lines[0]).toBe(
      'timestamp,side,ticker,quantity,price,fee,slippage,friction_bps,amount,realized_pnl,intent,note',
    );
    expect(lines[1]).toBe('2026-01-01T00:00:00.000Z,BUY,AAPL,10,100,2,3,50,0,,rebalance,');
    expect(lines[2]).toBe('2026-01-01T00:00:00.000Z,SELL,AAPL,4,120,1,,20.83,0,,,');
    expect(lines[3]).toBe('2026-01-01T00:00:00.000Z,DEPOSIT,,,,,,,500,,,"Top-up, ""monthly"""');
  });

  it('neutralises spreadsheet formulas in text but keeps negative numbers', () => {
    const csv = tradeLedgerCsv([
      trade({ type: 'sell', ticker: '=HYPERLINK("x")', shares: 1, price: 1, realizedPnl: -30 }),
    ]);
    expect(csv.split('\r\n')[1]).toBe(
      `2026-01-01T00:00:00.000Z,SELL,"'=HYPERLINK(""x"")",1,1,,,0,0,-30,,`,
    );
  });
});

function asset(ticker: string, price: number): Asset {
  return {
    ticker,
    name: ticker,
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

let store: ReturnType<typeof usePortfolio>;
function Probe() {
  store = usePortfolio();
  return null;
}

describe('portfolio P&L attribution and trade ledger', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function renderDashboard() {
    const view = render(
      <PortfolioProvider>
        <AuthProvider>
          <Probe />
          <PortfolioDashboard assets={[asset('AAPL', 110)]} />
        </AuthProvider>
      </PortfolioProvider>,
    );
    act(() => {
      store.executeBuy('long_term_sim', {
        ticker: 'AAPL',
        shares: 10,
        price: 100,
        fee: 2,
        slippage: 3,
        requireCash: false,
        timestamp: '2026-03-01T10:00:00.000Z',
      });
      store.executeSell('long_term_sim', {
        ticker: 'AAPL',
        shares: 4,
        price: 120,
        fee: 1,
        creditCash: false,
        timestamp: '2026-03-02T10:00:00.000Z',
      });
    });
    return view;
  }

  it('breaks P&L into unrealized, realized and execution drag', () => {
    const { container } = renderDashboard();
    const strip = within(screen.getByRole('region', { name: 'P&L attribution' }));

    // 6 open shares: cost 600 + $3 of remaining fees, marked at 110 → +57 (+9.45%).
    expect(strip.getByText('+$57.00')).toBeInTheDocument();
    expect(strip.getByText(/\+9\.45%/)).toBeInTheDocument();
    // Sold 4 @120 less $1 fee against 400 + $2 allocated fees → +77.
    expect(strip.getByText('+$77.00')).toBeInTheDocument();
    expect(strip.getByText(/1 closed trade/)).toBeInTheDocument();
    expect(strip.getByText('$6.00')).toBeInTheDocument();
    expect(strip.getByText(/2 fills/)).toBeInTheDocument();

    // Tour targets on the Portfolio workspace are mounted.
    expect(container.querySelector('[data-tour="wealth"]')).not.toBeNull();
    expect(container.querySelector('[data-tour="pnl-attribution"]')).not.toBeNull();
  });

  it('shows each holding at its fee-inclusive cost with a date-only Date added', () => {
    const { container } = renderDashboard();
    const holding = within(container.querySelector<HTMLElement>('.holding')!);
    const metric = (label: string) => holding.getByText(label).nextElementSibling;

    // 6 shares @100 plus the $3 of fees still on the lot, like the Invested card.
    expect(metric('Invested')).toHaveTextContent('$603.00');
    expect(metric('Date added')).toHaveTextContent(/^2026-03-01$/);
    // Marked at 110, net of those fees — the same +57 / +9.45% as the strip.
    expect(holding.getByText('+$57.00')).toBeInTheDocument();
    expect(holding.getByText('+9.45%')).toBeInTheDocument();
  });

  it('lists ledger entries newest first once expanded', () => {
    renderDashboard();
    const toggle = screen.getByRole('button', { name: /trade ledger/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('table')).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('SELL')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('$1.00 · 20.8 bps')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('+$77.00')).toHaveClass('pnl-up');
    expect(within(rows[1]!).getByText('BUY')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('$5.00 · 50.0 bps')).toBeInTheDocument();
  });

  it('downloads the ledger as CSV in one click', () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:ledger');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.download).toBe('zerochart-ledger-simulation.csv');
      expect(this.href).toBe('blob:ledger');
      expect(this.isConnected).toBe(true);
    });

    renderDashboard();
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));

    expect(click).toHaveBeenCalledTimes(1);
    expect(createObjectURL.mock.calls[0]?.[0].type).toBe('text/csv;charset=utf-8');
  });
});
