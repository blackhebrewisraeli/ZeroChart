import { supabase } from '@/lib/supabaseClient';
import { classifyTicker } from '@/lib/ticker';
import { toTradingViewSymbol } from '@/lib/tradingViewSymbol';

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
  change_24h: number | null;
  updated_at?: string | null;
  /** Daily market-analytics ATR(14); the paper risk book's stop when it is under 48h old. */
  atr_14?: number | null;
  analytics_updated_at?: string | null;
}
export type Asset = AssetStatus;

export async function fetchAssets(): Promise<Asset[]> {
  const assets: Asset[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase
      .from('assets_status')
      .select(
        'ticker,current_price,change_24h,stable_signal,stable_explanation,radar_signal,radar_explanation,risk_pct,reward_pct,volume_spike,rsi_14,sma_50,sma_200,updated_at,atr_14,analytics_updated_at',
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

export function formatPnl(value: number) {
  let sign = '';
  if (value > 0) sign = '+';
  else if (value < 0) sign = '-';
  return `${sign}${formatPrice(Math.abs(value))}`;
}

export function formatSignedPercent(value: number) {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

export function pnlTone(value: number): 'pnl-up' | 'pnl-down' | undefined {
  if (value > 0) return 'pnl-up';
  if (value < 0) return 'pnl-down';
  return undefined;
}

/** Signal Score pill class: above 85 high, 70-85 mid, below 70 low. */
export function scoreTone(score: number | null) {
  if (score === null) return '';
  if (score > 85) return 'score-high';
  if (score >= 70) return 'score-mid';
  return 'score-low';
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

/** TradingView symbol — delegated to the canonical mapper (F-3.2d). */
export function formatTradingViewSymbol(ticker: string) {
  return toTradingViewSymbol(ticker);
}

export type AssetClass = 'Crypto' | 'Forex' | 'Stocks';

/**
 * Legacy display-facing class labels, delegated to the canonical
 * `classifyTicker` (M1-T4, F-3.2d) so bare crypto tickers like `BTC`
 * classify as Crypto (they previously fell through to Stocks).
 */
export function getAssetClass(ticker: string): AssetClass {
  const kind = classifyTicker(ticker);
  if (kind === 'crypto') return 'Crypto';
  if (kind === 'forex') return 'Forex';
  return 'Stocks';
}

/**
 * Builds a deterministic series of trend points for a sparkline. The series
 * ends exactly at `currentPrice`, and its first point is derived from the 24h
 * change (start < end for gains, start > end for losses). Interior points are
 * a plain linear interpolation between the two anchors — NO randomness: the
 * line is a derived visualization of the reported change, never fabricated
 * market history (M1-T2, F-3.3a). Missing price returns a zero series, and a
 * missing/invalid change falls back to a flat line at the current price.
 */
export function generateTrendData(
  currentPrice: number | null,
  change24h: number | null,
  points = 20,
): number[] {
  const end = currentPrice;
  if (end === null || !Number.isFinite(end) || end <= 0) {
    return Array.from({ length: points }, () => 0);
  }
  const change = change24h !== null && Number.isFinite(change24h) ? change24h : 0;
  const denominator = 1 + change;
  if (!Number.isFinite(denominator) || denominator <= 0) {
    return Array.from({ length: points }, () => end);
  }
  if (points <= 1) return [end];

  const start = end / denominator;
  const series: number[] = new Array(points);
  for (let i = 0; i < points; i++) {
    if (i === points - 1) {
      // Anchor the final point exactly (float-safety).
      series[i] = end;
    } else {
      series[i] = start + (end - start) * (i / (points - 1));
    }
  }
  return series;
}

export interface BrokerRoute {
  label: string;
  url: string;
}

/**
 * Broker routing keyed on the canonical `classifyTicker` (F-3.2d) — bare
 * crypto like `BTC` now routes to Binance instead of falling through to eToro.
 */
export function getBrokerRoute(ticker: string): BrokerRoute {
  const kind = classifyTicker(ticker);
  if (kind === 'crypto') {
    return { label: 'Trade on Binance', url: 'https://www.binance.com/en/markets' };
  }
  if (kind === 'forex') {
    return { label: 'Trade on OANDA', url: 'https://www.oanda.com/' };
  }
  const clean = ticker
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
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
