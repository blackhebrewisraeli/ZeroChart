import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset } from '@/lib/assets';

// Fake Supabase: a thenable query builder plus a channel that captures the
// postgres_changes callback so tests can push realtime events.
const db = vi.hoisted(() => ({
  pending: [] as unknown[],
  claimed: [] as unknown[],
  // Error the status update resolves with (a failed claim).
  updateError: null as { message: string } | null,
  rpcError: null as { message: string } | null,
  rows: [] as Array<Record<string, unknown>>,
  insert: vi.fn(),
  update: vi.fn(),
  rpc: vi.fn(),
  eq: vi.fn(),
  channel: vi.fn(),
  open: vi.fn(),
  status: 'SUBSCRIBED',
  // When set, subscribe() withholds its status until the test calls report().
  holdStatus: false,
  report: (_status: string) => {},
  emit: (_payload: unknown) => {},
  // When set, queries wait for release() — a request still in flight.
  hold: false,
  release: () => {},
}));

vi.mock('@/lib/supabaseClient', () => {
  const query = (rows: () => unknown[], error: () => unknown = () => null) => {
    const q = {
      select: () => q,
      order: () => q,
      eq: (column: string, value: unknown) => {
        db.eq(column, value);
        return q;
      },
      then: (done: (result: { data: unknown[]; error: null }) => void) => {
        const finish = () => done({ data: rows(), error: error() as null });
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
      if (db.holdStatus) db.report = callback;
      else callback(db.status);
      return channel;
    },
  };
  return {
    supabase: {
      rpc: async (name: string, args: Record<string, unknown>) => {
        db.rpc(name, args);
        if (db.rpcError) return { data: null, error: db.rpcError };
        const source = db.pending.find(
          (candidate) => (candidate as { id?: string }).id === args['signal_id'],
        ) as ReturnType<typeof signal> | undefined;
        if (source && !db.rows.some((row) => row['signal_id'] === source.id)) {
          db.rows.push({
            id: `row-${db.rows.length}`,
            action: source.action,
            ticker: 'BTC-USD',
            quantity: Number(source.quantity),
            price: Number(args['execution_price']),
            fees: Number(source.quantity) * Number(args['execution_price']) * 0.0025,
            created_at: new Date().toISOString(),
            signal_id: source.id,
          });
        }
        return { data: db.rows.at(-1) ?? null, error: null };
      },
      from: () => ({
        select: () => query(() => db.pending),
        update: (values: unknown) => {
          db.update(values);
          return query(
            () => db.claimed,
            () => db.updateError,
          );
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
  insertPaperTransaction: db.insert,
  loadPaperTransactions: vi.fn(async () => [...db.rows]),
  PortfolioNotHydratedError: class PortfolioNotHydratedError extends Error {},
}));
vi.mock('@/hooks/useCanonicalScores', () => ({ useCanonicalScores: () => new Map() }));
vi.mock('sonner', () => ({
  toast: { dismiss: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

import { PAPER_STARTING_CASH, PortfolioProvider, usePortfolio } from '@/lib/portfolioStore';
import { ActionCenter } from '@/components/ActionCenter';
import { SignalDiagnostics } from '@/components/SignalDiagnostics';
import { FEE_RATE } from '@/components/TradeTicket';
import { toast } from 'sonner';

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
    signal_score: 85,
    quantity: 0.01,
    price: 49_000,
    stop_loss: 48_000,
    event_id: '2026-10-20T12:00:00Z',
    signal_kind: 'strategy',
    exchange: 'BINANCE',
    timeframe: '1D',
    bar_time: '2026-10-20T12:00:00Z',
    model_version: '1.0.0',
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
    db.rows = [];
    db.pending = [];
    db.claimed = [{ id: 'sig-1' }];
    db.updateError = null;
    db.rpcError = null;
    db.hold = false;
    db.status = 'SUBSCRIBED';
    db.holdStatus = false;
  });

  it('warns when a TradingView signal lacks strategy provenance', async () => {
    db.pending = [signal({ exchange: null, timeframe: null, bar_time: null, model_version: null })];
    renderSignedIn();

    expect(
      await screen.findByText(/Source details are incomplete.*Verify this alert in TradingView/),
    ).toBeVisible();
  });

  it('shows complete TradingView strategy provenance when supplied', async () => {
    db.pending = [
      signal({
        exchange: 'BINANCE',
        timeframe: '1D',
        bar_time: '2026-10-20T12:00:00Z',
        model_version: '1.0.0',
      }),
    ];
    renderSignedIn();

    expect(await screen.findByText('Source: BINANCE · 1D · model 1.0.0')).toBeVisible();
    expect(screen.queryByText(/Source details are incomplete/)).toBeNull();
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
    expect(screen.getByText('85 / 100')).toBeInTheDocument();
    expect(screen.getByText('0.01 units')).toBeInTheDocument();
    // Notional at the live price, not the alert's $49,000.
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

  it('waits for the channel status before querying the backlog', async () => {
    db.pending = [signal()];
    db.holdStatus = true;
    renderSignedIn();
    expect(db.eq).not.toHaveBeenCalledWith('user_id', 'user-1');

    act(() => db.report('SUBSCRIBED'));
    expect(await screen.findByRole('alert')).toHaveTextContent('BUY SIGNAL: BTCUSDT');
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

  it('executes the signal and paper fill through one atomic RPC', async () => {
    db.pending = [signal()];
    renderSignedIn();

    fireEvent.click(await screen.findByRole('button', { name: 'Execute Trade (Paper)' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Action center' })).toBeNull());

    expect(db.rpc).toHaveBeenCalledWith('execute_tactical_signal', {
      signal_id: 'sig-1',
      user_id: 'user-1',
      execution_price: 50_000,
    });
    expect(db.update).not.toHaveBeenCalledWith({ status: 'EXECUTED' });

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
    // Booked as a server row, and the account is its replay.
    expect(db.rows).toEqual([expect.objectContaining({ action: 'BUY', ticker: 'BTC-USD' })]);
    expect(paper.transactions.at(-1)?.id).toBe(db.rows[0]?.['id']);
    // Core ledgers never see it.
    expect(store.portfolios.long_term_sim.transactions.some((t) => t.type === 'buy')).toBe(false);
  });

  it('books a TradingView USD pair (BTCUSD) against the app’s crypto asset', async () => {
    db.pending = [signal({ ticker: 'BTCUSD' })];
    renderSignedIn();

    fireEvent.click(await screen.findByRole('button', { name: 'Execute Trade (Paper)' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Action center' })).toBeNull());
    expect(store.portfolios.paper_trading.positions[0]).toMatchObject({
      ticker: 'BTC-USD',
      shares: 0.01,
    });
  });

  it('does not duplicate the fill when Execute is clicked repeatedly', async () => {
    db.pending = [signal()];
    renderSignedIn();

    const execute = await screen.findByRole('button', { name: 'Execute Trade (Paper)' });
    fireEvent.click(execute);
    fireEvent.click(execute);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Action center' })).toBeNull());
    expect(store.portfolios.paper_trading.positions).toHaveLength(1);
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(db.rows).toHaveLength(1);
  });

  it('keeps the signal visible and books nothing when the atomic RPC fails', async () => {
    db.pending = [signal()];
    db.rpcError = { message: 'Insufficient cash' };
    renderSignedIn();

    fireEvent.click(await screen.findByRole('button', { name: 'Execute Trade (Paper)' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Insufficient cash'));
    expect(screen.getByRole('region', { name: 'Action center' })).toBeInTheDocument();
    expect(store.portfolios.paper_trading.positions).toHaveLength(0);
    expect(db.rows).toHaveLength(0);
  });

  it('shows an unaffordable BUY with Execute disabled and the reason, without consuming it', async () => {
    db.pending = [signal({ quantity: (PAPER_STARTING_CASH * 2) / btc.current_price! })];
    renderSignedIn();

    const execute = await screen.findByRole('button', { name: 'Execute Trade (Paper)' });
    expect(execute).toBeDisabled();
    expect(execute).toHaveAccessibleDescription(
      'Not enough cash: this order needs $200,500.00, $100,000.00 available.',
    );
    fireEvent.click(execute);
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeEnabled();
    expect(store.portfolios.paper_trading.positions).toHaveLength(0);
  });

  it('disables Execute when the BUY would breach the portfolio risk limit', async () => {
    // 0.5 BTC filled at $50,000 with a $30,000 stop risks $10,000: 10% of equity.
    db.pending = [signal({ quantity: 0.5, stop_loss: 30_000 })];
    renderSignedIn();

    expect(await screen.findByText('BUY SIGNAL: BTCUSDT', { exact: false })).toBeInTheDocument();
    const execute = screen.getByRole('button', { name: 'Execute Trade (Paper)' });
    expect(execute).toBeDisabled();
    expect(
      screen.getByText('Portfolio max risk reached: 0% open + 10% new would pass the 6% limit.'),
    ).toBeInTheDocument();
    expect(db.insert).not.toHaveBeenCalled();
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

describe('trading_signals under the ?devAuth stub', () => {
  afterEach(cleanup);

  // The id, not the URL: zone navigation drops `?devAuth` but the stub stays signed in.
  it('never queries or subscribes, since the stub has no session', () => {
    vi.clearAllMocks();
    render(
      <PortfolioProvider>
        <ActionCenter assets={[btc]} />
        <SignalDiagnostics />
        <Probe />
      </PortfolioProvider>,
    );
    act(() => store.switchScope('00000000-0000-4000-8000-000000000001'));

    expect(db.open).not.toHaveBeenCalled();
    expect(db.eq).not.toHaveBeenCalled();
  });
});
