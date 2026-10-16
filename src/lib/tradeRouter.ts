import { toDisplayTicker } from '@/lib/binance';

export type TradeableAssetType = 'crypto' | 'stock';

/**
 * Returns a direct broker/market URL for executing a trade on the given asset.
 * Crypto routes to Binance's spot trading page (USDT pair); stocks route to
 * eToro's market page as a universal fallback.
 */
export function getBrokerUrl(ticker: string, assetType: TradeableAssetType): string {
  if (assetType === 'crypto') {
    const base = toDisplayTicker(ticker);
    return `https://www.binance.com/en/trade/${base}_USDT`;
  }
  const symbol = ticker
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return `https://www.etoro.com/markets/${symbol.toLowerCase()}`;
}
