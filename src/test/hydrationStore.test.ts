import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Position } from '@/lib/portfolioManager';

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

import {
  beginHydration,
  completeHydration,
  getHydrationState,
  isCloudWriteAllowed,
  resetHydration,
} from '@/lib/hydrationStore';
import { PortfolioNotHydratedError, savePortfolio } from '@/lib/db';

const positions: Position[] = [
  {
    id: 'a',
    ticker: 'AAPL',
    buyPrice: 100,
    shares: 2,
    isSimulation: true,
    dateAdded: '2026-01-01',
  },
];

function setupChain() {
  dbMocks.from.mockReturnValue({ upsert: dbMocks.upsert, select: dbMocks.select });
  dbMocks.select.mockReturnValue({ eq: dbMocks.eq });
  dbMocks.eq.mockReturnValue({ maybeSingle: dbMocks.maybeSingle });
}

beforeEach(() => {
  resetHydration();
  dbMocks.from.mockReset();
  dbMocks.upsert.mockReset();
  dbMocks.select.mockReset();
  dbMocks.eq.mockReset();
  dbMocks.maybeSingle.mockReset();
  setupChain();
});

describe('hydration barrier state machine (M1-T1, F-4.1b)', () => {
  it('starts idle and permissive (guest / legacy / unit-test path)', () => {
    expect(getHydrationState()).toEqual({ status: 'idle', userId: null });
    expect(isCloudWriteAllowed('user-1')).toBe(true);
  });

  it('blocks cloud writes for the hydrating user until the attempt settles', () => {
    beginHydration('user-1');
    expect(getHydrationState()).toEqual({ status: 'hydrating', userId: 'user-1' });
    expect(isCloudWriteAllowed('user-1')).toBe(false);

    completeHydration('user-1', 'ready');
    expect(getHydrationState()).toEqual({ status: 'ready', userId: 'user-1' });
    expect(isCloudWriteAllowed('user-1')).toBe(true);
  });

  it('treats a failed hydration as settled so offline saves are not bricked', () => {
    beginHydration('user-1');
    completeHydration('user-1', 'error');
    expect(getHydrationState()).toEqual({ status: 'error', userId: 'user-1' });
    expect(isCloudWriteAllowed('user-1')).toBe(true);
  });

  it('blocks writes for a different user while a hydration is active or settled', () => {
    beginHydration('user-1');
    expect(isCloudWriteAllowed('user-2')).toBe(false);
    completeHydration('user-1', 'ready');
    expect(isCloudWriteAllowed('user-2')).toBe(false); // hydrated for someone else
  });

  it('ignores stale completions from a user that is no longer active', () => {
    beginHydration('user-2');
    completeHydration('user-1', 'ready'); // stale — must not flip the barrier
    expect(getHydrationState()).toEqual({ status: 'hydrating', userId: 'user-2' });
    expect(isCloudWriteAllowed('user-2')).toBe(false);
  });

  it('returns to the permissive idle state on reset (sign-out)', () => {
    beginHydration('user-1');
    resetHydration();
    expect(getHydrationState()).toEqual({ status: 'idle', userId: null });
    expect(isCloudWriteAllowed('user-1')).toBe(true);
  });
});

describe('savePortfolio hydration guard (M1-T1, F-4.1b)', () => {
  it('saves normally when no hydration has engaged (legacy/test path)', async () => {
    dbMocks.upsert.mockResolvedValue({ error: null });

    await expect(savePortfolio('user-1', positions)).resolves.toBeUndefined();
    expect(dbMocks.from).toHaveBeenCalledWith('user_portfolios');
    expect(dbMocks.upsert).toHaveBeenCalledTimes(1);
  });

  it('rejects with PortfolioNotHydratedError while the user is hydrating', async () => {
    beginHydration('user-1');

    await expect(savePortfolio('user-1', positions)).rejects.toBeInstanceOf(
      PortfolioNotHydratedError,
    );
    expect(dbMocks.upsert).not.toHaveBeenCalled();
  });

  it('saves once hydration settles for that exact user', async () => {
    dbMocks.upsert.mockResolvedValue({ error: null });
    beginHydration('user-1');
    completeHydration('user-1', 'ready');

    await expect(savePortfolio('user-1', positions)).resolves.toBeUndefined();
    expect(dbMocks.upsert).toHaveBeenCalledTimes(1);
  });
});
