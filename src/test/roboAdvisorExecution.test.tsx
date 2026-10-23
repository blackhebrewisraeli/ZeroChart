import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RoboAdvisor } from '@/components/RoboAdvisor';
import type { Asset } from '@/lib/assets';
import {
  executePaperPortfolio,
  loadPaperTransactions,
  PortfolioChangedError,
  PortfolioRejectedError,
  type PortfolioReceipt,
} from '@/lib/db';

const store = vi.hoisted(() => ({
  replacePaperLedger: vi.fn(),
  executePaperTrade: vi.fn(),
}));

vi.mock('@/lib/authStore', () => ({ useAuth: () => ({ isPro: true }) }));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/lib/portfolioStore', () => ({
  usePortfolio: () => ({
    ...store,
    scopeUserId: 'user-1',
    getPortfolio: () => ({ cashBalance: 100_000, positions: [], transactions: [] }),
  }),
}));
vi.mock('@/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db')>()),
  executePaperPortfolio: vi.fn(),
  loadPaperTransactions: vi.fn(async () => []),
}));
vi.mock('@/lib/roboAdvisor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/roboAdvisor')>()),
  buildQuantPortfolio: vi.fn(async () => [
    { ticker: 'BTC', weight: 0.25, allocatedAmount: 2500, score: 82, suggestedShares: 0.05 },
    { ticker: 'ETH', weight: 0.25, allocatedAmount: 2500, score: 75, suggestedShares: 1 },
  ]),
}));

const execute = vi.mocked(executePaperPortfolio);
const assets = [
  { ticker: 'BTC', name: 'Bitcoin', current_price: 50_000 },
  { ticker: 'ETH', name: 'Ethereum', current_price: 2500 },
] as Asset[];

function receipt(status: PortfolioReceipt['status'], requestId: string): PortfolioReceipt {
  return {
    request_id: requestId,
    status,
    replayed: false,
    policy_version: 'paper-risk-v1',
    risk_profile: 'moderate',
    budget: 10_000,
    cash_before: 100_000,
    spent: 4999.99,
    fees: 12.47,
    cash_after: 95_000.01,
    equity: 100_000,
    open_risk_before: 0,
    planned_risk: 199.5,
    max_open_risk: 6000,
    orders: [
      {
        ticker: 'BTC',
        quantity: 0.04987531,
        price: 50_000,
        fees: 6.23,
        cost: 2499.99,
        stop_price: 48_000,
        atr: 1000,
        planned_risk: 99.75,
      },
      {
        ticker: 'ETH',
        quantity: 0.99750623,
        price: 2500,
        fees: 6.23,
        cost: 2499.99,
        stop_price: 2400,
        atr: 50,
        planned_risk: 99.75,
      },
    ],
    executed_at: status === 'executed' ? '2026-10-22T15:00:00Z' : null,
  };
}

/** The request IDs of the calls that could book (not dry runs). */
const bookingCalls = () =>
  execute.mock.calls.filter(([proposal]) => !proposal.dryRun).map(([p]) => p.requestId);

async function openProposal() {
  render(<RoboAdvisor assets={assets} />);
  return buildProposal();
}

async function buildProposal() {
  fireEvent.click(screen.getByRole('button', { name: /build portfolio/i }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: /build portfolio/i }));
  await screen.findByText('Cash after');
  return screen.getByRole('button', { name: /simulate on paper desk/i });
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.info).mockClear();
  execute.mockReset();
  store.replacePaperLedger.mockReset();
  vi.mocked(loadPaperTransactions).mockClear();
});

