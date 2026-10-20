import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Position } from '@/lib/portfolioManager';

const harness = vi.hoisted(() => ({
  authCallbacks: [] as Array<(event: string, session: unknown) => void>,
  getSession: vi.fn(),
  signOutFn: vi.fn(),
  loadPortfolio: vi.fn(),
  savePortfolio: vi.fn(),
  loadIsPro: vi.fn(),
}));

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: harness.getSession,
      onAuthStateChange: (callback: (event: string, session: unknown) => void) => {
        harness.authCallbacks.push(callback);
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
      signOut: harness.signOutFn,
    },
  },
}));

vi.mock('@/lib/db', () => ({
  loadPortfolio: harness.loadPortfolio,
  savePortfolio: harness.savePortfolio,
  loadPaperTransactions: vi.fn(async () => []),
  loadIsPro: harness.loadIsPro,
  PortfolioNotHydratedError: class PortfolioNotHydratedError extends Error {},
}));

import { getHydrationState, resetHydration } from '@/lib/hydrationStore';
import { AuthProvider, useAuth } from '@/lib/authStore';
import { PortfolioProvider, usePortfolio } from '@/lib/portfolioStore';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const GUEST_KEY = 'zerochart:portfolio-positions';
const userKey = (userId: string) => `zerochart:portfolio-positions:${userId}`;

const positionA: Position = {
  id: 'p-a',
  ticker: 'MSFT',
  buyPrice: 400,
  shares: 2,
  isSimulation: false,
  dateAdded: '2026-01-01',
};
const positionB: Position = {
  id: 'p-b',
  ticker: 'TSLA',
  buyPrice: 250,
  shares: 3,
  isSimulation: false,
  dateAdded: '2026-01-02',
};

function Probe() {
  const { positions } = usePortfolio();
  const { user, isPro, signOut } = useAuth();
  return (
    <div>
      <span data-testid="user">{user?.id ?? 'guest'}</span>
      <span data-testid="tier">{isPro ? 'pro' : 'basic'}</span>
      <span data-testid="tickers">{positions.map((p) => p.ticker).join(',')}</span>
      <button type="button" onClick={() => void signOut()}>
        sign-out
      </button>
    </div>
  );
}

async function renderHarness() {
  render(
    <PortfolioProvider>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </PortfolioProvider>,
  );
  // Flush the initial `getSession` resolution so the emitted auth events below
  // are the ONLY source of auth-state changes (mirrors a settled app boot).
  await act(async () => {});
}

function emitAuth(session: { user: { id: string } } | null) {
  act(() => {
    for (const callback of harness.authCallbacks) {
      callback(session ? 'SIGNED_IN' : 'SIGNED_OUT', session);
    }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  resetHydration();
  harness.authCallbacks.length = 0;
  harness.getSession.mockResolvedValue({ data: { session: null } });
  harness.loadPortfolio.mockResolvedValue(null);
  harness.loadIsPro.mockResolvedValue(false);
  harness.signOutFn.mockImplementation(async () => {
    for (const callback of harness.authCallbacks) callback('SIGNED_OUT', null);
  });
});

afterEach(cleanup);

describe('account data isolation (M1-T1, F-4.1a)', () => {
  it('clears user A positions on sign-out and never leaks them to user B', async () => {
    harness.getSession.mockResolvedValue({ data: { session: { user: { id: 'user-a' } } } });
    const loadA = deferred<Position[] | null>();
    harness.loadPortfolio.mockImplementation((userId: string) =>
      userId === 'user-a' ? loadA.promise : Promise.resolve([]),
    );

    await renderHarness();
    await waitFor(() =>
      expect(getHydrationState()).toEqual({ status: 'hydrating', userId: 'user-a' }),
    );
    await act(async () => {
      loadA.resolve([positionA]);
    });
    await waitFor(() => expect(screen.getByTestId('tickers')).toHaveTextContent('MSFT'));

    // Sign out — memory is re-scoped to guest immediately.
    fireEvent.click(screen.getByText('sign-out'));
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('guest'));
    expect(screen.getByTestId('tickers').textContent).not.toContain('MSFT');

    // A's positions were flushed under A's own key, never the guest key.
    expect(window.localStorage.getItem(userKey('user-a'))).toContain('MSFT');
    expect(window.localStorage.getItem(GUEST_KEY) ?? '').not.toContain('MSFT');

    // User B logs in with an EXPLICIT EMPTY cloud row — must see an empty
    // portfolio, never A's leftovers (and not the demo seeds either).
    const loadB = deferred<Position[] | null>();
    harness.loadPortfolio.mockImplementation((userId: string) =>
      userId === 'user-b' ? loadB.promise : Promise.resolve(null),
    );
    emitAuth({ user: { id: 'user-b' } });
    await waitFor(() =>
      expect(getHydrationState()).toEqual({ status: 'hydrating', userId: 'user-b' }),
    );
    await act(async () => {
      loadB.resolve([]);
    });
    await waitFor(() => expect(screen.getByTestId('tickers')).toBeEmptyDOMElement());
    expect(screen.getByTestId('tickers').textContent).not.toContain('MSFT');
    expect(harness.loadPortfolio).toHaveBeenCalledWith('user-b');
  });

  it('clears the in-memory portfolio immediately on sign-out, before the network call resolves', async () => {
    harness.getSession.mockResolvedValue({ data: { session: { user: { id: 'user-a' } } } });
    harness.loadPortfolio.mockResolvedValue([positionA]);

    await renderHarness();
    await waitFor(() => expect(screen.getByTestId('tickers')).toHaveTextContent('MSFT'));

    const networkSignOut = deferred<void>();
    harness.signOutFn.mockImplementation(() => {
      for (const callback of harness.authCallbacks) callback('SIGNED_OUT', null);
      return networkSignOut.promise;
    });

    fireEvent.click(screen.getByText('sign-out'));
    // Already cleared although the network sign-out has not resolved yet.
    expect(screen.getByTestId('tickers').textContent).not.toContain('MSFT');
    expect(getHydrationState()).toEqual({ status: 'idle', userId: null });

    await act(async () => {
      networkSignOut.resolve(undefined);
    });
  });

  it('persists each account under its own storage key', async () => {
    harness.getSession.mockResolvedValue({ data: { session: { user: { id: 'user-a' } } } });
    harness.loadPortfolio.mockResolvedValue([positionA]);

    await renderHarness();
    await waitFor(() => expect(screen.getByTestId('tickers')).toHaveTextContent('MSFT'));

    expect(window.localStorage.getItem(userKey('user-a'))).toContain('MSFT');
    expect(window.localStorage.getItem(GUEST_KEY) ?? '').not.toContain('MSFT');
  });
});

