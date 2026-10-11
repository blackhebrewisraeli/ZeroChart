import { supabase } from '@/lib/supabase';

export type Signal = 'Green' | 'Yellow' | 'Red';
export interface AssetStatus {
  ticker: string; name: string | null; current_price: number | null;
  stable_signal: string | null; radar_signal: string | null;
  stable_explanation: string | null; radar_explanation: string | null;
  risk_pct: number | null; reward_pct: number | null; volume_spike: number | null;
  rsi_14: number | null; sma_50: number | null; sma_200: number | null; updated_at?: string | null;
}
export type Asset = AssetStatus;

export async function fetchAssets(): Promise<Asset[]> {
  const assets: Asset[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase.from('assets_status').select('ticker,current_price,stable_signal,stable_explanation,radar_signal,radar_explanation,risk_pct,reward_pct,volume_spike,rsi_14,sma_50,sma_200,updated_at').order('ticker').range(offset, offset + pageSize - 1).abortSignal(AbortSignal.timeout(15000));
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
  return value === null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(1)}%`;
}

export function formatReward(value: number | null) {
  return value === null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(1)}%`;
}

export function formatVolume(value: number | null) {
  return value === null || !Number.isFinite(value) ? '—' : `${value.toFixed(1)}x`;
}

export function formatRsi(value: number | null) {
  return value === null || !Number.isFinite(value) ? '—' : value.toFixed(1);
}

export function formatTradingViewSymbol(ticker: string) {
  const symbol = ticker.trim();
  if (symbol.toUpperCase().endsWith('=X')) {
    return `FX:${symbol.slice(0, -2).toUpperCase()}`;
  }
  if (symbol.toUpperCase().includes('-USD')) {
    return `CRYPTO:${symbol.toUpperCase().replace('-USD', 'USD')}`;
  }
  return symbol;
}

export const sampleAssets: Asset[] = [
  ['BTC', 'Bitcoin', 67432.80, 'Green', 'Green', 0.032, 0.052, 1.8, 58.3, 65300, 59800, 'Institutional accumulation and limited supply support a strong long-term outlook.', 'Consolidation near support offers an asymmetric entry with defined downside.'],
  ['ETH', 'Ethereum', 3521.45, 'Green', 'Yellow', 0.058, 0.038, 1.2, 46.9, 3580, 3300, 'Growing network utility and staking demand reinforce the long-term thesis.', 'Wait for a confirmed breakout as near-term momentum remains mixed.'],
  ['SOL', 'Solana', 172.68, 'Yellow', 'Green', 0.084, 0.074, 2.6, 71.4, 165, 150, 'Strong ecosystem growth is balanced by elevated valuation and network risk.', 'Relative strength and rising activity point to a potential swing opportunity.'],
  ['NVDA', 'NVIDIA', 124.58, 'Green', 'Yellow', 0.046, 0.041, 1.4, 63.0, 120, 110, 'Sustained AI infrastructure demand supports durable earnings growth.', 'Extended positioning suggests patience before initiating a new swing trade.'],
  ['AAPL', 'Apple', 228.42, 'Green', 'Red', 0.021, 0.018, 0.9, 27.8, 232, 220, 'Resilient cash flow and a loyal ecosystem underpin long-term value.', 'Weak near-term momentum leaves an unfavorable risk-to-reward setup.'],
  ['TSLA', 'Tesla', 248.50, 'Red', 'Green', 0.097, 0.089, 2.1, 52.1, 245, 230, 'Margin pressure and execution uncertainty weaken the long-term conviction.', 'A tactical reversal presents upside potential with a strict risk limit.'],
  ['SPY', 'S&P 500 ETF', 562.14, 'Green', 'Yellow', 0.015, 0.012, 1.0, 60.5, 555, 540, 'Broad market diversification remains a solid foundation for patient investors.', 'Price near recent highs limits the immediate asymmetric opportunity.'],
  ['AVAX', 'Avalanche', 28.76, 'Yellow', 'Red', 0.123, 0.067, 1.7, 38.2, 30, 27, 'Adoption is improving, but competitive pressure warrants a cautious stance.', 'Fading liquidity and weak relative strength favor staying on the sidelines.'],
  ['LINK', 'Chainlink', 14.32, 'Green', 'Green', 0.062, 0.058, 2.3, 65.7, 13.9, 12.8, 'Expanding oracle adoption and tokenization partnerships strengthen fundamentals.', 'A tight consolidation and improving volume suggest a favorable swing setup.'],
].map(row => ({
  ticker: String(row[0]), name: String(row[1]), current_price: Number(row[2]),
  stable_signal: String(row[3]), radar_signal: String(row[4]), risk_pct: Number(row[5]),
  reward_pct: Number(row[6]), volume_spike: Number(row[7]),
  rsi_14: Number(row[8]), sma_50: Number(row[9]), sma_200: Number(row[10]),
  stable_explanation: String(row[11]), radar_explanation: String(row[12]), updated_at: '',
}));
