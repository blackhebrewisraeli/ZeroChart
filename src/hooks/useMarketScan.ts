import { useQuery } from '@tanstack/react-query';
import { fetchHistoricalCandles } from '@/lib/binance';
import { CANONICAL_MODEL_VERSION } from '@/lib/canonicalModel';
import { BINANCE_DAILY_CANDLE_POLICY_VERSION } from '@/lib/candleValidation';
import { evaluateScanAsync } from '@/lib/financeClient';
import {
  collectScanInputs,
  SCAN_CANDLE_REQUEST,
  SCAN_TIMEFRAME,
  SCANNER_VERSION,
  scanUniverse,
} from '@/lib/marketScanner';

/** Same cadence as useCanonicalScores: daily candles only change once a day. */
const STALE_MS = 5 * 60_000;
/** Re-scan a page left open so it rolls over the 00:00 UTC daily close. */
const REFETCH_MS = 15 * 60_000;

/**
 * One scan of the Markets universe through the canonical engine. The query's
 * `dataUpdatedAt` is the last completed scan; a failed re-scan keeps it.
 */
export function useMarketScan(tickers: readonly string[], universeSource: string) {
  const members = scanUniverse(tickers);
  return useQuery({
    queryKey: [
      'market-scan',
      SCANNER_VERSION,
      CANONICAL_MODEL_VERSION,
      BINANCE_DAILY_CANDLE_POLICY_VERSION,
      universeSource,
      members,
    ],
    queryFn: async () => {
      // Taken before the first request, so a candle that closes mid-scan stays open.
      const evaluationTime = Date.now();
      // No equity provider here: its credential could only live server-side.
      const inputs = await collectScanInputs(
        members,
        { crypto: (ticker) => fetchHistoricalCandles(ticker, SCAN_TIMEFRAME, SCAN_CANDLE_REQUEST) },
        { evaluationTime },
      );
      return evaluateScanAsync(inputs, { evaluationTime, universeSource });
    },
    enabled: members.length > 0,
    staleTime: STALE_MS,
    refetchInterval: REFETCH_MS,
  });
}
