import { describe, expect, it } from 'vitest';
import { toRows } from '../../supabase/functions/crypto-price-feed/prices';

const now = new Date('2026-10-20T12:00:00Z');
const at = now.toISOString();

describe('crypto-price-feed rows', () => {
  it('maps Binance USDT pairs onto the scanner tickers, with the rolling 24h change', () => {
    expect(
      toRows(
        [
          { symbol: 'ETHUSDT', lastPrice: '2418.76000000' },
          { symbol: 'BTCUSDT', lastPrice: '82000.00000000', openPrice: '80000.00000000' },
        ],
        now,
      ),
    ).toEqual([
      {
        ticker: 'BTC-USD',
        current_price: 82000,
        change_24h: expect.closeTo(0.025),
        updated_at: at,
      },
      { ticker: 'ETH-USD', current_price: 2418.76, change_24h: null, updated_at: at },
    ]);
  });

  it('drops missing, zero and unparseable prices', () => {
    expect(
      toRows(
        [
          { symbol: 'BTCUSDT', lastPrice: '0', openPrice: '1' },
          { symbol: 'ETHUSDT', lastPrice: 'abc' },
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
