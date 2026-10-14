import { isBinanceCrypto, parseKlines, toBinanceSymbol, toDisplayTicker } from '@/lib/binance';

describe('toBinanceSymbol', () => {
  it('maps crypto tickers to USDT pairs', () => {
    expect(toBinanceSymbol('BTC-USD')).toBe('BTCUSDT');
    expect(toBinanceSymbol('BTC')).toBe('BTCUSDT');
    expect(toBinanceSymbol('eth-usd')).toBe('ETHUSDT');
  });

  it('returns null for forex pairs', () => {
    expect(toBinanceSymbol('EURUSD=X')).toBeNull();
  });
});

describe('toDisplayTicker', () => {
  it('strips the -USD suffix', () => {
    expect(toDisplayTicker('BTC-USD')).toBe('BTC');
    expect(toDisplayTicker('BTC')).toBe('BTC');
  });
});

describe('isBinanceCrypto', () => {
  it('recognizes -USD and known bare crypto tickers', () => {
    expect(isBinanceCrypto('BTC-USD')).toBe(true);
    expect(isBinanceCrypto('BTC')).toBe(true);
    expect(isBinanceCrypto('ETH')).toBe(true);
  });

  it('rejects stocks and forex', () => {
    expect(isBinanceCrypto('AAPL')).toBe(false);
    expect(isBinanceCrypto('NVDA')).toBe(false);
    expect(isBinanceCrypto('EURUSD=X')).toBe(false);
  });
});

describe('parseKlines', () => {
  it('extracts timestamp and close from kline rows', () => {
    const raw = [
      [1700000000000, '1.0', '2.0', '0.5', '1.5', '100', 1700000099999],
      [1700001000000, '1.5', '2.5', '1.0', '2.0', '120', 1700001099999],
    ];
    expect(parseKlines(raw)).toEqual([
      { timestamp: 1700000000000, close: 1.5 },
      { timestamp: 1700001000000, close: 2.0 },
    ]);
  });

  it('drops malformed rows', () => {
    const raw = [[null, 'x'], 'nope', [1700000000000, '1', '2', '3', '4', '5']];
    expect(parseKlines(raw)).toEqual([{ timestamp: 1700000000000, close: 4 }]);
  });
});
