import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset } from '@/lib/assets';
import type { Position } from '@/lib/portfolioManager';

const database = vi.hoisted(() => ({
  from: vi.fn(),
  insert: vi.fn(),
  maybeSingle: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('@/lib/supabaseClient', () => ({
  supabase: { from: database.from, rpc: database.rpc },
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: React.ComponentProps<'a'> & { to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('recharts', () => ({
  Cell: () => null,
  Pie: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  PieChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Tooltip: () => null,
}));

import { SharedPortfolioView } from '@/components/SharedPortfolioView';
import {
  buildSharedPortfolioSnapshot,
  fetchSharedPortfolio,
  publishSharedPortfolio,
  type SharedPortfolioRecord,
} from '@/lib/sharedPortfolio';

function makeAsset(overrides: Partial<Asset> & Pick<Asset, 'ticker'>): Asset {
  return {
    ticker: overrides.ticker,
    name: overrides.name ?? overrides.ticker,
    current_price: overrides.current_price ?? 120,
    stable_signal: null,
    radar_signal: null,
    stable_explanation: null,
    radar_explanation: null,
    risk_pct: overrides.risk_pct ?? 0.02,
    reward_pct: null,
    volume_spike: null,
    rsi_14: overrides.rsi_14 ?? 35,
    sma_50: null,
    sma_200: null,
    change_24h: overrides.change_24h ?? 0.01,
    updated_at: null,
  };
}

function makePosition(overrides: Partial<Position> & Pick<Position, 'id' | 'ticker'>): Position {
  return {
    id: overrides.id,
    ticker: overrides.ticker,
    buyPrice: overrides.buyPrice ?? 100,
    shares: overrides.shares ?? 1,
    isSimulation: overrides.isSimulation ?? true,
    dateAdded: overrides.dateAdded ?? '2026-01-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  database.from.mockReturnValue({ insert: database.insert });
  database.rpc.mockReturnValue({ maybeSingle: database.maybeSingle });
});

afterEach(cleanup);

describe('shared portfolio snapshots', () => {
  it('aggregates a privacy-minimized public snapshot with quant scores', () => {
    const positions = [
      makePosition({ id: 'btc-1', ticker: 'BTC', buyPrice: 100, shares: 1 }),
      makePosition({ id: 'btc-2', ticker: 'BTC', buyPrice: 80, shares: 1 }),
    ];
    const assets = [makeAsset({ ticker: 'BTC', name: 'Bitcoin', current_price: 120 })];

    const snapshot = buildSharedPortfolioSnapshot(positions, assets, '2026-10-18T00:00:00.000Z');

    expect(snapshot.totalValue).toBe(240);
    expect(snapshot.totalInvested).toBe(180);
    expect(snapshot.unrealizedPnL).toBe(60);
    expect(snapshot.holdings).toHaveLength(1);
    expect(snapshot.holdings[0]).toEqual(
      expect.objectContaining({ ticker: 'BTC', name: 'Bitcoin', allocationPercent: 100 }),
    );
    expect(snapshot.quantScore).toBeGreaterThanOrEqual(0);
    expect(snapshot.quantScore).toBeLessThanOrEqual(100);

    const publicJson = JSON.stringify(snapshot);
    expect(publicJson).not.toContain('shares');
    expect(publicJson).not.toContain('buyPrice');
    expect(publicJson).not.toContain('userId');
  });

  it('publishes through the authenticated insert contract', async () => {
    database.insert.mockResolvedValue({ error: null });
    const snapshot = buildSharedPortfolioSnapshot([], [], '2026-10-18T00:00:00.000Z');

    await publishSharedPortfolio({ id: 'share-id', userId: 'user-a', snapshot });

    expect(database.from).toHaveBeenCalledWith('shared_portfolios');
    expect(database.insert).toHaveBeenCalledWith({
      id: 'share-id',
      user_id: 'user-a',
      snapshot,
    });
  });

  it('reads one snapshot by id through the RPC and validates it', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const snapshot = buildSharedPortfolioSnapshot([], [], '2026-10-18T00:00:00.000Z');
    database.maybeSingle.mockResolvedValue({
      data: { id, snapshot, created_at: snapshot.createdAt },
      error: null,
    });

    await expect(fetchSharedPortfolio(id)).resolves.toEqual({
      id,
      snapshot,
      createdAt: snapshot.createdAt,
    });
    expect(database.rpc).toHaveBeenCalledWith('get_shared_portfolio', { share_id: id });
    expect(database.from).not.toHaveBeenCalled();
  });

  it('skips the request for ids that are not UUIDs', async () => {
    await expect(fetchSharedPortfolio('not-a-uuid')).resolves.toBeNull();
    expect(database.rpc).not.toHaveBeenCalled();
  });
});

describe('public portfolio view', () => {
  it('shows portfolio essentials and never renders trading or credential controls', () => {
    const snapshot = buildSharedPortfolioSnapshot(
      [makePosition({ id: 'btc', ticker: 'BTC', buyPrice: 100, shares: 2 })],
      [makeAsset({ ticker: 'BTC', name: 'Bitcoin', current_price: 120 })],
      '2026-10-18T00:00:00.000Z',
    );
    const record: SharedPortfolioRecord = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      createdAt: snapshot.createdAt,
      snapshot,
    };

    render(<SharedPortfolioView record={record} />);

    expect(screen.getByRole('heading', { name: 'Quant Portfolio Snapshot' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Asset allocation' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Robo-Advisor scores' })).toBeVisible();
    expect(
      screen.getAllByRole('link', {
        name: /Built with ZeroChart - Create your own Quant Portfolio/i,
      }),
    ).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /trade/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/api key/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/deposit|withdraw/i)).not.toBeInTheDocument();
  });
});
