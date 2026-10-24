import { describe, expect, it } from 'vitest';
import {
  SECRET_PLACEHOLDER,
  parseSignal,
  readToken,
  sha256Hex,
} from '../../supabase/functions/tv-webhook/payload';

const valid = {
  signal_kind: 'strategy',
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
        signal_kind: 'strategy',
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
        signal_kind: 'strategy',
        ticker: 'BTCUSDT',
        action: 'BUY',
        signal_score: 85,
        price: 50_000.5,
        quantity: 0.05,
        stop_loss: 48_000,
        event_id: '2026-10-20T12:00:00Z',
        exchange: 'BINANCE',
      },
    });
  });

  it('keeps source context when the HUD sends it', () => {
    expect(
      parseSignal({
        ...valid,
        exchange: 'binance',
        timeframe: '60',
        bar_time: Date.UTC(2026, 9, 21, 23),
        model_version: '1.0.0',
      }),
    ).toMatchObject({
      signal: {
        signal_kind: 'strategy',
        exchange: 'BINANCE',
        timeframe: '60',
        bar_time: '2026-10-21T23:00:00.000Z',
        model_version: '1.0.0',
      },
    });
    // TradingView's {{time}} placeholder is ISO.
    expect(parseSignal({ ...valid, bar_time: '2026-10-21T23:00:00Z' })).toMatchObject({
      signal: { bar_time: '2026-10-21T23:00:00.000Z' },
    });
    expect(parseSignal({ ...valid, signal_kind: 'transport_test' })).toMatchObject({
      signal: { signal_kind: 'transport_test' },
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
    [{ ...valid, signal_kind: undefined }, 'signal_kind must be strategy or transport_test'],
    [{ ...valid, action: 'HOLD' }, 'action must be BUY or SELL'],
    [{ ...valid, signal_score: '' }, 'signal_score must be 0-100'],
    [{ ...valid, signal_score: 101 }, 'signal_score must be 0-100'],
    [{ ...valid, price: 0 }, 'price must be greater than zero'],
    [{ ...valid, quantity: 0 }, 'quantity must be greater than zero'],
    [{ ...valid, quantity: 'NaN' }, 'quantity must be greater than zero'],
    [{ ...valid, stop_loss: -1 }, 'stop_loss must be greater than zero'],
    [{ ...valid, event_id: 42 }, 'event_id must be a string'],
    [{ ...valid, event_id: 'x'.repeat(65) }, 'event_id is too long'],
    [{ ...valid, exchange: 'BIN ANCE' }, 'exchange is invalid'],
    [{ ...valid, timeframe: '' }, 'timeframe is invalid'],
    [{ ...valid, timeframe: '1 hour' }, 'timeframe is invalid'],
    [{ ...valid, bar_time: 'yesterday' }, 'bar_time is invalid'],
    [{ ...valid, model_version: { v: 1 } }, 'model_version is invalid'],
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