describe('hydration flow (M1-T1, F-4.1b)', () => {
  it('ignores a stale in-flight load response after switching users', async () => {
    const loadA = deferred<Position[] | null>();
    const loadB = deferred<Position[] | null>();
    harness.loadPortfolio.mockImplementation((userId: string) =>
      userId === 'user-a' ? loadA.promise : loadB.promise,
    );

    await renderHarness();
    emitAuth({ user: { id: 'user-a' } });
    await waitFor(() => expect(getHydrationState().userId).toBe('user-a'));

    // Switch to B before A's load resolves.
    emitAuth({ user: { id: 'user-b' } });
    await waitFor(() => expect(getHydrationState().userId).toBe('user-b'));

    // A's response arrives late — it must be ignored entirely.
    await act(async () => {
      loadA.resolve([positionA]);
    });
    expect(screen.getByTestId('tickers').textContent).not.toContain('MSFT');
    expect(getHydrationState()).toEqual({ status: 'hydrating', userId: 'user-b' });

    await act(async () => {
      loadB.resolve([positionB]);
    });
    await waitFor(() => expect(screen.getByTestId('tickers')).toHaveTextContent('TSLA'));
    expect(screen.getByTestId('tickers').textContent).not.toContain('MSFT');
  });

  it('does not restart hydration for repeated same-user auth events', async () => {
    harness.loadPortfolio.mockResolvedValue(null);

    await renderHarness();
    emitAuth({ user: { id: 'user-a' } });
    await waitFor(() => expect(getHydrationState()).toEqual({ status: 'ready', userId: 'user-a' }));
    const callsAfterLogin = harness.loadPortfolio.mock.calls.length;

    emitAuth({ user: { id: 'user-a' } }); // e.g. TOKEN_REFRESHED
    expect(getHydrationState()).toEqual({ status: 'ready', userId: 'user-a' });
    expect(harness.loadPortfolio.mock.calls.length).toBe(callsAfterLogin);
  });
});

describe('Pro entitlement', () => {
  it('trusts only the user_subscriptions row, never session metadata', async () => {
    harness.loadIsPro.mockImplementation(async (userId: string) => userId === 'user-pro');
    await renderHarness();

    // Both metadata flags claim Pro; user_metadata is writable by the user themself.
    const selfGranted = {
      user: { id: 'user-a', app_metadata: { is_pro: true }, user_metadata: { is_pro: true } },
    };
    emitAuth(selfGranted);
    await waitFor(() => expect(harness.loadIsPro).toHaveBeenCalledWith('user-a'));
    await act(async () => {});
    expect(screen.getByTestId('tier')).toHaveTextContent('basic');

    emitAuth({ user: { id: 'user-pro' } });
    await waitFor(() => expect(screen.getByTestId('tier')).toHaveTextContent('pro'));

    fireEvent.click(screen.getByRole('button', { name: 'sign-out' }));
    await waitFor(() => expect(screen.getByTestId('tier')).toHaveTextContent('basic'));
  });
});
