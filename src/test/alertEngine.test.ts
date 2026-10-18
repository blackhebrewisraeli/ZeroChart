import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAlertsStoreForTests,
  addAlert,
  beginCloudSync,
  completeCloudSync,
  getAlertsState,
} from '@/lib/alertsStore';
import { buildPriceIndex, runAlertPass, withRetry } from '@/lib/alertEngine';
import type { Asset } from '@/lib/assets';
import type { LivePrice } from '@/lib/livePriceStore';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const FRESH = new Date(NOW - 60_000).toISOString();
const STALE = new Date(NOW - 3 * 60 * 60 * 1000).toISOString();
const noLive = new Map<string, LivePrice>();

function asset(ticker: string, price: number | null, updatedAt: string | null = FRESH): Asset {
  return {
    ticker,
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
    updated_at: updatedAt,
  };
}

function pass(assets: Asset[], livePrices = noLive, streamConnected = true) {
  return runAlertPass({ assets, livePrices, streamConnected, now: NOW });
}

beforeEach(() => {
  __resetAlertsStoreForTests();
});

describe('runAlertPass — the single evaluator (M1-T4, F-5.1)', () => {
  it('records each firing once for the Lab feed, cleared on an account switch', () => {
    const alert = addAlert({ ticker: 'BTC-USD', targetPrice: 100, condition: 'above' }, 'session');
    pass([asset('BTC-USD', 150)]);
    pass([asset('BTC-USD', 150)]);
    expect(getAlertsState().triggered).toEqual([{ alert, price: 150, triggeredAt: NOW }]);

    beginCloudSync('u1');
    expect(getAlertsState().triggered).toEqual([]);
  });

  it('fires exactly once per crossing even across repeated passes', () => {
    addAlert({ ticker: 'BTC-USD', targetPrice: 100, condition: 'above' }, 'session');
    expect(pass([asset('BTC-USD', 150)])).toHaveLength(1);
    expect(pass([asset('BTC-USD', 150)])).toHaveLength(0);
    expect(getAlertsState().alerts).toEqual([]);
  });

  it('evaluates session and cloud alerts in one pass and suppresses fired cloud ids', () => {
    beginCloudSync('u1');
    completeCloudSync('u1', [
      {
        id: 'c1',
        ticker: 'BTC-USD',
        targetPrice: 100,
        condition: 'above',
        createdAt: 0,
        scope: 'cloud',
      },
    ]);
    addAlert({ ticker: 'AAPL', targetPrice: 200, condition: 'below' }, 'session');
    const fired = pass([asset('BTC-USD', 120), asset('AAPL', 190)]);
    expect(fired.map((f) => f.alert.scope).sort()).toEqual(['cloud', 'session']);
    expect(getAlertsState().firedCloudIds.has('c1')).toBe(true);
  });

  it('never fires on Stale, Simulated, or Unavailable prices (F-5.1d)', () => {
    for (const ticker of ['AAPL', 'NVDA', 'TSLA']) {
      addAlert({ ticker, targetPrice: 100, condition: 'above' }, 'session');
    }
    const fired = pass([asset('AAPL', 500, STALE), asset('NVDA', 500, ''), asset('TSLA', null)]);
    expect(fired).toEqual([]);
    expect(getAlertsState().alerts).toHaveLength(3);
  });

  it('prefers the live tick and keeps evaluating while reconnecting (F-5.1b)', () => {
    addAlert({ ticker: 'BTC', targetPrice: 100, condition: 'above' }, 'session');
    const live = new Map<string, LivePrice>([['BTCUSDT', { price: 150, change: 0 }]]);
    const sample = [asset('BTC', 50, '')];
    const index = buildPriceIndex({
      assets: sample,
      livePrices: live,
      streamConnected: false,
      now: NOW,
    });
    expect(index.get('BTC')).toEqual({ price: 150, freshness: 'Delayed' });
    const fired = pass(sample, live, false);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.price).toBe(150);
  });

  it('never merges live ticks into equities with look-alike symbols', () => {
    addAlert({ ticker: 'AAPL', targetPrice: 100, condition: 'above' }, 'session');
    const live = new Map<string, LivePrice>([['AAPLUSDT', { price: 999, change: 0 }]]);
    expect(pass([asset('AAPL', 50)], live)).toEqual([]);
  });

  it('does not evaluate while the cloud sync is loading', () => {
    beginCloudSync('u1');
    addAlert({ id: 'x', ticker: 'BTC-USD', targetPrice: 1, condition: 'above' }, 'cloud');
    expect(pass([asset('BTC-USD', 5)])).toEqual([]);
  });
});

describe('withRetry', () => {
  it('retries with exponential backoff and reports eventual success', async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    let calls = 0;
    const ok = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('transient');
      },
      { attempts: 3, baseDelayMs: 10, sleep },
    );
    expect(ok).toBe(true);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([10, 20]);
  });

  it('gives up after the bounded number of attempts', async () => {
    const task = vi.fn(async () => {
      throw new Error('down');
    });
    const ok = await withRetry(task, { attempts: 2, baseDelayMs: 0, sleep: async () => undefined });
    expect(ok).toBe(false);
    expect(task).toHaveBeenCalledTimes(2);
  });
});
