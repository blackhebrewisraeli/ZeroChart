import { describe, expect, it } from 'vitest';
import { getBrokerUrl } from '@/lib/tradeRouter';

describe('getBrokerUrl', () => {
  it('routes crypto assets to Binance spot trade pages', () => {
    expect(getBrokerUrl('BTC-USD', 'crypto')).toBe('https://www.binance.com/en/trade/BTC_USDT');
    expect(getBrokerUrl('BTC', 'crypto')).toBe('https://www.binance.com/en/trade/BTC_USDT');
    expect(getBrokerUrl('eth-usd', 'crypto')).toBe('https://www.binance.com/en/trade/ETH_USDT');
  });

  it('routes stocks to eToro market pages', () => {
    expect(getBrokerUrl('AAPL', 'stock')).toBe('https://www.etoro.com/markets/aapl');
    expect(getBrokerUrl('NVDA', 'stock')).toBe('https://www.etoro.com/markets/nvda');
  });
});
