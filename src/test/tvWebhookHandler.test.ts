import { describe, expect, it, vi } from 'vitest';
import { handleWebhook, type Ingested } from '../../supabase/functions/tv-webhook/handler';
import { sha256Hex } from '../../supabase/functions/tv-webhook/payload';

const alert = {
  secret_token: 'tok-secret',
  ticker: 'BTCUSD',
  action: 'SELL',
  signal_score: 57,
  price: 84_000,
  quantity: 0.119047619,
  event_id: '2026-10-22T00:00:22Z',
};

function deliver(body: unknown, answer: Ingested | Error = 'accepted', method = 'POST') {
  const ingest = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const lines: string[] = [];
  const req = new Request('https://example.test/functions/v1/tv-webhook', {
    method,
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  return handleWebhook(req, { ingest, log: (line) => lines.push(line) }).then(async (res) => ({
    status: res.status,
    body: await res.json(),
    ingest,
    log: lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  }));
}

describe('tv-webhook handler', () => {
  it('records a signal in one ingest call and acknowledges with 201', async () => {
    const { status, body, ingest, log } = await deliver(alert);
    expect(status).toBe(201);
    expect(body).toEqual({ ok: true });
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledWith(
      await sha256Hex('tok-secret'),
      expect.objectContaining({ ticker: 'BTCUSD', action: 'SELL', event_id: alert.event_id }),
    );
    expect(log).toEqual([
      expect.objectContaining({
        fn: 'tv-webhook',
        outcome: 'accepted',
        status: 201,
        ticker: 'BTCUSD',
        event_id: alert.event_id,
      }),
    ]);
  });

  it('answers a redelivered event with 200 duplicate', async () => {
    const { status, body, log } = await deliver(alert, 'duplicate');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, duplicate: true });
    expect(log[0]).toMatchObject({ outcome: 'duplicate' });
  });

  it('rejects an unknown token before revealing validation errors', async () => {
    const { status, body, ingest, log } = await deliver(
      { ...alert, action: 'HOLD' },
      'unauthorized',
    );
    expect(status).toBe(401);
    expect(body).toEqual({ error: 'Invalid secret_token' });
    // A malformed body only authenticates: nothing to insert.
    expect(ingest).toHaveBeenCalledWith(expect.any(String), null);
    expect(log[0]).toMatchObject({ outcome: 'auth_invalid' });
  });

  it('reports validation errors to an authenticated caller', async () => {
    const { status, body, log } = await deliver({ ...alert, action: 'HOLD' }, 'authorized');
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'action must be BUY or SELL' });
    expect(log[0]).toMatchObject({
      outcome: 'validation_failed',
      detail: 'action must be BUY or SELL',
    });
  });

  it('answers before TradingView gives up when the database call times out', async () => {
    const timeout = Object.assign(new Error('signal timed out'), { name: 'TimeoutError' });
    const { status, body, log } = await deliver(alert, timeout);
    expect(status).toBe(503);
    expect(body).toEqual({ error: 'Signal not confirmed in time; it may still record' });
    expect(log[0]).toMatchObject({ outcome: 'db_timeout', event_id: alert.event_id });
  });

  it('answers 500, never 2xx, when the database call fails', async () => {
    const { status, log } = await deliver(alert, new Error('ingest_tradingview_signal 503'));
    expect(status).toBe(500);
    expect(log[0]).toMatchObject({ outcome: 'db_error', detail: expect.stringContaining('503') });
  });

  it.each([
    [{ ...alert, secret_token: undefined }, 'auth_missing', 401],
    ['not json', 'bad_json', 400],
  ])('ends %j as %s without touching the database', async (body, outcome, code) => {
    const { status, ingest, log } = await deliver(body);
    expect(status).toBe(code);
    expect(ingest).not.toHaveBeenCalled();
    expect(log[0]).toMatchObject({ outcome });
  });

  it('refuses non-POST methods', async () => {
    const { status, log } = await deliver(null, 'accepted', 'GET');
    expect(status).toBe(405);
    expect(log[0]).toMatchObject({ outcome: 'method_not_allowed' });
  });

  it('never logs the secret token', async () => {
    for (const answer of ['accepted', 'unauthorized', new Error('boom')] as const) {
      const { log } = await deliver(alert, answer);
      expect(JSON.stringify(log)).not.toContain('tok-secret');
    }
  });
});
