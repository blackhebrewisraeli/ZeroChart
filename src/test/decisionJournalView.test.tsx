import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JournalPage } from '@/lib/db';
import type { JournalSignal } from '@/lib/decisionJournal';

const view = vi.hoisted(() => ({
  userId: 'user-a' as string | null,
  load: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ loadJournalPage: view.load }));
vi.mock('@/lib/portfolioStore', () => ({ usePortfolio: () => ({ scopeUserId: view.userId }) }));
vi.mock('@/lib/authStore', () => ({ isDevAuthUser: (id: string) => id === 'dev-stub' }));

import { DecisionJournal } from '@/components/DecisionJournal';

/** SYNTHETIC rows: one of each journal state. */
function signal(id: string, overrides: Partial<JournalSignal> = {}): JournalSignal {
  return {
    id,
    ticker: 'ZCTAUSDT',
    action: 'BUY',
    signal_kind: 'strategy',
    signal_score: 81,
    quantity: 0.99501247,
    stop_loss: 97.1094,
    price: 100,
    status: 'PENDING',
    event_id: `evt-${id}`,
    exchange: 'ZC_SYNTHETIC',
    timeframe: '1D',
    bar_time: '2026-10-27T00:00:00+00:00',
    model_version: '1.0.0-pw200',
    created_at: '2026-10-27T07:20:00+00:00',
    paper_transactions: [],
    ...overrides,
  };
}

const executed = signal('executed', {
  status: 'EXECUTED',
  paper_transactions: [
    {
      id: 'fill-1',
      action: 'BUY',
      ticker: 'ZCTA-USD',
      quantity: 0.99501247,
      price: 100.42,
      fees: 0.249805,
      created_at: '2026-10-27T07:22:05+00:00',
    },
  ],
});
const legacy = signal('legacy', {
  status: 'EXECUTED',
  signal_kind: null,
  exchange: null,
  timeframe: null,
  bar_time: null,
  model_version: null,
  price: null,
  event_id: null,
});

const page = (
  rows: JournalSignal[],
  next: JournalPage['next'] = null,
  total: number | null = null,
) => ({ rows, next, total }) satisfies JournalPage;

function renderJournal() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <DecisionJournal />
    </QueryClientProvider>,
  );
}

const entry = (ticker: string, state: string) =>
  screen
    .getAllByRole('listitem')
    .find((item) => item.textContent?.includes(ticker) && item.textContent.includes(state));

beforeEach(() => {
  view.userId = 'user-a';
  view.load.mockReset();
});
afterEach(cleanup);

