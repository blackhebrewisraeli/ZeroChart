import { atr, macd, rsi, sma, type MacdResult } from './indicators';
import { computeBacktest, type BacktestOptions, type BacktestResult } from './backtestManager';

export type FinanceRequest =
  | { kind: 'sma'; values: number[]; period: number }
  | { kind: 'rsi'; values: number[]; period: number }
  | { kind: 'macd'; values: number[]; fast: number; slow: number; signalPeriod: number }
  | { kind: 'atr'; highs: number[]; lows: number[]; closes: number[]; period: number }
  | ({ kind: 'backtest' } & BacktestOptions);

export type FinanceResult = Float64Array | MacdResult | BacktestResult;

/** Dispatches a request to the matching pure core function. */
export function computeFinance(request: FinanceRequest): FinanceResult {
  switch (request.kind) {
    case 'sma':
      return sma(request.values, request.period);
    case 'rsi':
      return rsi(request.values, request.period);
    case 'macd':
      return macd(request.values, request.fast, request.slow, request.signalPeriod);
    case 'atr':
      return atr(request.highs, request.lows, request.closes, request.period);
    case 'backtest':
      return computeBacktest(request);
  }
}

/** Deterministic cache key for a request (enables O(1) Map lookups). */
export function cacheKey(request: FinanceRequest): string {
  return JSON.stringify(request);
}

/** In-memory request cache used inside the Web Worker. */
export class FinanceCache {
  private store = new Map<string, FinanceResult>();

  get(key: string): FinanceResult | undefined {
    return this.store.get(key);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  set(key: string, value: FinanceResult): void {
    this.store.set(key, value);
  }

  get size(): number {
    return this.store.size;
  }
}

/** Computes a result, returning the cached value when the inputs are identical. */
export function computeWithCache(
  request: FinanceRequest,
  cache: FinanceCache,
): { value: FinanceResult; cached: boolean } {
  const key = cacheKey(request);
  const cached = cache.get(key);
  if (cached !== undefined) return { value: cached, cached: true };

  const value = computeFinance(request);
  cache.set(key, value);
  return { value, cached: false };
}