describe('RoboAdvisor execution, signed in', () => {
  it('shows the server plan and books it once, under the plan request ID', async () => {
    let book: (value: PortfolioReceipt) => void = () => {};
    execute.mockImplementation((proposal) =>
      proposal.dryRun
        ? Promise.resolve(receipt('planned', proposal.requestId))
        : new Promise((resolve) => {
            book = resolve;
          }),
    );

    const confirm = await openProposal();
    const preview = execute.mock.calls[0]?.[0];
    expect(preview).toMatchObject({
      dryRun: true,
      riskProfile: 'moderate',
      budget: 10_000,
      holdings: [
        { ticker: 'BTC', amount: 2500, score: 82 },
        { ticker: 'ETH', amount: 2500, score: 75 },
      ],
    });
    // Rows show the units the server will book, not the browser's 0.05 estimate.
    const sizes = screen.getAllByTitle(/Suggested position size/);
    expect(sizes[0]).toHaveTextContent('0.0499 shares');
    expect(sizes[1]).toHaveTextContent('0.9975 shares');
    expect(screen.getByRole('rowheader', { name: 'BTC' })).toBeVisible();
    expect(screen.getByText('$95,000.01')).toBeVisible();

    // Two clicks before React re-renders: the button is still enabled for both.
    act(() => {
      confirm.click();
      confirm.click();
    });
    expect(await screen.findByRole('button', { name: /booking orders/i })).toBeDisabled();
    expect(bookingCalls()).toEqual([preview?.requestId]);
    // Escape can't close the dialog while the booking is out (closing takes 300 ms).
    fireEvent.keyDown(window, { key: 'Escape' });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(screen.getByRole('dialog')).toBeVisible();

    book(receipt('executed', preview?.requestId ?? ''));
    expect(await screen.findByText(/Booked 2 orders in one transaction/)).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Receipt' })).toBeVisible();
    // The ledger is replayed from the server, not from the client's guess.
    await waitFor(() => expect(store.replacePaperLedger).toHaveBeenCalledWith([]));
    expect(loadPaperTransactions).toHaveBeenCalledWith('user-1');
    expect(screen.queryByRole('button', { name: /simulate on paper desk/i })).toBeNull();
  });

  it('shows why the server refused and leaves Confirm available', async () => {
    execute.mockImplementation((proposal) =>
      proposal.dryRun
        ? Promise.resolve(receipt('planned', proposal.requestId))
        : Promise.reject(
            new PortfolioRejectedError(
              'Portfolio max risk reached: 5.8% open + 0.3% new would pass the 6% limit. Lower the amount.',
            ),
          ),
    );

    fireEvent.click(await openProposal());

    expect(
      await screen.findByText(/Not booked: Portfolio max risk reached: 5.8% open/),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: /simulate on paper desk/i })).toBeEnabled();
    expect(store.replacePaperLedger).not.toHaveBeenCalled();
  });

  it('blocks Confirm when the server cannot price the proposal', async () => {
    execute.mockRejectedValue(
      new PortfolioRejectedError(
        "ETH has no current ATR(14) reading, so its risk can't be sized. Try again after the daily market analytics run.",
      ),
    );

    render(<RoboAdvisor assets={assets} />);
    fireEvent.click(screen.getByRole('button', { name: /build portfolio/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /build portfolio/i }));

    expect(
      await screen.findByText(/Can't book this proposal: ETH has no current ATR\(14\) reading/),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: /simulate on paper desk/i })).toBeDisabled();
  });

  it('reconciles a lost response by request ID instead of booking again', async () => {
    let attempts = 0;
    execute.mockImplementation((proposal) => {
      if (!proposal.dryRun) {
        attempts += 1;
        return Promise.reject(new Error('Failed to fetch'));
      }
      // Once the booking was attempted, the server reports it as executed.
      return Promise.resolve({
        ...receipt(attempts > 0 ? 'executed' : 'planned', proposal.requestId),
        replayed: attempts > 0,
      });
    });

    fireEvent.click(await openProposal());

    expect(await screen.findByText(/Booked 2 orders in one transaction/)).toBeVisible();
    const ids = new Set(execute.mock.calls.map(([proposal]) => proposal.requestId));
    expect(ids.size).toBe(1);
    expect(bookingCalls()).toHaveLength(1);
    await waitFor(() => expect(store.replacePaperLedger).toHaveBeenCalled());
  });

  it('says nothing was booked when the server has no record, and retries under the same ID', async () => {
    let failNext = true;
    execute.mockImplementation((proposal) => {
      if (proposal.dryRun) return Promise.resolve(receipt('planned', proposal.requestId));
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error('Failed to fetch'));
      }
      return Promise.resolve(receipt('executed', proposal.requestId));
    });

    fireEvent.click(await openProposal());
    expect(await screen.findByText(/The server has no record of this request/)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /simulate on paper desk/i }));
    expect(await screen.findByText(/Booked 2 orders in one transaction/)).toBeVisible();
    const [first, second] = bookingCalls();
    expect(second).toBe(first);
  });

  it('keeps checking while the outcome is unknown', async () => {
    execute.mockImplementation((proposal) =>
      proposal.dryRun && execute.mock.calls.filter(([p]) => !p.dryRun).length === 0
        ? Promise.resolve(receipt('planned', proposal.requestId))
        : Promise.reject(new Error('Failed to fetch')),
    );

    fireEvent.click(await openProposal());

    expect(
      await screen.findByText(/Couldn't reach the server to check whether this request was booked/),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: /simulate on paper desk/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /check again/i })).toBeEnabled();
    expect(bookingCalls()).toHaveLength(1);
  });

  it('books the previewed orders, or shows the repriced plan for a fresh Confirm when they moved', async () => {
    let previews = 0;
    execute.mockImplementation((proposal) => {
      if (proposal.dryRun) {
        previews += 1;
        const plan = receipt('planned', proposal.requestId);
        // Priced again after the refusal, BTC is 1% higher.
        if (previews > 1) {
          plan.orders = plan.orders.map((order) =>
            order.ticker === 'BTC' ? { ...order, price: 50_500 } : order,
          );
        }
        return Promise.resolve(plan);
      }
      return bookingCalls().length === 1
        ? Promise.reject(
            new PortfolioChangedError(
              'Prices or sizes moved more than 0.5% since the preview. Review the updated orders and confirm again.',
            ),
          )
        : Promise.resolve(receipt('executed', proposal.requestId));
    });

    fireEvent.click(await openProposal());

    expect(
      await screen.findByText(/Not booked: Prices or sizes moved more than 0.5%/),
    ).toBeVisible();
    expect(await screen.findByText('$50,500.00')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /simulate on paper desk/i }));
    expect(await screen.findByText(/Booked 2 orders in one transaction/)).toBeVisible();

    const bookings = execute.mock.calls.map(([p]) => p).filter((p) => !p.dryRun);
    // Each Confirm sends the plan on screen, under the proposal's one request ID.
    expect(bookings.map((p) => p.expected?.[0])).toEqual([
      { ticker: 'BTC', price: 50_000, quantity: 0.04987531 },
      { ticker: 'BTC', price: 50_500, quantity: 0.04987531 },
    ]);
    expect(bookings[1]?.requestId).toBe(bookings[0]?.requestId);
  });

  it('recovers a lost booking by its request ID after the page reloads', async () => {
    execute.mockImplementation((proposal) =>
      proposal.dryRun && bookingCalls().length === 0
        ? Promise.resolve(receipt('planned', proposal.requestId))
        : Promise.reject(new Error('Failed to fetch')),
    );
    fireEvent.click(await openProposal());
    expect(await screen.findByText(/Couldn't reach the server to check/)).toBeVisible();
    const [lost] = bookingCalls();

    // The page reloads, and the server is reachable again: the booking had committed.
    cleanup();
    execute.mockReset();
    execute.mockImplementation((proposal) =>
      Promise.resolve({ ...receipt('executed', proposal.requestId), replayed: true }),
    );
    render(<RoboAdvisor assets={assets} />);

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Your earlier Quant Analyzer request booked 2 orders',
        { description: `Receipt ${lost?.slice(0, 8)}: $4,999.99 spent from Paper Cash.` },
      ),
    );
    expect(execute.mock.calls.map(([p]) => [p.requestId, p.dryRun])).toEqual([[lost, true]]);
    await waitFor(() => expect(store.replacePaperLedger).toHaveBeenCalled());
    expect(localStorage.length).toBe(0);
  });

  it('settles a lost booking when the dialog is closed and reopened', async () => {
    execute.mockImplementation((proposal) =>
      proposal.dryRun && bookingCalls().length === 0
        ? Promise.resolve(receipt('planned', proposal.requestId))
        : Promise.reject(new Error('Failed to fetch')),
    );
    fireEvent.click(await openProposal());
    expect(await screen.findByText(/Couldn't reach the server to check/)).toBeVisible();
    const [lost] = bookingCalls();

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Back online, and the booking never reached the server.
    execute.mockImplementation((proposal) =>
      Promise.resolve(receipt('planned', proposal.requestId)),
    );
    fireEvent.click(screen.getByRole('button', { name: /build portfolio/i }));

    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        'An earlier Quant Analyzer request was not booked',
        expect.anything(),
      ),
    );
    expect(execute.mock.calls.some(([p]) => p.requestId === lost && p.dryRun)).toBe(true);
    expect(bookingCalls()).toEqual([lost]);
    expect(localStorage.length).toBe(0);
  });
});
