// Pure daily candles → assets_status analytics, ported from the archived
// trading-agent scanner (agent.py): no Deno or Supabase imports, so vitest
// covers it from src/test.
import { rsi, sma } from '../../../src/lib/indicators.ts';
import { toBinanceSymbol } from '../../../src/lib/ticker.ts';

const RADAR_MIN_RATIO = 3;
const RADAR_MIN_VOLUME_SPIKE = 1.5;

export interface AnalyticsRow {
  ticker: string;
  rsi_14: number | null;
  sma_50: number | null;
  sma_200: number | null;
  volume_spike: number | null;
  risk_pct: number | null;
  reward_pct: number | null;
  stable_signal: 'Green' | 'Red';
  stable_explanation: string;
  radar_signal: 'Green' | 'Yellow';
  radar_explanation: string;
}

/** Daily bars, oldest first. */
interface Candles {
  close: number[];
  high: number[];
  volume: number[];
}

/**
 * A year of daily candles: Binance klines for crypto (the scanner's 'BTC-USD'
 * rows), Yahoo's chart endpoint for equities and forex, whose tickers are
 * already Yahoo symbols.
 */
export function candlesUrl(ticker: string): string {
  const binance = toBinanceSymbol(ticker);
  return binance
    ? `https://api.binance.com/api/v3/klines?interval=1d&limit=365&symbol=${binance}`
    : `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1y&interval=1d`;
}

/** One candles body as an analytics row; null when it holds no usable bar. */
export function toRow(ticker: string, body: unknown, now = Date.now()): AnalyticsRow | null {
  const candles = toBinanceSymbol(ticker) ? fromKlines(body, now) : fromChart(body);
  return candles.close.length > 0 ? analyze(ticker, candles) : null;
}

const isNum = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function push(candles: Candles, close: unknown, high: unknown, volume: unknown): void {
  if (isNum(close) && isNum(high) && isNum(volume) && close > 0) {
    candles.close.push(close);
    candles.high.push(high);
    candles.volume.push(volume);
  }
}

/**
 * Binance `[openTime, open, high, low, close, volume, closeTime, ...]` klines.
 * Today's still-open candle is dropped: its partial volume would drag the
 * 3-day volume average down.
 */
function fromKlines(body: unknown, now: number): Candles {
  const candles: Candles = { close: [], high: [], volume: [] };
  // A Binance error ({code, msg}) is not an array.
  if (!Array.isArray(body)) return candles;
  for (const kline of body) {
    if (Array.isArray(kline) && Number(kline[6]) < now) {
      push(candles, Number(kline[4]), Number(kline[2]), Number(kline[5]));
    }
  }
  return candles;
}

interface ChartBody {
  chart?: {
    result?: {
      indicators?: {
        quote?: { close?: unknown[]; high?: unknown[]; volume?: unknown[] }[];
        adjclose?: { adjclose?: unknown[] }[];
      };
    }[];
  };
}

/**
 * Yahoo's chart body, dividend-adjusted like the scanner's yfinance
 * auto_adjust: adjclose replaces close and scales high by the same factor.
 * Bars with a null field (gaps Yahoo leaves in the series) are dropped.
 */
function fromChart(body: unknown): Candles {
  const candles: Candles = { close: [], high: [], volume: [] };
  const indicators = (body as ChartBody | null)?.chart?.result?.[0]?.indicators;
  const quote = indicators?.quote?.[0];
  const adjclose = indicators?.adjclose?.[0]?.adjclose ?? quote?.close ?? [];
  adjclose.forEach((adjusted, i) => {
    const close = quote?.close?.[i];
    const high = quote?.high?.[i];
    if (isNum(adjusted) && isNum(close) && isNum(high) && close > 0) {
      push(candles, adjusted, (high * adjusted) / close, quote?.volume?.[i]);
    }
  });
  return candles;
}

