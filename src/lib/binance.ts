import { isBinanceCrypto, toBinanceSymbol } from '@/lib/ticker';

export { isBinanceCrypto, toBinanceSymbol, toDisplayTicker } from '@/lib/ticker';

/**
 * Binance market-data helpers shared by the WebSocket price stream and the
 * historical-chart REST fetcher. Ticker classification and symbol mapping
 * live in the canonical `@/lib/ticker` module (M1-T4, F-3.2d) — this module
 * only handles kline parsing and fetching, and re-exports the shared mapping
 * helpers so existing imports keep working.
 */

export interface Kline {
  /** Open time in milliseconds since epoch. */
  timestamp: number;
  /** Closing price for the interval. */
  close: number;
}

/** A full OHLC candle for a single interval. */
export interface Candle {
  timestamp: number;
  /** Binance close time (raw kline field 6), in epoch milliseconds. */
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export class CandleProviderDataError extends Error {}

/**
 * Parses the raw klines array returned by Binance into `{ timestamp, close }`
 * points, dropping any malformed rows.
 */
export function parseKlines(raw: unknown): Kline[] {
  if (!Array.isArray(raw)) return [];
  const result: Kline[] = [];
  for (const row of raw) {
    if (!Array.isArray(row)) continue;
    const timestamp = Number(row[0]);
    const close = Number.parseFloat(String(row[4]));
    if (!Number.isFinite(timestamp) || !Number.isFinite(close)) continue;
    result.push({ timestamp, close });
  }
  return result;
}

/**
 * Parses the raw klines array returned by Binance into full OHLC candles,
 * dropping any malformed rows.
 */
export function parseCandles(raw: unknown): Candle[] {
  if (!Array.isArray(raw))
    throw new CandleProviderDataError('Binance klines response is not an array');
  const result: Candle[] = [];
  for (const [index, row] of raw.entries()) {
    if (!Array.isArray(row))
      throw new CandleProviderDataError(`Binance kline row ${index} is not an array`);
    const timestamp = Number(row[0]);
    const open = Number.parseFloat(String(row[1]));
    const high = Number.parseFloat(String(row[2]));
    const low = Number.parseFloat(String(row[3]));
    const close = Number.parseFloat(String(row[4]));
    const closeTime = Number(row[6]);
    if (
      !Number.isFinite(timestamp) ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      !Number.isFinite(closeTime)
    ) {
      throw new CandleProviderDataError(
        `Binance kline row ${index} contains a malformed OHLC or timestamp field`,
      );
    }
    result.push({ timestamp, closeTime, open, high, low, close });
  }
  return result;
}

/** Fetches raw klines JSON from Binance's public REST API. */
async function fetchRawKlines(ticker: string, interval: string, limit: number): Promise<unknown> {
  const symbol = toBinanceSymbol(ticker);
  if (!symbol) return [];
  const url =
    'https://api.binance.com/api/v3/klines' +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&limit=${encodeURIComponent(String(limit))}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) {
    throw new Error(`Binance klines request failed with status ${response.status}`);
  }
  return response.json();
}

/**
 * Fetches daily historical candles for a crypto asset from Binance's public
 * REST API. Returns an empty array for non-crypto tickers without making a
 * network request.
 */
export async function fetchHistoricalKlines(
  ticker: string,
  interval = '1d',
  limit = 30,
): Promise<Kline[]> {
  if (!isBinanceCrypto(ticker)) return [];
  return parseKlines(await fetchRawKlines(ticker, interval, limit));
}

/**
 * Fetches OHLC candles (default daily) for a crypto asset, for the
 * lightweight-charts candlestick chart.
 */
export async function fetchHistoricalCandles(
  ticker: string,
  interval = '1d',
  limit = 30,
): Promise<Candle[]> {
  if (!isBinanceCrypto(ticker)) return [];
  return parseCandles(await fetchRawKlines(ticker, interval, limit));
}
