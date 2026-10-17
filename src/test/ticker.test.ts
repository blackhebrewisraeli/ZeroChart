import { describe, expect, it } from 'vitest';
import {
  classifyTicker,
  cryptoBase,
  isBinanceCrypto,
  toBinanceSymbol,
  toDisplayTicker,
  toTradingViewSymbol,
} from '@/lib/ticker';
import { formatTradingViewSymbol, getAssetClass, getBrokerRoute } from '@/lib/assets';

describe('classifyTicker (M1-T4, F-3.2d)', () => {
  it('classifies each ticker into exactly one kind', () => {
    expect(classifyTicker('BTC-USD')).toBe('crypto');
    expect(classifyTicker('eth-usdt')).toBe('crypto');
    expect(classifyTicker('BTC')).toBe('crypto');
    expect(classifyTicker(' sol ')).toBe('crypto');
    expect(classifyTicker('EURUSD=X')).toBe('forex');
    expect(classifyTicker('AAPL')).toBe('equity');
    expect(classifyTicker('BRK.B')).toBe('equity');
  });

  it('is collision-free for look-alike symbols', () => {
    // Substring matches must not leak equities into the crypto class.
    expect(classifyTicker('FOO-USDX')).toBe('equity');
    expect(classifyTicker('X-USD-B')).toBe('equity');
    expect(classifyTicker('BTCX')).toBe('equity');
    expect(classifyTicker('=X')).toBe('equity');
    // Equities never map onto Binance pairs (old AAPL→AAPLUSDT footgun).
    expect(toBinanceSymbol('AAPL')).toBeNull();
    expect(toBinanceSymbol('FOO-USDX')).toBeNull();
  });

  it('normalizes -USD and -USDT pairs to the same Binance symbol', () => {
    expect(toBinanceSymbol('BTC-USD')).toBe('BTCUSDT');
    expect(toBinanceSymbol('BTC-USDT')).toBe('BTCUSDT');
    expect(toBinanceSymbol('BTC')).toBe('BTCUSDT');
    expect(cryptoBase('ETH-USDT')).toBe('ETH');
    expect(cryptoBase('AAPL')).toBeNull();
  });

  it('derives display + TradingView symbols from one classification', () => {
    expect(toDisplayTicker('BTC-USDT')).toBe('BTC');
    expect(toDisplayTicker('aapl')).toBe('AAPL');
    expect(toTradingViewSymbol('BTC')).toBe('CRYPTO:BTCUSD');
    expect(toTradingViewSymbol('BTC-USD')).toBe('CRYPTO:BTCUSD');
    expect(toTradingViewSymbol('EURUSD=X')).toBe('FX:EURUSD');
    expect(toTradingViewSymbol('AAPL')).toBe('AAPL');
  });

  it('keeps every consumer consistent for bare crypto tickers', () => {
    for (const ticker of ['BTC', 'BTC-USD']) {
      expect(isBinanceCrypto(ticker)).toBe(true);
      expect(getAssetClass(ticker)).toBe('Crypto');
      expect(getBrokerRoute(ticker).label).toBe('Trade on Binance');
      expect(formatTradingViewSymbol(ticker)).toBe('CRYPTO:BTCUSD');
    }
    expect(getAssetClass('AAPL')).toBe('Stocks');
    expect(getBrokerRoute('AAPL').label).toBe('Trade on eToro');
  });
});