const last = (values: ArrayLike<number>): number => values[values.length - 1] ?? Number.NaN;
const mean = (values: number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;
const ratio = (numerator: number, denominator: number): number =>
  denominator === 0 ? Number.NaN : numerator / denominator;
const stored = (value: number): number | null =>
  Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : null;
const times = (value: number): string => (Number.isNaN(value) ? 'n/a' : `${value.toFixed(2)}x`);

/** The 3-day average volume over the 14 days before it; NaN for forex, which trades no volume. */
function volumeSpike(volume: number[]): number {
  if (volume.length < 17) return Number.NaN;
  return ratio(mean(volume.slice(-3)), mean(volume.slice(-17, -3)));
}

type Stable = Pick<AnalyticsRow, 'stable_signal' | 'stable_explanation'>;
type Radar = Pick<AnalyticsRow, 'radar_signal' | 'radar_explanation'>;

/** Filter A, the scanner's evaluate_stable: Green when the 50-day SMA is above the 200-day SMA. */
function stable(sma50: number, sma200: number): Stable {
  if (Number.isNaN(sma50) || Number.isNaN(sma200)) {
    return {
      stable_signal: 'Red',
      stable_explanation: 'Insufficient history to compute the 50/200-day moving averages.',
    };
  }
  const smas = `The 50-day SMA (${sma50.toFixed(2)})`;
  const sma200Text = `the 200-day SMA (${sma200.toFixed(2)})`;
  return sma50 > sma200
    ? {
        stable_signal: 'Green',
        stable_explanation: `${smas} is above ${sma200Text}, confirming an upward long-term trend.`,
      }
    : {
        stable_signal: 'Red',
        stable_explanation: `${smas} is at or below ${sma200Text}, signaling a downward long-term trend.`,
      };
}

/**
 * Filter B, the scanner's evaluate_radar: Green when reward/risk >= 3, the
 * volume spike > 1.5 and the close is above its 50-day SMA, else Yellow.
 */
function radar(rewardRisk: number, spike: number, price: number, sma50: number): Radar {
  const priceAbove = price > sma50;
  const minRatio = `${RADAR_MIN_RATIO.toFixed(1)}x`;
  const minSpike = `${RADAR_MIN_VOLUME_SPIKE.toFixed(1)}x`;
  if (rewardRisk >= RADAR_MIN_RATIO && spike > RADAR_MIN_VOLUME_SPIKE && priceAbove) {
    return {
      radar_signal: 'Green',
      radar_explanation:
        `Radar triggered: reward/risk ratio is ${times(rewardRisk)} (>= ${minRatio}), ` +
        `volume spike is ${times(spike)} (> ${minSpike}), and the price ` +
        `(${price.toFixed(2)}) is above its 50-day SMA.`,
    };
  }
  return {
    radar_signal: 'Yellow',
    radar_explanation:
      `Radar not triggered: reward/risk ${times(rewardRisk)} (needs >= ${minRatio}); ` +
      `volume spike ${times(spike)} (needs > ${minSpike}); ` +
      `price vs 50-day SMA: ${priceAbove ? 'above' : 'below'}.`,
  };
}

/**
 * The scanner's analyze_ticker. Risk runs down to the 50-day SMA and reward up
 * to the 20-day high, both as fractions of the close.
 */
function analyze(ticker: string, { close, high, volume }: Candles): AnalyticsRow {
  const price = last(close);
  const sma50 = last(sma(close, 50));
  const sma200 = last(sma(close, 200));
  const spike = volumeSpike(volume);
  const riskPct = ratio(price - sma50, price);
  const rewardPct = ratio(Math.max(...high.slice(-20)) - price, price);
  return {
    ticker,
    rsi_14: stored(last(rsi(close, 14))),
    sma_50: stored(sma50),
    sma_200: stored(sma200),
    volume_spike: stored(spike),
    risk_pct: stored(riskPct),
    reward_pct: stored(rewardPct),
    ...stable(sma50, sma200),
    ...radar(ratio(rewardPct, riskPct), spike, price, sma50),
  };
}
