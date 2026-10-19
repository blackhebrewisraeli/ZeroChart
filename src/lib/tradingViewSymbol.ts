import { classifyTicker, toBinanceSymbol } from '@/lib/ticker';

/**
 * Equities known to list on NASDAQ. Any other equity stays a bare ticker,
 * which TradingView resolves to its primary listing (NYSE, ARCA, …) — a wrong
 * exchange prefix would render "invalid symbol" instead of a chart.
 */
const NASDAQ_TICKERS = new Set([
  'AAPL',
  'ADBE',
  'AMD',
  'AMZN',
  'AVGO',
  'COST',
  'CSCO',
  'GOOG',
  'GOOGL',
  'INTC',
  'META',
  'MSFT',
  'NFLX',
  'NVDA',
  'PEP',
  'QCOM',
  'TSLA',
]);

/**
 * TradingView widget symbol for any app ticker. Crypto maps onto the same
 * Binance USDT market our candles and live prices come from.
 */
export function toTradingViewSymbol(ticker: string): string {
  const symbol = ticker.trim().toUpperCase();
  const kind = classifyTicker(symbol);
  if (kind === 'forex') return `FX:${symbol.replace(/=X$/, '')}`;
  if (kind === 'crypto') return `BINANCE:${toBinanceSymbol(symbol)}`;
  return NASDAQ_TICKERS.has(symbol) ? `NASDAQ:${symbol}` : symbol;
}
