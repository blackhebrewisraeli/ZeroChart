import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  eq: vi.fn(),
  order: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  response: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: (columns: string) => {
        mocks.select(columns);
        return {
          eq: (column: string, value: string) => {
            mocks.eq(column, value);
            return {
              order: (column: string, options: unknown) => {
                mocks.order(column, options);
                return { abortSignal: mocks.response };
              },
            };
          },
        };
      },
      insert: (payload: unknown) => {
        mocks.insert(payload);
        return Promise.resolve({ data: null, error: null });
      },
      update: (payload: unknown) => {
        mocks.update(payload);
        return {
          eq: (column: string, value: string) => {
            mocks.eq(column, value);
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
    }),
  },
}));

import { calcPnl, closeTrade, fetchOpenTrades, formatDate, formatPnlDollar, formatPnlPercent, openTrade } from '@/lib/trades';

describe('paper trading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches open trades ordered by most recent entry date', async () => {
    mocks.response.mockResolvedValueOnce({ data: [{ id: '1', ticker: 'BTC' }], error: null });
    expect(await fetchOpenTrades()).toEqual([{ id: '1', ticker: 'BTC' }]);
    expect(mocks.select).toHaveBeenCalledWith('id,ticker,entry_price,entry_date,status');
    expect(mocks.eq).toHaveBeenCalledWith('status', 'open');
    expect(mocks.order).toHaveBeenCalledWith('entry_date', { ascending: false });
  });

  it('surfaces read failures', async () => {
    mocks.response.mockResolvedValueOnce({ data: null, error: { message: 'Permission denied' } });
    await expect(fetchOpenTrades()).rejects.toThrow('Permission denied');
  });

  it('inserts an open trade with the current price', async () => {
    await openTrade('BTC', 67432.8);
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    const payload = mocks.insert.mock.calls[0]?.[0];
    expect(payload).toMatchObject({ ticker: 'BTC', entry_price: 67432.8, status: 'open' });
    expect(payload?.entry_date).toBeTypeOf('string');
  });

  it('closes a trade by id', async () => {
    await closeTrade('abc');
    expect(mocks.update).toHaveBeenCalledWith({ status: 'closed' });
    expect(mocks.eq).toHaveBeenCalledWith('id', 'abc');
  });

  it('formats entry dates and handles missing values', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate('not-a-date')).toBe('—');
    expect(formatDate('2026-01-05T10:30:00Z')).toContain('Jan');
  });

  it('calculates P&L dollar and percent from entry and current price', () => {
    const up = calcPnl(100, 110);
    expect(up.dollar).toBe(10);
    expect(up.percent).toBeCloseTo(10, 5);

    const down = calcPnl(100, 90);
    expect(down.dollar).toBe(-10);
    expect(down.percent).toBeCloseTo(-10, 5);

    expect(calcPnl(null, 110)).toEqual({ dollar: null, percent: null });
    expect(calcPnl(100, null)).toEqual({ dollar: null, percent: null });
    expect(calcPnl(0, 110)).toEqual({ dollar: null, percent: null });
  });

  it('formats signed P&L values and handles missing values', () => {
    expect(formatPnlDollar(674.32)).toBe('+$674.32');
    expect(formatPnlDollar(-674.32)).toBe('-$674.32');
    expect(formatPnlDollar(null)).toBe('—');
    expect(formatPnlPercent(1.2345)).toBe('+1.23%');
    expect(formatPnlPercent(-1.2345)).toBe('-1.23%');
    expect(formatPnlPercent(null)).toBe('—');
  });
});
