// Pure Binance → assets_status mapping: no Deno or Supabase imports, so vitest
// covers it from src/test.

/** The scanner's crypto rows ('BTC-USD', ...), each quoted from its Binance USDT pair. */
export const BASES = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA'] as const;

export const BINANCE_URL =
  'https://api.binance.com/api/v3/ticker/price?symbols=' +
  encodeURIComponent(JSON.stringify(BASES.map((base) => `${base}USDT`)));

export interface QuoteRow {
  ticker: string;
  current_price: number;
  updated_at: string;
}

/** Binance's `[{symbol, price}]` as assets_status rows; missing or non-positive prices are dropped. */
export function toRows(body: unknown, now = new Date()): QuoteRow[] {
  // A Binance error ({code, msg}, e.g. 451 from a restricted region) is not an array.
  if (!Array.isArray(body)) return [];
  const rows: QuoteRow[] = [];
  for (const base of BASES) {
    const price = Number(body.find((quote) => quote?.symbol === `${base}USDT`)?.price);
    if (price > 0 && Number.isFinite(price)) {
      rows.push({ ticker: `${base}-USD`, current_price: price, updated_at: now.toISOString() });
    }
  }
  return rows;
}
