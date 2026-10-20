import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset } from '@/lib/assets';
import type { LivePrice } from '@/lib/livePriceStore';

vi.mock('sonner', () => ({
  toast: { dismiss: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));
// No canonical score for ETH: the feed holds only the price alert.
vi.mock('@/hooks/useCanonicalScores', () => ({ useCanonicalScores: () => new Map() }));

import { PortfolioProvider } from '@/lib/portfolioStore';
import { TacticalSignals } from '@/components/TacticalSignals';
import { __resetAlertsStoreForTests, addAlert } from '@/lib/alertsStore';
import { runAlertPass } from '@/lib/alertEngine';

const NOW = Date.parse('2026-10-18T12:00:00Z');

const ETH: Asset = {
  ticker: 'ETH-USD',
  name: 'Ethereum',
  current_price: 1900,
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

describe('Tactical Signals feed with price alerts', () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetAlertsStoreForTests();
  });
  afterEach(cleanup);

  it('adds a fired alert as a Price Alert card whose Trade CTA opens that asset', () => {
    addAlert({ ticker: 'ETH-USD', targetPrice: 2000, condition: 'below' }, 'session');
    render(
      <PortfolioProvider>
        <TacticalSignals assets={[ETH]} />
      </PortfolioProvider>,
    );
    expect(screen.getByText('No tactical signal right now')).toBeInTheDocument();

    act(() => {
      runAlertPass({
        assets: [ETH],
        livePrices: new Map<string, LivePrice>(),
        streamConnected: true,
        now: NOW,
      });
    });

    const card = screen.getByText('Price Alert').closest('.suggestion-card') as HTMLElement;
    expect(card).toHaveClass('suggestion-alert-down');
    expect(within(card).getByText('Crossed below $2,000.00')).toBeInTheDocument();
    expect(within(card).getByText('Triggered at $1,900.00.')).toBeInTheDocument();
    expect(card.querySelector('time')).toHaveAttribute('datetime', new Date(NOW).toISOString());

    fireEvent.click(within(card).getByRole('button', { name: 'Trade' }));
    const ticket = within(screen.getByRole('dialog', { name: 'Trade ETH-USD' }));
    expect(ticket.getByRole('button', { name: 'Buy ETH-USD' })).toBeInTheDocument();
  });
});
