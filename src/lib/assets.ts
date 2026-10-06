import { supabase } from '@/lib/supabase';

export type Signal = 'Green' | 'Yellow' | 'Red';
export interface AssetStatus {
  ticker: string; name: string | null; current_price: number | null;
  stable_signal: string | null; radar_signal: string | null;
  stable_explanation: string | null; radar_explanation: string | null;
  risk_pct: number | null; updated_at?: string | null;
}
export type Asset = AssetStatus;

export async function fetchAssets(): Promise<Asset[]> {
  const assets: Asset[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase.from('assets_status').select('*').order('ticker').range(offset, offset + pageSize - 1).abortSignal(AbortSignal.timeout(15000));
    if (error) throw new Error(error.message);
    assets.push(...((data ?? []) as AssetStatus[]));
    if (data.length < pageSize) return assets;
  }
}

export function formatPrice(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: value > 0 && value < 1 ? 4 : 2 }).format(value);
}

export function formatRisk(value: number | null) {
  return value === null || !Number.isFinite(value) ? '—' : `${value.toFixed(1)}%`;
}

export const sampleAssets: Asset[] = [
  ['BTC', 'Bitcoin', 67432.80, 'Green', 'Green', 3.2, 'Institutional accumulation and limited supply support a strong long-term outlook.', 'Consolidation near support offers an asymmetric entry with defined downside.'],
  ['ETH', 'Ethereum', 3521.45, 'Green', 'Yellow', 5.8, 'Growing network utility and staking demand reinforce the long-term thesis.', 'Wait for a confirmed breakout as near-term momentum remains mixed.'],
  ['SOL', 'Solana', 172.68, 'Yellow', 'Green', 8.4, 'Strong ecosystem growth is balanced by elevated valuation and network risk.', 'Relative strength and rising activity point to a potential swing opportunity.'],
  ['NVDA', 'NVIDIA', 124.58, 'Green', 'Yellow', 4.6, 'Sustained AI infrastructure demand supports durable earnings growth.', 'Extended positioning suggests patience before initiating a new swing trade.'],
  ['AAPL', 'Apple', 228.42, 'Green', 'Red', 2.1, 'Resilient cash flow and a loyal ecosystem underpin long-term value.', 'Weak near-term momentum leaves an unfavorable risk-to-reward setup.'],
  ['TSLA', 'Tesla', 248.50, 'Red', 'Green', 9.7, 'Margin pressure and execution uncertainty weaken the long-term conviction.', 'A tactical reversal presents upside potential with a strict risk limit.'],
  ['SPY', 'S&P 500 ETF', 562.14, 'Green', 'Yellow', 1.5, 'Broad market diversification remains a solid foundation for patient investors.', 'Price near recent highs limits the immediate asymmetric opportunity.'],
  ['AVAX', 'Avalanche', 28.76, 'Yellow', 'Red', 12.3, 'Adoption is improving, but competitive pressure warrants a cautious stance.', 'Fading liquidity and weak relative strength favor staying on the sidelines.'],
  ['LINK', 'Chainlink', 14.32, 'Green', 'Green', 6.2, 'Expanding oracle adoption and tokenization partnerships strengthen fundamentals.', 'A tight consolidation and improving volume suggest a favorable swing setup.'],
].map(row => ({
  ticker: String(row[0]), name: String(row[1]), current_price: Number(row[2]),
  stable_signal: String(row[3]), radar_signal: String(row[4]), risk_pct: Number(row[5]),
  stable_explanation: String(row[6]), radar_explanation: String(row[7]), updated_at: '',
}));