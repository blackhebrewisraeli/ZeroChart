import { computeFinance, type FinanceRequest, type FinanceResult } from './financeCompute';
import type { MacdResult } from './indicators';
import type { BacktestOptions, BacktestResult } from './backtestManager';
import type { CanonicalResult, EngineCandle } from './canonicalModel';
import type { evaluateScan, MarketScan, ScanInput } from './marketScanner';

let worker: Worker | null | undefined;
let nextId = 0;
const pending = new Map<
  number,
  { resolve: (value: FinanceResult) => void; reject: (reason: unknown) => void }
>();

function getWorker(): Worker | null {
  // Non-worker environments (e.g. jsdom tests) fall back to synchronous math.
  if (typeof Worker === 'undefined') return null;

  if (worker === undefined) {
    worker = new Worker(new URL('./finance.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent) => {
      const { id, result, error } = event.data as {
        id: number;
        result?: FinanceResult;
        error?: string;
      };
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (error) entry.reject(new Error(error));
      else entry.resolve(result as FinanceResult);
    };
  }
  return worker;
}

function request<T extends FinanceResult>(request: FinanceRequest): Promise<T> {
  const w = getWorker();
  if (!w) {
    return Promise.resolve(computeFinance(request) as T);
  }
  return new Promise<T>((resolve, reject) => {
    const id = nextId;
    nextId += 1;
    pending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
    });
    w.postMessage({ id, request });
  });
}

/** Async, worker-backed SMA (cached in the worker). */
export function smaAsync(values: number[], period: number): Promise<Float64Array> {
  return request<Float64Array>({ kind: 'sma', values, period });
}

/** Async, worker-backed RSI (cached in the worker). */
export function rsiAsync(values: number[], period = 14): Promise<Float64Array> {
  return request<Float64Array>({ kind: 'rsi', values, period });
}

/** Async, worker-backed MACD (cached in the worker). */
export function macdAsync(
  values: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): Promise<MacdResult> {
  return request<MacdResult>({ kind: 'macd', values, fast, slow, signalPeriod });
}

/** Async, worker-backed ATR (cached in the worker). */
export function atrAsync(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14,
): Promise<Float64Array> {
  return request<Float64Array>({ kind: 'atr', highs, lows, closes, period });
}

/** Async, worker-backed backtest (cached in the worker). */
export function computeBacktestAsync(options: BacktestOptions): Promise<BacktestResult> {
  return request<BacktestResult>({ kind: 'backtest', ...options });
}

/** Async, worker-backed canonical engine pass over a candle series (cached in the worker). */
export function evaluateCandlesAsync(candles: readonly EngineCandle[]): Promise<CanonicalResult> {
  return request<CanonicalResult>({ kind: 'canonical', candles });
}

/** Async, worker-backed scoring and ranking of a collected market scan. */
export function evaluateScanAsync(
  inputs: readonly ScanInput[],
  options: Parameters<typeof evaluateScan>[1],
): Promise<MarketScan> {
  return request<MarketScan>({ kind: 'marketScan', inputs, options });
}
