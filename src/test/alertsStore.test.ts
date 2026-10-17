import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetAlertsStoreForTests,
  addAlert,
  beginCloudSync,
  completeCloudSync,
  failCloudSync,
  getAlertsState,
  removeAlert,
  resetToGuestSession,
  takeAlert,
  type PriceAlert,
} from '@/lib/alertsStore';

function cloud(id: string): PriceAlert {
  return {
    id,
    ticker: 'BTC-USD',
    targetPrice: 100,
    condition: 'above',
    createdAt: 0,
    scope: 'cloud',
  };
}

beforeEach(() => {
  __resetAlertsStoreForTests();
});

describe('alertsStore lifecycle (M1-T4, F-5.1)', () => {
  it('requires the persisted row id for cloud alerts and is idempotent by id', () => {
    expect(() =>
      addAlert({ ticker: 'BTC-USD', targetPrice: 1, condition: 'above' }, 'cloud'),
    ).toThrow(/persisted user_alerts id/);
    beginCloudSync('u1');
    completeCloudSync('u1', []);
    const input = { id: 'row-1', ticker: 'BTC-USD', targetPrice: 1, condition: 'above' as const };
    const first = addAlert(input, 'cloud');
    const again = addAlert(input, 'cloud');
    expect(first.id).toBe('row-1');
    expect(again).toBe(first);
    expect(getAlertsState().alerts).toHaveLength(1);
  });

  it('keeps guest session alerts across a redundant guest reset (remount)', () => {
    addAlert({ ticker: 'BTC', targetPrice: 1, condition: 'above' }, 'session');
    resetToGuestSession();
    expect(getAlertsState().alerts).toHaveLength(1);
    expect(getAlertsState().alerts[0]?.scope).toBe('session');
  });

  it('isolates accounts: switching users or signing out clears cloud alerts', () => {
    beginCloudSync('u1');
    completeCloudSync('u1', [cloud('a')]);
    beginCloudSync('u2');
    expect(getAlertsState().alerts).toEqual([]);
    completeCloudSync('u2', [cloud('b')]);
    resetToGuestSession();
    expect(getAlertsState()).toMatchObject({ alerts: [], sync: { syncedUserId: null } });
  });

  it('drops stale sync responses for a previous user', () => {
    beginCloudSync('u1');
    beginCloudSync('u2');
    completeCloudSync('u1', [cloud('leak')]);
    failCloudSync('u1');
    expect(getAlertsState().alerts).toEqual([]);
    expect(getAlertsState().sync).toEqual({ syncedUserId: 'u2', status: 'loading' });
  });

  it('preserves alerts created while a sync is in flight', () => {
    beginCloudSync('u1');
    addAlert({ id: 'new', ticker: 'ETH-USD', targetPrice: 5, condition: 'below' }, 'cloud');
    completeCloudSync('u1', [cloud('old')]);
    expect(getAlertsState().alerts.map((a) => a.id)).toEqual(['old', 'new']);
  });

  it('suppresses a fired cloud alert across same-user re-syncs (F-5.1c)', () => {
    beginCloudSync('u1');
    completeCloudSync('u1', [cloud('a')]);
    expect(takeAlert('a')?.id).toBe('a');
    // Deactivation failed server-side → the row comes back active on refetch.
    beginCloudSync('u1');
    completeCloudSync('u1', [cloud('a')]);
    expect(getAlertsState().alerts).toEqual([]);
  });

  it('takeAlert claims exactly once; removeAlert is a safe no-op when absent', () => {
    const alert = addAlert({ ticker: 'BTC', targetPrice: 1, condition: 'above' }, 'session');
    expect(takeAlert(alert.id)).not.toBeNull();
    expect(takeAlert(alert.id)).toBeNull();
    expect(() => removeAlert(alert.id)).not.toThrow();
  });
});
