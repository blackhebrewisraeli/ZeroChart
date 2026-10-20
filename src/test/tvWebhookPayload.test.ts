import { describe, expect, it } from 'vitest';
import {
  SECRET_PLACEHOLDER,
  parseSignal,
  readToken,
  sha256Hex,
} from '../../supabase/functions/tv-webhook/payload';

const valid = {
  ticker: 'BTCUSDT',
  action: 'SELL',
  signal_score: 5,
  price: 50_000,
  quantity: 0.05,
  event_id: '2026-10-20T12:00:00Z',
};

describe('tv-webhook payload', () => {
  it('normalises a TradingView alert body', () => {
    expect(
      parseSignal({
        secret_token: 'tok',
        ticker: 'binance:btcusdt',
        action: 'buy',
        signal_score: '85.4',
        price: '50000.5',
        quantity: '0.05',
        stop_loss: '48000',
        event_id: ' 2026-10-20T12:00:00Z ',
      }),
    ).toEqual({
      ok: true,
      signal: {
        ticker: 'BTCUSDT',
        action: 'BUY',
        signal_score: 85,
        price: 50_000.5,
        quantity: 0.05,
        stop_loss: 48_000,
        event_id: '2026-10-20T12:00:00Z',
      },
    });
  });

  it('keys an alert without event_id to its minute, so a re-send dedupes', () => {
    const { event_id: _omitted, ...body } = valid;
    const at = (iso: string) => parseSignal(body, new Date(iso));
    expect(at('2026-10-20T12:00:05Z')).toMatchObject({
      signal: { event_id: '2026-10-20T12:00' },
    });
    expect(at('2026-10-20T12:00:55Z')).toEqual(at('2026-10-20T12:00:05Z'));
  });

  it.each([
    [null, 'Body must be a JSON object'],
    [{ ...valid, ticker: 'BTC USDT' }, 'ticker is invalid'],
    [{ ...valid, action: 'HOLD' }, 'action must be BUY or SELL'],
    [{ ...valid, signal_score: '' }, 'signal_score must be 0-100'],
    [{ ...valid, signal_score: 101 }, 'signal_score must be 0-100'],
    [{ ...valid, price: 0 }, 'price must be greater than zero'],
    [{ ...valid, quantity: 0 }, 'quantity must be greater than zero'],
    [{ ...valid, quantity: 'NaN' }, 'quantity must be greater than zero'],
    [{ ...valid, stop_loss: -1 }, 'stop_loss must be greater than zero'],
    [{ ...valid, event_id: 42 }, 'event_id must be a string'],
    [{ ...valid, event_id: 'x'.repeat(65) }, 'event_id is too long'],
  ])('rejects %j', (body, error) => {
    expect(parseSignal(body)).toEqual({ ok: false, error });
  });

  it('only yields a real secret_token', () => {
    expect(readToken({ secret_token: 'tok' })).toBe('tok');
    for (const body of [
      null,
      'tok',
      {},
      { secret_token: '' },
      { secret_token: 42 },
      { secret_token: SECRET_PLACEHOLDER },
    ]) {
      expect(readToken(body)).toBeNull();
    }
  });

  it('hashes tokens like Postgres sha256() hex', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
