/**
 * One Telegram Bot API sendMessage call, classified for at-most-once delivery:
 * only an answer Telegram actually gave is DELIVERED or REJECTED; anything that
 * might have reached Telegram without an answer (timeout, dropped connection,
 * unreadable reply) is UNKNOWN and must never be resent automatically.
 */
export type TransportResult =
  | { status: 'DELIVERED'; messageId: string }
  | { status: 'REJECTED'; httpStatus: number; description: string }
  | {
      status: 'UNKNOWN';
      reason: 'TIMEOUT' | 'NETWORK_ERROR' | 'SERVER_ERROR' | 'UNREADABLE_RESPONSE';
    };

export interface NotificationTransport {
  readonly channel: string;
  send(text: string): Promise<TransportResult>;
}

export const TELEGRAM_TOKEN_ENV = 'ZEROCHART_TELEGRAM_BOT_TOKEN';
export const TELEGRAM_CHAT_ENV = 'ZEROCHART_TELEGRAM_CHAT_ID';

export function telegramTransport(options: {
  token: string;
  chatId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): NotificationTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  // The token is part of the URL; nothing this adapter returns may contain it.
  const redact = (text: string) => text.replaceAll(options.token, '[redacted]').slice(0, 200);
  return {
    channel: 'telegram',
    async send(text) {
      let response: Response;
      try {
        response = await fetchImpl(`https://api.telegram.org/bot${options.token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: options.chatId, text, disable_web_page_preview: true }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
        });
      } catch (error) {
        const name = (error as Error | undefined)?.name;
        return {
          status: 'UNKNOWN',
          reason: name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR',
        };
      }
      // A 5xx (often a gateway) may follow a message Telegram already accepted.
      if (response.status >= 500) return { status: 'UNKNOWN', reason: 'SERVER_ERROR' };
      let body: { ok?: unknown; description?: unknown; result?: { message_id?: unknown } };
      try {
        body = (await response.json()) as typeof body;
      } catch {
        return response.ok
          ? { status: 'UNKNOWN', reason: 'UNREADABLE_RESPONSE' }
          : {
              status: 'REJECTED',
              httpStatus: response.status,
              description: 'Unreadable error body',
            };
      }
      if (response.ok && body.ok === true && body.result?.message_id !== undefined) {
        return { status: 'DELIVERED', messageId: String(body.result.message_id) };
      }
      if (!response.ok || body.ok === false) {
        return {
          status: 'REJECTED',
          httpStatus: response.status,
          description: redact(
            typeof body.description === 'string' ? body.description : 'No description',
          ),
        };
      }
      return { status: 'UNKNOWN', reason: 'UNREADABLE_RESPONSE' };
    },
  };
}

/** The transport configured in the environment; refuses rather than guessing a recipient. */
export function telegramTransportFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): NotificationTransport {
  const token = env[TELEGRAM_TOKEN_ENV];
  const chatId = env[TELEGRAM_CHAT_ENV];
  if (!token || !chatId) {
    throw new Error(`Telegram notifications need ${TELEGRAM_TOKEN_ENV} and ${TELEGRAM_CHAT_ENV}`);
  }
  return telegramTransport({ token, chatId });
}
