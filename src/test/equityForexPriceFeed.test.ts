import { describe, expect, it } from 'vitest';
import { sparkUrls, toRows } from '../../supabase/functions/equity-forex-price-feed/quotes';

const symbolsOf = (url: string) => new URL(url).searchParams.get('symbols')?.split(',') ?? [];

describe('equity-forex-price-feed', () => {
  it('quotes equities and forex in batches of 20, leaving crypto to crypto-price-feed', () => {
    const equities = Array.from({ length: 21 }, (_, i) => `T${i}`);
    const urls = sparkUrls(['BTC-USD', 'EURUSD=X', ...equities, 'SOL', 'JPY=X']);
    expect(urls.map(symbolsOf)).toEqual([
      ['EURUSD=X', ...equities.slice(0, 19)],
      [...equities.slice(19), 'JPY=X'],
    ]);
  });

  it('stamps each row with its market time, so a closed market stays stale', () => {
    expect(
      toRows({
        spark: {
          result: [
            {
              symbol: 'AAPL',
              response: [
                {
                  meta: {
                    regularMarketPrice: 342.38,
                    regularMarketTime: 1792526400,
                    chartPreviousClose: 335,
                  },
                },
              ],
            },
            {
              symbol: 'JPY=X',
              response: [{ meta: { regularMarketPrice: 158.07, regularMarketTime: 1792505386 } }],
            },
          ],
          error: null,
        },
      }),
    ).toEqual([
      {
        ticker: 'AAPL',
        current_price: 342.38,
        change_24h: expect.closeTo(342.38 / 335 - 1),
        updated_at: '2026-10-20T20:00:00.000Z',
      },
      {
        ticker: 'JPY=X',
        current_price: 158.07,
        change_24h: null,
        updated_at: '2026-10-20T14:09:46.000Z',
      },
    ]);
  });

  it('drops missing, zero and undatable quotes', () => {
    expect(
      toRows({
        spark: {
          result: [
            {
              symbol: 'AAPL',
              response: [{ meta: { regularMarketPrice: 0, regularMarketTime: 1 } }],
            },
            { symbol: 'PLTR', response: [{ meta: { regularMarketPrice: 209 } }] },
            { symbol: 'DELISTED', response: [] },
            null,
          ],
        },
      }),
    ).toEqual([]);
  });

  it('writes nothing when Yahoo rejects the request', () => {
    expect(
      toRows({ spark: { result: null, error: { code: 'Bad Request', description: '...' } } }),
    ).toEqual([]);
    expect(toRows(null)).toEqual([]);
  });
});
