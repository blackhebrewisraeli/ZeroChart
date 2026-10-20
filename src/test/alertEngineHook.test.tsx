import { act, renderHook, waitFor } from '@testing-library/react';
import type { User } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAlertsStoreForTests, getAlertsState } from '@/lib/alertsStore';
import type { Asset } from '@/lib/assets';

const api = vi.hoisted(() => ({
  fetchActiveAlerts: vi.fn(),
  createAlert: vi.fn(),
  claimAlert: vi.fn(),
  deleteAlert: vi.fn(),
}));

vi.mock('@/lib/priceAlerts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/priceAlerts')>();
  return { ...actual, ...api };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useAlertController, useAlertEngine } from '@/hooks/useAlertEngine';
import { toast } from 'sonner';

const user = { id: 'user-1' } as User;
const FRESH = new Date().toISOString();

function row(id: string, target: number) {
  return {
    id,
    user_id: 'user-1',
    ticker: 'BTC-USD',
    target_price: target,
    condition: 'above' as const,
    is_active: true,
    created_at: FRESH,
  };
}

function btc(price: number): Asset[] {
  return [
    {
      ticker: 'BTC-USD',
      name: null,
      current_price: price,
      sma_50: null,
      sma_200: null,
      stable_signal: null,
      radar_signal: null,
      stable_explanation: null,
      radar_explanation: null,
      risk_pct: null,
      reward_pct: null,
      volume_spike: null,
      rsi_14: null,
      change_24h: null,
      updated_at: FRESH,
    },
  ];
}

beforeEach(() => {
  __resetAlertsStoreForTests();
  vi.clearAllMocks();
  api.claimAlert.mockResolvedValue(true);
  api.deleteAlert.mockResolvedValue(undefined);
});

describe('useAlertEngine + useAlertController (integration)', () => {
  it('stores cloud alerts under the Supabase row id and claims that row once', async () => {
    api.fetchActiveAlerts.mockResolvedValue([]);
    api.createAlert.mockResolvedValue(row('row-42', 100));

    const { result, rerender } = renderHook(
      ({ assets }) => {
        useAlertEngine(assets, user);
        return useAlertController(user);
      },
      { initialProps: { assets: btc(90) } },
    );
    await waitFor(() => expect(result.current.sync.status).toBe('ready'));

    await act(async () => {
      await result.current.createAlert({ ticker: 'BTC-USD', targetPrice: 100, condition: 'above' });
    });
    expect(result.current.alerts.map((a) => a.id)).toEqual(['row-42']);

    rerender({ assets: btc(120) });
    rerender({ assets: btc(130) });

    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(api.claimAlert).toHaveBeenCalledTimes(1);
    expect(api.claimAlert).toHaveBeenCalledWith('row-42');
    expect(getAlertsState().firedCloudIds.has('row-42')).toBe(true);
  });

  it('stays silent when another tab or an earlier page load already claimed the row', async () => {
    api.fetchActiveAlerts.mockResolvedValue([row('row-9', 100)]);
    api.claimAlert.mockResolvedValue(false);
    renderHook(() => useAlertEngine(btc(120), user));

    await waitFor(() => expect(api.claimAlert).toHaveBeenCalledWith('row-9'));
    await act(async () => {});
    expect(toast.success).not.toHaveBeenCalled();
    expect(getAlertsState().alerts).toEqual([]);
  });

  it('does not re-sync when the User object is re-created with the same id', async () => {
    api.fetchActiveAlerts.mockResolvedValue([]);
    const { rerender } = renderHook(({ u }) => useAlertEngine(btc(1), u), {
      initialProps: { u: user },
    });
    await waitFor(() => expect(getAlertsState().sync.status).toBe('ready'));
    rerender({ u: { ...user } as User }); // e.g. TOKEN_REFRESHED
    expect(api.fetchActiveAlerts).toHaveBeenCalledTimes(1);
  });

  it('keeps a cloud alert visible when the server delete fails', async () => {
    api.fetchActiveAlerts.mockResolvedValue([row('row-7', 1_000_000)]);
    api.deleteAlert.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => {
      useAlertEngine(btc(1), user);
      return useAlertController(user);
    });
    await waitFor(() => expect(result.current.alerts).toHaveLength(1));
    await act(async () => {
      await expect(result.current.deleteAlert('row-7')).rejects.toThrow('offline');
    });
    expect(result.current.alerts.map((a) => a.id)).toEqual(['row-7']);
  });

  it('routes guest alerts to the session scope without touching Supabase', async () => {
    const { result } = renderHook(() => {
      useAlertEngine(btc(1), null);
      return useAlertController(null);
    });
    await act(async () => {
      await result.current.createAlert({ ticker: 'BTC-USD', targetPrice: 5, condition: 'above' });
    });
    expect(result.current.alerts[0]?.scope).toBe('session');
    expect(api.createAlert).not.toHaveBeenCalled();
    expect(api.fetchActiveAlerts).not.toHaveBeenCalled();
  });
});
