import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset } from '@/lib/assets';

// Fake Supabase: a thenable query builder plus a channel that captures the
// postgres_changes callback so tests can push realtime events.
const db = vi.hoisted(() => ({
  pending: [] as unknown[],
  claimed: [] as unknown[],
  update: vi.fn(),
  eq: vi.fn(),
  channel: vi.fn(),
  open: vi.fn(),
  status: 'SUBSCRIBED',
  emit: (_payload: unknown) => {},
  // When set, queries wait for release() — a request still in flight.
  hold: false,
  release: () => {},
}));

vi.mock('@/lib/supabaseClient', () => {
  const query = (rows: () => unknown[]) => {
    const q = {
      select: () => q,
      order: () => q,
      eq: (column: string, value: unknown) => {
        db.eq(column, value);
        return q;
      },
      then: (done: (result: { data: unknown[]; error: null }) => void) => {
        const finish = () => done({ data: rows(), error: null });
        if (db.hold) db.release = finish;
        else finish();
      },
    };
    return q;
  };
  const channel = {
    on: (_type: string, filter: unknown, callback: (payload: unknown) => void) => {
      db.channel(filter);
      db.emit = callback;
      return channel;
    },
    subscribe: (callback: (status: string) => void) => {
      callback(db.status);
      return channel;
    },
  };
  return {
    supabase: {
      from: () => ({
        select: () => query(() => db.pending),
        update: (values: unknown) => {
          db.update(values);
          return query(() => db.claimed);
        },
      }),
      channel: (name: string, options: unknown) => {
        db.open(name, options);
        return channel;
      },
      removeChannel: vi.fn(),
    },
  };
});
vi.mock('@/lib/db', () => ({
  loadPortfolio: vi.fn(),
  savePortfolioStateV3: vi.fn(),
  PortfolioNotHydratedError: class PortfolioNotHydratedError extends Error {},
}));
vi.mock('sonner', () => ({
  toast: { dismiss: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

import { PAPER_STARTING_CASH, PortfolioProvider, usePortfolio } from '@/lib/portfolioStore';
import { ActionCenter } from '@/components/ActionCenter';
import { FEE_RATE } from '@/components/TradeTicket';

const btc: Asset = {
  ticker: 'BTC-USD',
  name: 'Bitcoin',
  current_price: 50_000,
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
  updated_at: new Date().toISOString(),
};

function signal(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sig-1',
    user_id: 'user-1',
    ticker: 'BTCUSDT',
    action: 'BUY',
    conviction_score: 85,
    suggested_size: 500,
    stop_loss: 48_000,
    status: 'PENDING',
    created_at: '2026-10-20T12:00:00.000Z',
    ...overrides,
  };
}

let store: ReturnType<typeof usePortfolio>;
function Probe() {
  store = usePortfolio();
  return null;
}

function renderSignedIn() {
  render(
    <PortfolioProvider>
      <ActionCenter assets={[btc]} />
      <Probe />
    </PortfolioProvider>,
  );
  act(() => store.switchScope('user-1'));
}

describe('Action Center', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    db.pending = [];
    db.claimed = [{ id: 'sig-1' }];
    db.hold = false;
    db.status = 'SUBSCRIBED';
  });
  afterEach(cleanup);

  it('subscribes to the user’s signals and shows a realtime BUY as one big card', async () => {
    renderSignedIn();
    expect(db.open).toHaveBeenCalledWith('trading-signals:user-1', {
      config: { postgres_changes_options: { wait: true } },
    });
    expect(db.channel).toHaveBeenCalledWith(
      expect.objectContaining({ table: 'trading_signals', filter: 'user_id=eq.user-1' }),
    );
    expect(screen.queryByRole('region', { name: 'Action center' })).toBeNull();

    act(() => db.emit({ eventType: 'INSERT', new: signal() }));

    expect(screen.getByRole('alert')).toHaveTextContent('BUY SIGNAL: BTCUSDT');
    expect(screen.getByText('85%')).toBeInTheDocument();
    expect(screen.getByText('$500.00')).toBeInTheDocument();

    // Resolved elsewhere (another tab): the card goes away.
    act(() => db.emit({ eventType: 'UPDATE', new: signal({ status: 'EXECUTED' }) }));
    expect(screen.queryByRole('region', { name: 'Action center' })).toBeNull();
  });

  it('does not bring back a signal resolved while the backlog fetch is in flight', () => {
    db.pending = [signal()];
    db.hold = true;
    renderSignedIn();

    act(() => db.emit({ eventType: 'UPDATE', new: signal({ status: 'EXECUTED' }) }));
    act(() => db.release());
    expect(screen.queryByRole('region', { name: 'Action center' })).toBeNull();
  });

  it('still loads the backlog when the realtime join fails', async () => {
    db.pending = [signal()];
    db.status = 'CHANNEL_ERROR';
    renderSignedIn();
    expect(await screen.findByRole('alert')).toHaveTextContent('BUY SIGNAL: BTCUSDT');
  });

  it('ignores a late PENDING event for a signal this tab already resolved', async () => {
    db.pending = [signal()];
    renderSignedIn();

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Action center' })).toBeNull());
    act(() => db.emit({ eventType: 'INSERT', new: signal() }));
    expect(screen.queryByRole('region', { name: 'Action center' })).toBeNull();
  });

  it('Execute claims the signal and books the fill in the paper_trading ledger', async () => {
    db.pending = [signal()];
    renderSignedIn();

    fireEvent.click(await screen.findByRole('button', { name: 'Execute Trade (Paper)' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Action center' })).toBeNull());

    expect(db.update).toHaveBeenCalledWith({ status: 'EXECUTED' });
    expect(db.eq).toHaveBeenCalledWith('id', 'sig-1');
    expect(db.eq).toHaveBeenCalledWith('status', 'PENDING');

    const paper = store.portfolios.paper_trading;
    expect(paper.positions).toHaveLength(1);
    expect(paper.positions[0]).toMatchObject({ ticker: 'BTC-USD', shares: 0.01 });
    expect(paper.cashBalance).toBeCloseTo(PAPER_STARTING_CASH - 500 * (1 + FEE_RATE), 6);
    expect(paper.transactions.at(-1)).toMatchObject({
      type: 'buy',
      ticker: 'BTC-USD',
      price: 50_000,
      intent: 'tactical',
    });
    // Core ledgers never see it.
    expect(store.portfolios.long_term_sim.transactions.some((t) => t.type === 'buy')).toBe(false);
  });

  it('does not book a fill when another tab already claimed the signal', async () => {
    db.pending = [signal()];
    db.claimed = [];
    renderSignedIn();

    fireEvent.click(await screen.findByRole('button', { name: 'Execute Trade (Paper)' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Action center' })).toBeNull());
    expect(store.portfolios.paper_trading.positions).toHaveLength(0);
  });

  it('rejects an unaffordable order without consuming the signal', async () => {
    db.pending = [signal({ suggested_size: PAPER_STARTING_CASH * 2 })];
    renderSignedIn();

    fireEvent.click(await screen.findByRole('button', { name: 'Execute Trade (Paper)' }));
    expect(db.update).not.toHaveBeenCalled();
    expect(screen.getByRole('region', { name: 'Action center' })).toBeInTheDocument();
    expect(store.portfolios.paper_trading.positions).toHaveLength(0);
  });

  it('Dismiss resolves the signal and leaves the ledger untouched', async () => {
    db.pending = [signal(), signal({ id: 'sig-2', action: 'SELL', ticker: 'BTC-USD' })];
    renderSignedIn();

    expect(await screen.findByText('+1 more waiting')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('SELL SIGNAL'));

    expect(db.update).toHaveBeenCalledWith({ status: 'DISMISSED' });
    expect(store.portfolios.paper_trading.transactions.some((t) => t.type === 'buy')).toBe(false);
  });
});
