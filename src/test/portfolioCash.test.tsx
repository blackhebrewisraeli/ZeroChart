import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PortfolioProvider, usePortfolio } from '@/lib/portfolioStore';

let store: ReturnType<typeof usePortfolio>;

function Probe() {
  store = usePortfolio();
  return (
    <div>
      <span data-testid="cash">{store.cashBalance.toFixed(2)}</span>
      <span data-testid="ledger">{store.cashLedger.length}</span>
    </div>
  );
}

function renderStore() {
  return render(
    <PortfolioProvider>
      <Probe />
    </PortfolioProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(cleanup);

describe('cash ledger (M1-T3, F-1.3a)', () => {
  it('seeds demo opening cash as a ledger entry, not a UI constant', () => {
    renderStore();

    expect(screen.getByTestId('cash')).toHaveTextContent('2500.00');
    expect(screen.getByTestId('ledger')).toHaveTextContent('1');
    expect(store.cashLedger[0]).toMatchObject({ type: 'deposit', amount: 2500 });
  });

  it('applies deposits and withdrawals to balance and ledger', () => {
    renderStore();

    act(() => {
      expect(store.depositCash(500)).toBe(true);
    });
    expect(screen.getByTestId('cash')).toHaveTextContent('3000.00');

    act(() => {
      expect(store.withdrawCash(1000)).toBe(true);
    });
    expect(screen.getByTestId('cash')).toHaveTextContent('2000.00');
    expect(screen.getByTestId('ledger')).toHaveTextContent('3');
    expect(store.cashLedger.map((transaction) => transaction.type)).toEqual([
      'deposit',
      'deposit',
      'withdrawal',
    ]);
  });

  it('rejects invalid amounts and overdrafts without mutating state', () => {
    renderStore();

    act(() => {
      expect(store.depositCash(0)).toBe(false);
      expect(store.depositCash(-5)).toBe(false);
      expect(store.depositCash(Number.NaN)).toBe(false);
      expect(store.withdrawCash(2500.01)).toBe(false);
    });
    expect(screen.getByTestId('cash')).toHaveTextContent('2500.00');
    expect(screen.getByTestId('ledger')).toHaveTextContent('1');

    // Withdrawing exactly the balance is allowed (no overdraft).
    act(() => {
      expect(store.withdrawCash(2500)).toBe(true);
    });
    expect(screen.getByTestId('cash')).toHaveTextContent('0.00');
  });

  it('persists the v2 scope payload and restores cash across scope switches', async () => {
    renderStore();

    act(() => {
      store.depositCash(500); // guest: 3000
    });
    act(() => {
      store.switchScope('user-a');
    });
    act(() => {
      store.switchScope(null); // back to guest
    });

    await waitFor(() => expect(screen.getByTestId('cash')).toHaveTextContent('3000.00'));
    const raw = window.localStorage.getItem('zerochart:portfolio-positions');
    expect(raw).toContain('"version":2');
    expect(raw).toContain('"cashBalance":3000');
  });

  it('keeps cash isolated per account scope', () => {
    renderStore();

    act(() => {
      store.depositCash(500); // guest: 3000
    });
    act(() => {
      store.switchScope('user-a');
    });
    expect(screen.getByTestId('cash')).toHaveTextContent('2500.00'); // A's own seed

    act(() => {
      store.switchScope('user-b');
    });
    expect(screen.getByTestId('cash')).toHaveTextContent('2500.00'); // B's own seed

    act(() => {
      store.switchScope(null);
    });
    expect(screen.getByTestId('cash')).toHaveTextContent('3000.00'); // guest unchanged
  });

  it('migrates legacy v1 payloads: positions kept, cash seeded', () => {
    window.localStorage.setItem(
      'zerochart:portfolio-positions',
      JSON.stringify([
        {
          id: 'legacy',
          ticker: 'MSFT',
          buyPrice: 100,
          shares: 2,
          isSimulation: false,
          dateAdded: '2026-01-01',
        },
      ]),
    );

    renderStore();

    expect(store.positions.map((position) => position.ticker)).toEqual(['MSFT']);
    expect(screen.getByTestId('cash')).toHaveTextContent('2500.00');
    expect(store.cashLedger).toHaveLength(1);
  });
});
