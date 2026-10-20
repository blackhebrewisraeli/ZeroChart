// Pure Binance → assets_status mapping: no Deno or Supabase imports, so vitest
// covers it from src/test.

/** The scanner's crypto rows ('BTC-USD', ...), each quoted from its Binance USDT pair. */
export const BASES = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA'] as const;

export const BINANCE_URL =
  'https://api.binance.com/api/v3/ticker/24hr?type=MINI&symbols=' +
  encodeURIComponent(JSON.stringify(BASES.map((base) => `${base}USDT`)));

export interface QuoteRow {
  ticker: string;
  current_price: number;
  /** A fraction, as the app reads it (0.012 is +1.2%). */
  change_24h: number | null;
  updated_at: string;
}

/** price / reference − 1, or null without a usable reference price. */
export const changeFrom = (price: number, reference: number): number | null =>
  reference > 0 && Number.isFinite(reference) ? price / reference - 1 : null;

/**
 * Binance's rolling 24h `[{symbol, lastPrice, openPrice}]` as assets_status
 * rows; missing or non-positive prices are dropped. change_24h runs from the
 * price 24 hours ago, like the app's live WebSocket ticks.
 */
export function toRows(body: unknown, now = new Date()): QuoteRow[] {
  // A Binance error ({code, msg}, e.g. 451 from a restricted region) is not an array.
  if (!Array.isArray(body)) return [];
  const rows: QuoteRow[] = [];
  for (const base of BASES) {
    const quote = body.find((candidate) => candidate?.symbol === `${base}USDT`);
    const price = Number(quote?.lastPrice);
    if (price > 0 && Number.isFinite(price)) {
      rows.push({
        ticker: `${base}-USD`,
        current_price: price,
        change_24h: changeFrom(price, Number(quote?.openPrice)),
        updated_at: now.toISOString(),
      });
    }
  }
  return rows;
}
