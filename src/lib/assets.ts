import { supabase } from '@/lib/supabase';

export type Signal = 'Green' | 'Yellow' | 'Red';
export interface AssetStatus {
  ticker: string;
  name: string | null;
  current_price: number | null;
  stable_signal: string | null;
  radar_signal: string | null;
  stable_explanation: string | null;
  radar_explanation: string | null;
  risk_pct: number | null;
  reward_pct: number | null;
  volume_spike: number | null;
  rsi_14: number | null;
  sma_50: number | null;
  sma_200: number | null;
  change_24h?: number | null;
  updated_at?: string | null;
}
export type Asset = AssetStatus;

export async function fetchAssets(): Promise<Asset[]> {
  const assets: Asset[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase
      .from('assets_status')
      .select(
        'ticker,current_price,stable_signal,stable_explanation,radar_signal,radar_explanation,risk_pct,reward_pct,volume_spike,rsi_14,sma_50,sma_200,updated_at',
      )
      .order('ticker')
      .range(offset, offset + pageSize - 1)
      .abortSignal(AbortSignal.timeout(15000));
    if (error) throw new Error(error.message);
    assets.push(...((data ?? []) as AssetStatus[]));
    if (data.length < pageSize) return assets;
  }
}

export function formatPrice(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: value > 0 && value < 1 ? 4 : 2,
  }).format(value);
}

export function formatRisk(value: number | null) {
  return value === null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(1)}%`;
}

export function formatReward(value: number | null) {
  return value === null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(1)}%`;
}

export function formatChange(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '—';
  const pct = value * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
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

export type AssetClass = 'Crypto' | 'Forex' | 'Stocks';

export function getAssetClass(ticker: string): AssetClass {
  const symbol = ticker.trim().toUpperCase();
  if (symbol.endsWith('=X')) return 'Forex';
  if (symbol.includes('-USD')) return 'Crypto';
  return 'Stocks';
}

export function calculateSignalScore(asset: Asset): number {
  const ratio =
    asset.reward_pct !== null &&
    asset.risk_pct !== null &&
    asset.risk_pct > 0 &&
    Number.isFinite(asset.reward_pct) &&
    Number.isFinite(asset.risk_pct)
      ? asset.reward_pct / asset.risk_pct
      : 0;
  let score = 20 * ratio + 20;
  if (asset.volume_spike !== null && asset.volume_spike > 1) score += 15;
  if (
    asset.current_price !== null &&
    asset.sma_50 !== null &&
    Number.isFinite(asset.current_price) &&
    Number.isFinite(asset.sma_50) &&
    asset.current_price > asset.sma_50
  ) {
    score += 10;
  }
  return Math.min(100, Math.max(0, Math.round(score)));
}

export interface BrokerRoute {
  label: string;
  url: string;
}

export function getBrokerRoute(ticker: string): BrokerRoute {
  const symbol = ticker.trim();
  if (symbol.toUpperCase().includes('-USD')) {
    return { label: 'Trade on Binance', url: 'https://www.binance.com/en/markets' };
  }
  if (symbol.toUpperCase().endsWith('=X')) {
    return { label: 'Trade on OANDA', url: 'https://www.oanda.com/' };
  }
  const clean = symbol.toLowerCase().replace(/[^a-z0-9]/g, '');
  return { label: 'Trade on eToro', url: `https://www.etoro.com/markets/${clean}` };
}

export const sampleAssets: Asset[] = [
  [
    'BTC',
    'Bitcoin',
    67432.8,
    'Green',
    'Green',
    0.032,
    0.052,
    1.8,
    58.3,
    65300,
    59800,
    'Institutional accumulation and limited supply support a strong long-term outlook.',
    'Consolidation near support offers an asymmetric entry with defined downside.',
    0.024,
  ],
  [
    'ETH',
    'Ethereum',
    3521.45,
    'Green',
    'Yellow',
    0.058,
    0.038,
    1.2,
    46.9,
    3580,
    3300,
    'Growing network utility and staking demand reinforce the long-term thesis.',
    'Wait for a confirmed breakout as near-term momentum remains mixed.',
    0.018,
  ],
  [
    'SOL',
    'Solana',
    172.68,
    'Yellow',
    'Green',
    0.084,
    0.074,
    2.6,
    71.4,
    165,
    150,
    'Strong ecosystem growth is balanced by elevated valuation and network risk.',
    'Relative strength and rising activity point to a potential swing opportunity.',
    0.046,
  ],
  [
    'NVDA',
    'NVIDIA',
    124.58,
    'Green',
    'Yellow',
    0.046,
    0.041,
    1.4,
    63.0,
    120,
    110,
    'Sustained AI infrastructure demand supports durable earnings growth.',
    'Extended positioning suggests patience before initiating a new swing trade.',
    -0.012,
  ],
  [
    'AAPL',
    'Apple',
    228.42,
    'Green',
    'Red',
    0.021,
    0.018,
    0.9,
    27.8,
    232,
    220,
    'Resilient cash flow and a loyal ecosystem underpin long-term value.',
    'Weak near-term momentum leaves an unfavorable risk-to-reward setup.',
    -0.006,
  ],
  [
    'TSLA',
    'Tesla',
    248.5,
    'Red',
    'Green',
    0.097,
    0.089,
    2.1,
    52.1,
    245,
    230,
    'Margin pressure and execution uncertainty weaken the long-term conviction.',
    'A tactical reversal presents upside potential with a strict risk limit.',
    -0.031,
  ],
  [
    'SPY',
    'S&P 500 ETF',
    562.14,
    'Green',
    'Yellow',
    0.015,
    0.012,
    1.0,
    60.5,
    555,
    540,
    'Broad market diversification remains a solid foundation for patient investors.',
    'Price near recent highs limits the immediate asymmetric opportunity.',
    0.004,
  ],
  [
    'AVAX',
    'Avalanche',
    28.76,
    'Yellow',
    'Red',
    0.123,
    0.067,
    1.7,
    38.2,
    30,
    27,
    'Adoption is improving, but competitive pressure warrants a cautious stance.',
    'Fading liquidity and weak relative strength favor staying on the sidelines.',
    -0.028,
  ],
  [
    'LINK',
    'Chainlink',
    14.32,
    'Green',
    'Green',
    0.062,
    0.058,
    2.3,
    65.7,
    13.9,
    12.8,
    'Expanding oracle adoption and tokenization partnerships strengthen fundamentals.',
    'A tight consolidation and improving volume suggest a favorable swing setup.',
    0.033,
  ],
].map((row) => ({
  ticker: String(row[0]),
  name: String(row[1]),
  current_price: Number(row[2]),
  stable_signal: String(row[3]),
  radar_signal: String(row[4]),
  risk_pct: Number(row[5]),
  reward_pct: Number(row[6]),
  volume_spike: Number(row[7]),
  rsi_14: Number(row[8]),
  sma_50: Number(row[9]),
  sma_200: Number(row[10]),
  stable_explanation: String(row[11]),
  radar_explanation: String(row[12]),
  change_24h: Number(row[13]),
  updated_at: '',
}));
