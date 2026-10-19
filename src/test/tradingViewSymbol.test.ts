import { describe, expect, it } from 'vitest';
import { toTradingViewSymbol } from '@/lib/tradingViewSymbol';

describe('toTradingViewSymbol', () => {
  it('maps crypto onto the Binance USDT market', () => {
    expect(toTradingViewSymbol('BTC')).toBe('BINANCE:BTCUSDT');
    expect(toTradingViewSymbol('ETH')).toBe('BINANCE:ETHUSDT');
    expect(toTradingViewSymbol('SOL')).toBe('BINANCE:SOLUSDT');
    expect(toTradingViewSymbol('btc-usd')).toBe('BINANCE:BTCUSDT');
    expect(toTradingViewSymbol('ETH-USDT')).toBe('BINANCE:ETHUSDT');
  });

  it('prefixes known NASDAQ equities', () => {
    for (const ticker of ['AAPL', 'NVDA', 'MSFT', 'QCOM', 'TSLA']) {
      expect(toTradingViewSymbol(ticker)).toBe(`NASDAQ:${ticker}`);
    }
    expect(toTradingViewSymbol(' aapl ')).toBe('NASDAQ:AAPL');
  });

  it('leaves other equities bare so TradingView picks the primary listing', () => {
    expect(toTradingViewSymbol('SPY')).toBe('SPY');
    expect(toTradingViewSymbol('JPM')).toBe('JPM');
    expect(toTradingViewSymbol('BRK.B')).toBe('BRK.B');
  });

  it('maps forex onto the FX feed', () => {
    expect(toTradingViewSymbol('EURUSD=X')).toBe('FX:EURUSD');
  });
});
