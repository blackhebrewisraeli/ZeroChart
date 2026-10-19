/**
 * Canonical ticker classification (M1-T4, F-3.2d).
 *
 * Every asset-class decision in the app — Binance symbol mapping, WebSocket
 * subscription, live-price merge, broker routing, freshness policy — must go
 * through this module so an equity ticker can never collide with a crypto
 * market (e.g. the old `toBinanceSymbol('AAPL') → 'AAPLUSDT'` footgun that
 * mapped equities onto bogus USDT pairs).
 */

export type TickerKind = 'crypto' | 'forex' | 'equity';

/**
 * Bare crypto tickers used by sample/preview data that omit the `-USD`
 * suffix. Anything not in this set (and without a `-USD` suffix) is an equity
 * — unknown bare tickers must never be treated as tradable crypto pairs.
 */
const BARE_CRYPTO_TICKERS = new Set([
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
 * Exact quote-suffixed crypto form: `<BASE>-USD` or `<BASE>-USDT`. Matching the
 * whole symbol (not `includes('-USD')`) keeps look-alikes such as `FOO-USDX`
 * or `X-USD-B` out of the crypto class.
 */
const CRYPTO_PAIR = /^([A-Z0-9]+)-USDT?$/;

/** Forex tickers use the Yahoo-style `=X` suffix (e.g. `EURUSD=X`). */
const FOREX_SUFFIX = '=X';

function normalize(ticker: string): string {
  return ticker.trim().toUpperCase();
}

/**
 * Classifies an app ticker into exactly one asset kind. Precedence is
 * forex → crypto (suffixed pair or known bare ticker) → equity, so every
 * input maps to one and only one kind.
 */
export function classifyTicker(ticker: string): TickerKind {
  const symbol = normalize(ticker);
  if (symbol.endsWith(FOREX_SUFFIX) && symbol.length > FOREX_SUFFIX.length) return 'forex';
  if (CRYPTO_PAIR.test(symbol)) return 'crypto';
  if (BARE_CRYPTO_TICKERS.has(symbol)) return 'crypto';
  return 'equity';
}

/** Base asset of a crypto ticker ('BTC-USD' → 'BTC', 'BTC' → 'BTC'); null otherwise. */
export function cryptoBase(ticker: string): string | null {
  if (classifyTicker(ticker) !== 'crypto') return null;
  const symbol = normalize(ticker);
  return CRYPTO_PAIR.exec(symbol)?.[1] ?? symbol;
}

/** A short human-friendly label for a ticker ('BTC-USD' → 'BTC'). */
export function toDisplayTicker(ticker: string): string {
  return cryptoBase(ticker) ?? normalize(ticker);
}

/**
 * Maps an app ticker to its Binance USDT market symbol — ONLY for crypto.
 * Forex and equities return null so callers can never subscribe to, stream,
 * or merge a bogus pair (F-3.2d collision guard).
 */
export function toBinanceSymbol(ticker: string): string | null {
  const base = cryptoBase(ticker);
  return base === null ? null : `${base}USDT`;
}

/** Whether a ticker represents a crypto asset that Binance can stream/chart. */
export function isBinanceCrypto(ticker: string): boolean {
  return classifyTicker(ticker) === 'crypto';
}
