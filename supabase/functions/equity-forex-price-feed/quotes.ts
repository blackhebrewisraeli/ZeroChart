// Pure Yahoo Finance → assets_status mapping: no Deno or Supabase imports, so
// vitest covers it from src/test.
import { classifyTicker } from '../../../src/lib/ticker.ts';
import type { QuoteRow } from '../crypto-price-feed/prices.ts';

// The spark endpoint refuses more than 20 symbols per request.
const BATCH = 20;

/**
 * Spark URLs for the equity and forex tickers. They are already Yahoo symbols
 * (the archived scanner used yfinance); crypto stays with crypto-price-feed.
 */
export function sparkUrls(tickers: string[]): string[] {
  const symbols = tickers.filter((ticker) => classifyTicker(ticker) !== 'crypto');
  const urls: string[] = [];
  for (let i = 0; i < symbols.length; i += BATCH) {
    urls.push(
      'https://query1.finance.yahoo.com/v7/finance/spark?range=1d&interval=1d&symbols=' +
        encodeURIComponent(symbols.slice(i, i + BATCH).join(',')),
    );
  }
  return urls;
}

/**
 * One spark body as assets_status rows; missing or non-positive quotes are
 * dropped. updated_at is the quote's regularMarketTime, not now: a closed
 * market keeps its last-close time, so check_paper_transaction's 2-hour age
 * check refuses fills until the market reopens.
 */
export function toRows(body: unknown): QuoteRow[] {
  // A rejected request ({spark: {result: null, error}}) has no result array.
  const results = (body as { spark?: { result?: unknown } } | null)?.spark?.result;
  if (!Array.isArray(results)) return [];
  const rows: QuoteRow[] = [];
  for (const result of results) {
    const meta = result?.response?.[0]?.meta;
    const price = Number(meta?.regularMarketPrice);
    const time = Number(meta?.regularMarketTime);
    if (
      typeof result?.symbol === 'string' &&
      Number.isFinite(price) &&
      Number.isFinite(time) &&
      price > 0 &&
      time > 0
    ) {
      rows.push({
        ticker: result.symbol,
        current_price: price,
        updated_at: new Date(time * 1000).toISOString(),
      });
    }
  }
  return rows;
}
