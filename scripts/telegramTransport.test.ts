// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { telegramTransport, telegramTransportFromEnv } from './telegramTransport';

const TOKEN = '123456:secret-bot-token';

function respond(status: number, body: unknown) {
  return vi.fn<typeof fetch>(
    async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
  );
}

function failWith(name: string) {
  return vi.fn<typeof fetch>(async () => {
    throw Object.assign(new Error(name), { name });
  });
}

describe('Telegram transport', () => {
  it('posts one sendMessage to the configured chat and reports the message ID', async () => {
    const fetchImpl = respond(200, { ok: true, result: { message_id: 42 } });
    const result = await telegramTransport({ token: TOKEN, chatId: '-100777', fetchImpl }).send(
      'hello',
    );

    expect(result).toEqual({ status: 'DELIVERED', messageId: '42' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(init?.body))).toEqual({
      chat_id: '-100777',
      text: 'hello',
      disable_web_page_preview: true,
    });
  });

  it.each([
    [
      'a rate limit',
      respond(429, { ok: false, description: 'Too Many Requests: retry after 5' }),
      { status: 'REJECTED', httpStatus: 429, description: 'Too Many Requests: retry after 5' },
    ],
    [
      'a rejection quoting the token',
      respond(401, { ok: false, description: `Unauthorized for bot${TOKEN}` }),
      { status: 'REJECTED', httpStatus: 401, description: 'Unauthorized for bot[redacted]' },
    ],
    ['a gateway error', respond(502, 'Bad Gateway'), { status: 'UNKNOWN', reason: 'SERVER_ERROR' }],
    ['a timeout', failWith('TimeoutError'), { status: 'UNKNOWN', reason: 'TIMEOUT' }],
    ['a dropped connection', failWith('TypeError'), { status: 'UNKNOWN', reason: 'NETWORK_ERROR' }],
    [
      'an unreadable success',
      respond(200, '<html>'),
      { status: 'UNKNOWN', reason: 'UNREADABLE_RESPONSE' },
    ],
  ])('classifies %s without exposing the token', async (_label, fetchImpl, expected) => {
    const result = await telegramTransport({ token: TOKEN, chatId: '1', fetchImpl }).send('x');

    expect(result).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain('secret-bot-token');
  });

  it('refuses to run without both environment variables and never echoes a value', () => {
    expect(() => telegramTransportFromEnv({ ZEROCHART_TELEGRAM_BOT_TOKEN: TOKEN })).toThrow(
      'ZEROCHART_TELEGRAM_BOT_TOKEN and ZEROCHART_TELEGRAM_CHAT_ID',
    );
    try {
      telegramTransportFromEnv({ ZEROCHART_TELEGRAM_BOT_TOKEN: TOKEN });
    } catch (error) {
      expect(String(error)).not.toContain('secret-bot-token');
    }
    expect(
      telegramTransportFromEnv({
        ZEROCHART_TELEGRAM_BOT_TOKEN: TOKEN,
        ZEROCHART_TELEGRAM_CHAT_ID: '1',
      }).channel,
    ).toBe('telegram');
  });
});
