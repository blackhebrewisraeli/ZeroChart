import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Position } from '@/lib/portfolioManager';
import type { PortfolioStateV3 } from '@/lib/portfolioStore';

const dbMocks = vi.hoisted(() => {
  const from = vi.fn();
  const upsert = vi.fn();
  const select = vi.fn();
  const eq = vi.fn();
  const maybeSingle = vi.fn();
  return { from, upsert, select, eq, maybeSingle };
});

vi.mock('@/lib/supabaseClient', () => ({
  supabase: { from: dbMocks.from },
}));

import { loadPortfolio, loadPortfolioState, savePortfolio, savePortfolioStateV3 } from '@/lib/db';

const positions: Position[] = [
  {
    id: 'a',
    ticker: 'AAPL',
    buyPrice: 100,
    shares: 2,
    isSimulation: true,
    dateAdded: '2026-01-01',
  },
  {
    id: 'b',
    ticker: 'BTC-USD',
    buyPrice: 60000,
    shares: 0.1,
    isSimulation: true,
    dateAdded: '2026-01-02',
  },
];

const stateV3: PortfolioStateV3 = {
  version: 3,
  activePortfolioType: 'long_term_sim',
  portfolios: {
    real_tracking: {
      type: 'real_tracking',
      positions: [],
      cashBalance: 500,
      cashLedger: [],
      transactions: [],
      realizedPnl: 0,
    },
    long_term_sim: {
      type: 'long_term_sim',
      positions: [],
      cashBalance: 0,
      cashLedger: [],
      transactions: [],
      realizedPnl: 0,
    },
    paper_trading: {
      type: 'paper_trading',
      positions,
      cashBalance: 9_000,
      cashLedger: [],
      transactions: [],
      realizedPnl: 25,
    },
  },
};

function setupChain() {
  dbMocks.from.mockReturnValue({ upsert: dbMocks.upsert, select: dbMocks.select });
  dbMocks.select.mockReturnValue({ eq: dbMocks.eq });
  dbMocks.eq.mockReturnValue({ maybeSingle: dbMocks.maybeSingle });
}

beforeEach(() => {
  dbMocks.from.mockReset();
  dbMocks.upsert.mockReset();
  dbMocks.select.mockReset();
  dbMocks.eq.mockReset();
  dbMocks.maybeSingle.mockReset();
  setupChain();
});

describe('savePortfolio', () => {
  it('upserts the portfolio row keyed by user id', async () => {
    dbMocks.upsert.mockResolvedValue({ error: null });

    await savePortfolio('user-1', positions);

    expect(dbMocks.from).toHaveBeenCalledWith('user_portfolios');
    expect(dbMocks.upsert).toHaveBeenCalledTimes(1);
    expect(dbMocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'user-1', positions }),
      { onConflict: 'user_id' },
    );
  });

  it('throws when the upsert fails', async () => {
    dbMocks.upsert.mockResolvedValue({ error: { message: 'boom' } });

    await expect(savePortfolio('user-1', positions)).rejects.toEqual({ message: 'boom' });
  });

  it('persists a v3 multi-portfolio envelope without changing the legacy array API', async () => {
    dbMocks.upsert.mockResolvedValue({ error: null });

    await savePortfolioStateV3('user-1', stateV3);

    expect(dbMocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'user-1', positions: stateV3 }),
      { onConflict: 'user_id' },
    );
  });
});

describe('loadPortfolio', () => {
  it('returns the saved positions when a row exists', async () => {
    dbMocks.maybeSingle.mockResolvedValue({ data: { positions }, error: null });

    await expect(loadPortfolio('user-1')).resolves.toEqual(positions);
    expect(dbMocks.from).toHaveBeenCalledWith('user_portfolios');
    expect(dbMocks.select).toHaveBeenCalledWith('positions');
    expect(dbMocks.eq).toHaveBeenCalledWith('user_id', 'user-1');
  });

  it('returns null when no row exists', async () => {
    dbMocks.maybeSingle.mockResolvedValue({ data: null, error: null });

    await expect(loadPortfolio('user-1')).resolves.toBeNull();
  });

  it('throws when the fetch fails', async () => {
    dbMocks.maybeSingle.mockResolvedValue({ data: null, error: { message: 'boom' } });

    await expect(loadPortfolio('user-1')).rejects.toEqual({ message: 'boom' });
  });

  it('loads either a legacy array or a v3 envelope through the state API', async () => {
    dbMocks.maybeSingle.mockResolvedValue({ data: { positions: stateV3 }, error: null });

    await expect(loadPortfolio('user-1')).resolves.toEqual(stateV3);
    await expect(loadPortfolioState('user-1')).resolves.toEqual(stateV3);
  });
});
