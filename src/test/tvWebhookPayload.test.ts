import { describe, expect, it } from 'vitest';
import { parseSignal, sha256Hex } from '../../supabase/functions/tv-webhook/payload';

describe('tv-webhook payload', () => {
  it('normalises a TradingView alert body', () => {
    expect(
      parseSignal({
        secret_token: 'tok',
        ticker: 'binance:btcusdt',
        action: 'buy',
        score: '85.4',
        size: 500,
        stop_loss: '48000',
      }),
    ).toEqual({
      ok: true,
      token: 'tok',
      signal: {
        ticker: 'BTCUSDT',
        action: 'BUY',
        conviction_score: 85,
        suggested_size: 500,
        stop_loss: 48_000,
      },
    });
  });

  it.each([
    [null, 'Body must be a JSON object'],
    [{ ticker: 'BTCUSDT' }, 'secret_token is required'],
    [{ secret_token: 't', ticker: 'BTC USDT' }, 'ticker is invalid'],
    [{ secret_token: 't', ticker: 'BTCUSDT', action: 'HOLD' }, 'action must be BUY or SELL'],
    [{ secret_token: 't', ticker: 'X', action: 'SELL', score: '' }, 'score must be 0-100'],
    [{ secret_token: 't', ticker: 'X', action: 'SELL', score: 101 }, 'score must be 0-100'],
    [
      { secret_token: 't', ticker: 'X', action: 'SELL', score: 5, size: 0 },
      'size must be greater than zero',
    ],
    [
      { secret_token: 't', ticker: 'X', action: 'SELL', score: 5, size: 1, stop_loss: -1 },
      'stop_loss must be greater than zero',
    ],
  ])('rejects %j', (body, error) => {
    expect(parseSignal(body)).toEqual({ ok: false, error });
  });

  it('hashes tokens like Postgres sha256() hex', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
