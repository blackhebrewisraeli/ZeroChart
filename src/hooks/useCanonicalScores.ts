import { useQueries } from '@tanstack/react-query';
import { CANONICAL_MODEL_VERSION, type CanonicalResult } from '@/lib/canonicalModel';
import { scoreTicker } from '@/lib/roboAdvisor';

/** Daily candles move slowly; one engine pass per ticker per 5 minutes is plenty. */
const STALE_MS = 5 * 60_000;

type Entry = readonly [string, CanonicalResult];

// Module-level so react-query can memoize the combined Map across renders.
function toMap(results: ReadonlyArray<{ data?: Entry | undefined }>) {
  return new Map(results.flatMap((result) => (result.data ? [result.data] : [])));
}

/**
 * Canonical engine results by ticker. A ticker still loading has no entry;
 * every component asking for the same ticker shares one cached fetch.
 * ponytail: one Binance klines request per crypto ticker (weight 2 each) —
 * batch server-side if the asset table grows past a few hundred crypto rows.
 */
export function useCanonicalScores(
  tickers: readonly string[],
): ReadonlyMap<string, CanonicalResult> {
  return useQueries({
    queries: [...new Set(tickers)].map((ticker) => ({
      queryKey: ['canonical-score', CANONICAL_MODEL_VERSION, ticker],
      queryFn: async (): Promise<Entry> => [ticker, await scoreTicker(ticker)],
      staleTime: STALE_MS,
    })),
    combine: toMap,
  });
}
