import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Position } from '@/lib/portfolioManager';

const harness = vi.hoisted(() => ({
  authCallbacks: [] as Array<(event: string, session: unknown) => void>,
  getSession: vi.fn(),
  loadPortfolio: vi.fn(),
  savePortfolioStateV3: vi.fn(),
}));

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: harness.getSession,
      onAuthStateChange: (callback: (event: string, session: unknown) => void) => {
        harness.authCallbacks.push(callback);
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
      signOut: vi.fn(),
    },
  },
}));

vi.mock('@/lib/db', () => ({
  loadPortfolio: harness.loadPortfolio,
  savePortfolioStateV3: harness.savePortfolioStateV3,
  PortfolioNotHydratedError: class PortfolioNotHydratedError extends Error {},
}));

// Keep the render hermetic: this test covers the Save-to-Cloud gate, not charts.
vi.mock('@/components/AllocationChart', () => ({ AllocationChart: () => null }));
vi.mock('@/components/BacktestChart', () => ({ BacktestChart: () => null }));
vi.mock('@/components/PriceAlerts', () => ({ PriceAlerts: () => null }));
vi.mock('@/components/TradeTicket', () => ({ TradeTicket: () => null }));
vi.mock('@/components/AuthModal', () => ({ AuthModal: () => null }));

import { resetHydration } from '@/lib/hydrationStore';
import { AuthProvider } from '@/lib/authStore';
import { PortfolioProvider } from '@/lib/portfolioStore';
import { PortfolioDashboard } from '@/components/PortfolioDashboard';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  resetHydration();
  harness.authCallbacks.length = 0;
  harness.getSession.mockResolvedValue({ data: { session: { user: { id: 'user-a' } } } });
});

afterEach(cleanup);

describe('Save to Cloud hydration gate (M1-T1, F-4.1b)', () => {
  it('disables the save button until hydration settles, then saves', async () => {
    const load = deferred<Position[] | null>();
    harness.loadPortfolio.mockReturnValue(load.promise);
    harness.savePortfolioStateV3.mockResolvedValue(undefined);

    render(
      <PortfolioProvider>
        <AuthProvider>
          <PortfolioDashboard assets={[]} />
        </AuthProvider>
      </PortfolioProvider>,
    );

    const saveButton = screen.getByRole('button', { name: /save to cloud/i });

    // Hydration in flight: the button is disabled and the write is impossible.
    await waitFor(() => expect(saveButton).toBeDisabled());
    fireEvent.click(saveButton);
    expect(harness.savePortfolioStateV3).not.toHaveBeenCalled();

    // Cloud row resolves as an explicit empty portfolio — hydration settles.
    await act(async () => {
      load.resolve([]);
    });
    await waitFor(() => expect(saveButton).toBeEnabled());

    fireEvent.click(saveButton);
    await waitFor(() =>
      expect(harness.savePortfolioStateV3).toHaveBeenCalledWith(
        'user-a',
        expect.objectContaining({
          version: 3,
          portfolios: expect.objectContaining({
            paper_trading: expect.objectContaining({ cashBalance: 10_000 }),
          }),
        }),
      ),
    );
  });
});
