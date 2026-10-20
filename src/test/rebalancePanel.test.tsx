import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import type { Asset } from '@/lib/assets';
import type { PortfolioTransaction } from '@/lib/portfolioAccounting';

vi.mock('@/hooks/useCanonicalScores', () => ({ useCanonicalScores: () => new Map() }));
vi.mock('sonner', () => ({
  toast: { dismiss: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

import { PortfolioProvider } from '@/lib/portfolioStore';
import { RebalancePanel } from '@/components/RebalancePanel';

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

const STORAGE_KEY = 'zerochart:portfolio-positions';
const holding = (ticker: string) => ({
  id: `position-${ticker.toLowerCase()}`,
  ticker,
  buyPrice: 100,
  shares: 10,
  isSimulation: true,
  dateAdded: '2026-01-01',
});

function ledger(): PortfolioTransaction[] {
  return JSON.parse(window.localStorage.getItem(STORAGE_KEY)!).portfolios.long_term_sim
    .transactions;
}

function fill(label: string, side: 'Buy' | 'Sell', ticker: string) {
  fireEvent.click(screen.getByRole('button', { name: label }));
  const ticket = within(screen.getByRole('dialog', { name: `Trade ${ticker}` }));
  expect(ticket.getByText(/Core rebalance/)).toBeInTheDocument();
  expect(ticket.getByRole('button', { name: side })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(ticket.getByRole('button', { name: `${side} ${ticker}` }));
}

describe('Core rebalancing panel', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    // Fully invested 50/50 at cost; AAPL has since rallied to $140.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 3,
        activePortfolioType: 'long_term_sim',
        portfolios: {
          long_term_sim: {
            type: 'long_term_sim',
            positions: [holding('AAPL'), holding('NVDA')],
            cashBalance: 0,
            cashLedger: [],
            transactions: [],
            realizedPnl: 0,
          },
        },
      }),
    );
  });
  afterEach(cleanup);

  it('sets targets, then sells the overweight and reinvests the proceeds back inside the band', () => {
    render(
      <PortfolioProvider>
        <RebalancePanel
          portfolioType="long_term_sim"
          assets={[asset('AAPL', 140), asset('NVDA', 100)]}
        />
      </PortfolioProvider>,
    );

    expect(screen.getByText('No target allocation yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Set targets' }));
    // Prefilled with today's weights: $1,400 / $1,000.
    expect(screen.getByLabelText('AAPL target %')).toHaveValue(58.3);
    fireEvent.change(screen.getByLabelText('AAPL target %'), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText('NVDA target %'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save targets' }));

    expect(screen.getByText(/past the 5-pt band/)).toBeInTheDocument();
    expect(screen.getByText('+8.3 pts')).toBeInTheDocument();
    expect(screen.getByText('Needs cash')).toBeInTheDocument(); // the buy waits for the sell

    fill('Sell $200.00', 'Sell', 'AAPL');
    // $199.50 proceeds buy $199.00 + $0.50 fee.
    fill('Buy $199.00', 'Buy', 'NVDA');

    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByText(/Within the 5-pt band/)).toBeInTheDocument();
    expect(ledger().map((transaction) => `${transaction.type}:${transaction.intent}`)).toEqual([
      'sell:rebalance',
      'buy:rebalance',
    ]);
  });
});
