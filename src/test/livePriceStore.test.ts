import { describe, expect, it } from 'vitest';
import { mergeLivePrices } from '@/lib/livePriceStore';
import type { Asset } from '@/lib/assets';

function makeAsset(
  ticker: string,
  currentPrice: number | null = null,
  change: number | null = null,
): Asset {
  return {
    ticker,
    name: null,
    current_price: currentPrice,
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
    change_24h: change,
    updated_at: null,
  };
}

describe('mergeLivePrices', () => {
  it('overlays live prices onto matching crypto symbols', () => {
    const assets = [makeAsset('BTC-USD', 100, 0.01)];
    const prices = new Map([['BTCUSDT', { price: 42000, change: 0.05 }]]);

    const merged = mergeLivePrices(assets, prices);

    expect(merged[0]?.current_price).toBe(42000);
    expect(merged[0]?.change_24h).toBe(0.05);
  });

  it('leaves non-crypto assets untouched', () => {
    const assets = [makeAsset('AAPL', 220, -0.01)];

    const merged = mergeLivePrices(assets, new Map());

    expect(merged[0]?.current_price).toBe(220);
    expect(merged[0]?.change_24h).toBe(-0.01);
  });
});
