import { computeFinance, type FinanceRequest, type FinanceResult } from './financeCompute';
import type { AllocationWeight, AssetPriceSeries, BacktestResult } from './backtestManager';

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

/** Async, worker-backed backtest (cached in the worker). */
export function computeBacktestAsync(options: {
  weights: AllocationWeight[];
  series: AssetPriceSeries[];
  initialValue?: number;
}): Promise<BacktestResult> {
  return request<BacktestResult>({
    kind: 'backtest',
    weights: options.weights,
    series: options.series,
    initialValue: options.initialValue,
  });
}
