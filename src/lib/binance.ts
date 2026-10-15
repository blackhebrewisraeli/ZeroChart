/**
 * Binance market-data helpers shared by the WebSocket price stream and the
 * historical-chart REST fetcher. Kept in one place so ticker -> Binance symbol
 * mapping stays consistent across the app.
 */

// Bare crypto tickers used by sample/preview data that omit the `-USD` suffix.
const BARE_CRYPTO = new Set([
  'BTC',
  'ETH',
  'SOL',
  'AVAX',
  'LINK',
  'BNB',
  'XRP',
  'ADA',
  'DOGE',
  'DOT',
  'MATIC',
  'LTC',
]);

/**
 * Maps an app ticker to its Binance USDT market symbol:
 *   'BTC-USD' -> 'BTCUSDT', 'BTC' -> 'BTCUSDT'.
 * Forex (`=X`) returns null. Note: stocks also resolve here (e.g. 'AAPL' ->
 * 'AAPLUSDT'), so callers that need a real Binance pair should gate on
 * `isBinanceCrypto` first.
 */
export function toBinanceSymbol(ticker: string): string | null {
  const symbol = ticker.trim().toUpperCase();
  if (!symbol || symbol.endsWith('=X')) return null;
  const base = symbol.endsWith('-USD') ? symbol.slice(0, -4) : symbol;
  return `${base}USDT`;
}

/** A short human-friendly label for a ticker ('BTC-USD' -> 'BTC'). */
export function toDisplayTicker(ticker: string): string {
  return ticker.trim().toUpperCase().replace(/-USD$/, '');
}

/**
 * Whether a ticker represents a crypto asset that Binance can stream/chart.
 * Forex and stocks are excluded so we never hit the REST API with a bogus pair.
 */
export function isBinanceCrypto(ticker: string): boolean {
  const symbol = ticker.trim().toUpperCase();
  if (!symbol || symbol.endsWith('=X')) return false;
  if (symbol.includes('-USD')) return true;
  return BARE_CRYPTO.has(symbol);
}

export interface Kline {
  /** Open time in milliseconds since epoch. */
  timestamp: number;
  /** Closing price for the interval. */
  close: number;
}

/** A full OHLC candle for a single interval. */
export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

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
  if (!Array.isArray(raw)) return [];
  const result: Candle[] = [];
  for (const row of raw) {
    if (!Array.isArray(row)) continue;
    const timestamp = Number(row[0]);
    const open = Number.parseFloat(String(row[1]));
    const high = Number.parseFloat(String(row[2]));
    const low = Number.parseFloat(String(row[3]));
    const close = Number.parseFloat(String(row[4]));
    if (
      !Number.isFinite(timestamp) ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close)
    ) {
      continue;
    }
    result.push({ timestamp, open, high, low, close });
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

/**
 * Fetches one year (365 days) of daily candles for a crypto asset from
 * Binance's public REST API. Returns an empty array for non-crypto tickers
 * without making a network request.
 */
export async function fetchYearlyKlines(ticker: string): Promise<Kline[]> {
  return fetchHistoricalKlines(ticker, '1d', 365);
}