describe('DecisionJournal', () => {
  it('lists each state with its provenance, timestamps and fill, and offers no trade action', async () => {
    view.load.mockResolvedValue(
      page(
        [signal('pending'), executed, signal('dismissed', { status: 'DISMISSED' }), legacy],
        null,
        4,
      ),
    );
    renderJournal();

    expect(screen.getByRole('status')).toHaveTextContent('Loading signal journal…');
    const list = await screen.findByRole('list', { name: 'Signals, newest first' });
    expect(within(list).getAllByRole('listitem', { hidden: false }).length).toBeGreaterThanOrEqual(
      4,
    );
    expect(view.load).toHaveBeenCalledWith('user-a', { ticker: '', status: null }, null);

    const summary = screen.getByText(/Showing 4 of 4 signals/).closest('p');
    expect(summary).toHaveTextContent('1 awaiting user action');
    expect(summary).toHaveTextContent('1 executed');
    expect(summary).toHaveTextContent('1 dismissed');
    expect(summary).toHaveTextContent('1 evidence inconsistent');
    expect(summary).toHaveTextContent('1 provenance incomplete');

    const fillItem = within(list).getByText('$100.00 → $100.42').closest('details');
    expect(fillItem).not.toBeNull();
    const details = within(fillItem as HTMLElement);
    expect(details.getByText('Signal-to-fill price change').nextSibling).toHaveTextContent(
      '+0.42% (fill above the signal price)',
    );
    expect(details.getByText('Receipt to booking').nextSibling).toHaveTextContent('2m 05s');
    expect(details.getByText('Recorded fee').nextSibling).toHaveTextContent('$0.2498');
    expect(details.getByText('Executed quantity').nextSibling).toHaveTextContent(
      '0.99501247 units',
    );
    expect(details.getByText('Booked as').nextSibling).toHaveTextContent('ZCTA-USD');
    expect(details.getByText('Provider event time').nextSibling).toHaveTextContent('Not recorded');
    expect(details.getByText('Historical risk checks').nextSibling).toHaveTextContent(
      'Not recorded',
    );
    expect(details.getByText(/isn.t execution slippage/)).toBeInTheDocument();

    const legacyItem = entry('ZCTAUSDT', 'Kind not recorded');
    expect(legacyItem).toBeDefined();
    const legacyDetails = within(legacyItem as HTMLElement);
    expect(legacyDetails.getByText('Evidence inconsistent')).toBeInTheDocument();
    expect(legacyDetails.getByText('Provenance incomplete')).toBeInTheDocument();
    expect(legacyDetails.getByText(/no fill is linked to it/)).toBeInTheDocument();
    expect(legacyDetails.getByText('Exchange').nextSibling).toHaveTextContent('Not recorded');
    expect(legacyDetails.getByText('Bar time (bar open)').nextSibling).toHaveTextContent(
      'Not recorded',
    );
    expect(legacyDetails.getByText('Signal price').nextSibling).toHaveTextContent('Not recorded');

    const pendingItem = screen
      .getByText('Awaiting user action', { selector: 'summary *' })
      .closest('details');
    expect(
      within(pendingItem as HTMLElement).getByText('Current eligibility').nextSibling,
    ).toHaveTextContent('Checked when you review it in the Action Center');

    const buttons = screen.getAllByRole('button').map((button) => button.textContent);
    expect(buttons).toEqual([' Refresh']);
    expect(screen.queryByText(/reject/i)).toBeNull();
  });

  it('shows an error and no entries when the read fails, then recovers on Retry', async () => {
    view.load.mockRejectedValue(new Error('Failed to fetch'));
    renderJournal();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load the signal journal: Failed to fetch");
    expect(alert).toHaveTextContent('no outcome is guessed');
    expect(screen.queryByRole('list')).toBeNull();
    expect(view.load).toHaveBeenCalledTimes(1);

    view.load.mockResolvedValue(page([executed]));
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('$100.00 → $100.42')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('distinguishes an empty journal from filters that match nothing, filtering on the server', async () => {
    view.load.mockResolvedValue(page([], null, 0));
    renderJournal();
    expect(await screen.findByText('No signals recorded yet')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by recorded status' }), {
      target: { value: 'DISMISSED' },
    });
    expect(await screen.findByText('No signals match these filters')).toBeInTheDocument();
    expect(view.load).toHaveBeenLastCalledWith('user-a', { ticker: '', status: 'DISMISSED' }, null);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter by asset' }), {
      target: { value: 'btc%' },
    });
    await waitFor(() =>
      expect(view.load).toHaveBeenLastCalledWith(
        'user-a',
        { ticker: 'BTC', status: 'DISMISSED' },
        null,
      ),
    );
  });

  it('loads older signals after the cursor and stops at the last page', async () => {
    const cursor = { createdAt: '2026-10-27T07:20:00+00:00', id: 'pending' };
    view.load
      .mockResolvedValueOnce(page([signal('pending')], cursor, 2))
      .mockResolvedValueOnce(page([signal('older', { status: 'DISMISSED', ticker: 'ZCTBUSDT' })]));
    renderJournal();

    fireEvent.click(await screen.findByRole('button', { name: 'Load older signals' }));
    expect(await screen.findByText('ZCTBUSDT')).toBeInTheDocument();
    expect(view.load).toHaveBeenLastCalledWith('user-a', { ticker: '', status: null }, cursor);
    expect(screen.getByText(/Showing 2 of 2 signals/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load older signals' })).toBeNull();
  });

  it.each([
    ['signed out', null],
    ['the ?devAuth stub', 'dev-stub'],
  ])('reads nothing when %s', async (_label, userId) => {
    view.userId = userId;
    renderJournal();
    expect(screen.getByText('Sign in to see your signal journal')).toBeInTheDocument();
    expect(view.load).not.toHaveBeenCalled();
  });
});
