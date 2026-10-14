import { beforeEach, describe, expect, it, vi } from 'vitest';
const { response, range } = vi.hoisted(() => ({ response: vi.fn(), range: vi.fn() }));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        order: () => ({
          range: (...args: number[]) => {
            range(...args);
            return { abortSignal: response };
          },
        }),
      }),
    }),
  },
}));
import {
  calculateSignalScore,
  fetchAssets,
  formatChange,
  formatPrice,
  formatReward,
  formatRisk,
  formatRsi,
  formatTradingViewSymbol,
  formatVolume,
  generateTrendData,
  getAssetClass,
  getBrokerRoute,
  type Asset,
} from '@/lib/assets';

describe('asset data', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('paginates until all rows have been fetched', async () => {
    response
      .mockResolvedValueOnce({
        data: Array.from({ length: 1000 }, (_, i) => ({ ticker: `T${i}` })),
        error: null,
      })
      .mockResolvedValueOnce({ data: [{ ticker: 'T1000' }], error: null });
    expect(await fetchAssets()).toHaveLength(1001);
    expect(range.mock.calls).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });
  it('returns empty live data without substituting samples', async () => {
    response.mockResolvedValueOnce({ data: [], error: null });
    expect(await fetchAssets()).toEqual([]);
  });
  it('surfaces read failures', async () => {
    response.mockResolvedValueOnce({ data: null, error: { message: 'Permission denied' } });
    await expect(fetchAssets()).rejects.toThrow('Permission denied');
  });
  it('formats percent points and handles missing values', () => {
    expect(formatRisk(0.032)).toBe('3.2%');
    expect(formatRisk(null)).toBe('—');
    expect(formatPrice(null)).toBe('—');
    expect(formatPrice(67432.8)).toBe('$67,432.80');
  });
  it('formats reward percentages and volume spikes', () => {
    expect(formatReward(0.052)).toBe('5.2%');
    expect(formatReward(0)).toBe('0.0%');
    expect(formatReward(null)).toBe('—');
    expect(formatVolume(1.8)).toBe('1.8x');
    expect(formatVolume(null)).toBe('—');
  });
  it('formats RSI readings and handles missing values', () => {
    expect(formatRsi(60.5)).toBe('60.5');
    expect(formatRsi(null)).toBe('—');
  });
  it('classifies asset classes by ticker suffix', () => {
    expect(getAssetClass('BTC-USD')).toBe('Crypto');
    expect(getAssetClass('EURUSD=X')).toBe('Forex');
    expect(getAssetClass('AAPL')).toBe('Stocks');
    expect(getAssetClass('SPY')).toBe('Stocks');
  });
  it('formats 24h change with a sign and handles missing values', () => {
    expect(formatChange(0.024)).toBe('+2.40%');
    expect(formatChange(-0.031)).toBe('-3.10%');
    expect(formatChange(0)).toBe('+0.00%');
    expect(formatChange(null)).toBe('—');
  });
  it('maps tickers to TradingView symbols', () => {
    expect(formatTradingViewSymbol('EURUSD=X')).toBe('FX:EURUSD');
    expect(formatTradingViewSymbol('BTC-USD')).toBe('CRYPTO:BTCUSD');
    expect(formatTradingViewSymbol('AAPL')).toBe('AAPL');
    expect(formatTradingViewSymbol('MSFT')).toBe('MSFT');
  });
  it('scores assets from reward-to-risk ratio and signal bonuses', () => {
    const base: Asset = {
      ticker: 'TEST',
      name: null,
      current_price: 100,
      sma_50: 90,
      sma_200: null,
      stable_signal: null,
      radar_signal: null,
      stable_explanation: null,
      radar_explanation: null,
      risk_pct: 0.05,
      reward_pct: 0.1,
      volume_spike: null,
      rsi_14: null,
      change_24h: null,
      updated_at: null,
    };
    // ratio = 2 -> base 60, no volume spike, trend positive -> +10 = 70
    expect(calculateSignalScore(base)).toBe(70);
    // ratio = 3 -> base 80, volume spike +15, trend positive +10 -> capped at 100
    expect(calculateSignalScore({ ...base, reward_pct: 0.15, volume_spike: 1.8 })).toBe(100);
    // ratio = 1 -> base 40, no bonuses
    expect(calculateSignalScore({ ...base, risk_pct: 0.1, reward_pct: 0.1, sma_50: null })).toBe(
      40,
    );
    // missing data -> minimal base 20
    expect(calculateSignalScore({ ...base, risk_pct: null, reward_pct: null, sma_50: null })).toBe(
      20,
    );
  });
  it('routes tickers to external brokers', () => {
    expect(getBrokerRoute('BTC-USD')).toEqual({
      label: 'Trade on Binance',
      url: 'https://www.binance.com/en/markets',
    });
    expect(getBrokerRoute('EURUSD=X')).toEqual({
      label: 'Trade on OANDA',
      url: 'https://www.oanda.com/',
    });
    expect(getBrokerRoute('AAPL')).toEqual({
      label: 'Trade on eToro',
      url: 'https://www.etoro.com/markets/aapl',
    });
    expect(getBrokerRoute('BRK.B')).toEqual({
      label: 'Trade on eToro',
      url: 'https://www.etoro.com/markets/brkb',
    });
  });

  it('generates a 20-point trend series matching the 24h change', () => {
    const up = generateTrendData(100, 0.1);
    expect(up).toHaveLength(20);
    expect(up[19]).toBe(100);
    expect(up[0]).toBeCloseTo(100 / 1.1);
    expect(up[0]).toBeLessThan(up[19]!);

    const down = generateTrendData(100, -0.1);
    expect(down).toHaveLength(20);
    expect(down[19]).toBe(100);
    expect(down[0]).toBeCloseTo(100 / 0.9);
    expect(down[0]).toBeGreaterThan(down[19]!);
  });

  it('falls back to a flat series for missing price or change', () => {
    expect(generateTrendData(null, 0.1)).toEqual(Array(20).fill(0));
    expect(generateTrendData(0, 0.1)).toEqual(Array(20).fill(0));

    const flat = generateTrendData(100, null);
    expect(flat).toHaveLength(20);
    expect(flat[0]).toBe(100);
    expect(flat[19]).toBe(100);
    expect(flat.every((value) => Math.abs(value - 100) <= 1)).toBe(true);
  });
});
