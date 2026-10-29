import type { Candle } from '@/lib/binance';
import type { FetchOpportunityCandles } from '../../scripts/opportunityCampaign';

const DAY_MS = 86_400_000;

/**
 * Synthetic Binance history for an Opportunity Radar campaign starting at
 * 2026-10-30 00:30 UTC: ETH qualifies from the second slot on (one false→true
 * transition), BTC keeps the market gate open, every other member declines.
 */
/** Path day 257 is the last candle slot 1 sees; slots 2 and 3 see days 258 and 259. */
const PATH_ORIGIN = Date.UTC(2026, 9, 29) - 257 * DAY_MS;

/** Daily closes compounding the given return; each candle opens at the prior close, ±h wicks. */
function compounding(dailyReturn: (day: number) => number, h: number) {
  const closes = [100];
  for (let day = 1; day < 300; day += 1) closes.push(closes[day - 1]! * (1 + dailyReturn(day)));
  return { closes, h };
}

const PATHS: Record<string, ReturnType<typeof compounding>> = {
  // A long uptrend, an 11-day 3% pullback, then a slow drift: oversold RSI with turning
  // momentum (MEAN_REVERTING, score 85), whose close crosses back above SMA(50) on day 258.
  ETHUSDT: compounding((day) => (day < 201 ? 0.006 : day < 212 ? -0.03 : 0.0001), 0.004),
  // A steady rise keeps the BTC market gate open while BTC itself never qualifies.
  BTCUSDT: compounding(() => 0.002, 0.002),
};
const DECLINING = compounding(() => -0.001, 0.002);

export function opportunityPathProvider() {
  const calls: string[] = [];
  const fetchCandles: FetchOpportunityCandles = async (instrument, request) => {
    calls.push(instrument);
    const { closes, h } = PATHS[instrument] ?? DECLINING;
    const lastDay = (request.endTime + 1 - DAY_MS - PATH_ORIGIN) / DAY_MS;
    return Array.from({ length: request.limit }, (_, index): Candle => {
      const day = lastDay - (request.limit - 1 - index);
      const timestamp = PATH_ORIGIN + day * DAY_MS;
      const close = closes[day]!;
      const open = closes[day - 1]!;
      return {
        timestamp,
        closeTime: timestamp + DAY_MS - 1,
        open,
        high: Math.max(open, close) * (1 + h),
        low: Math.min(open, close) * (1 - h),
        close,
      };
    });
  };
  return { calls, fetchCandles };
}
