import { describe, expect, it } from 'vitest';
import { toRows } from '../../supabase/functions/crypto-price-feed/prices';

const now = new Date('2026-10-20T12:00:00Z');
const at = now.toISOString();

describe('crypto-price-feed rows', () => {
  it('maps Binance USDT pairs onto the scanner tickers', () => {
    expect(
      toRows(
        [
          { symbol: 'ETHUSDT', price: '2418.76000000' },
          { symbol: 'BTCUSDT', price: '82319.46000000' },
        ],
        now,
      ),
    ).toEqual([
      { ticker: 'BTC-USD', current_price: 82319.46, updated_at: at },
      { ticker: 'ETH-USD', current_price: 2418.76, updated_at: at },
    ]);
  });

  it('drops missing, zero and unparseable prices', () => {
    expect(
      toRows(
        [
          { symbol: 'BTCUSDT', price: '0' },
          { symbol: 'ETHUSDT', price: 'abc' },
          { symbol: 'SOLUSDT' },
          null,
        ],
        now,
      ),
    ).toEqual([]);
  });

  it('writes nothing when Binance answers with an error', () => {
    expect(toRows({ code: 0, msg: 'Service unavailable from a restricted location' }, now)).toEqual(
      [],
    );
  });
});
