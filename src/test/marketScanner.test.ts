import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CandleProviderDataError, ProviderRateLimitError, type Candle } from '@/lib/binance';
import { evaluateCandles, modelSetups, type CanonicalScore } from '@/lib/canonicalModel';
import {
  collectScanInputs,
  evaluateScan,
  SCAN_MIN_CLOSED_CANDLES,
  type ScanInput,
} from '@/lib/marketScanner';
import { qualifiesForRiskProfile } from '@/lib/portfolioBuilder';

const DAY = 86_400_000;
const TODAY = Date.UTC(2026, 9, 28);
/** Scan start: 16:50 UTC, so today's daily candle is still open. */
const NOW = TODAY + (16 * 60 + 50) * 60_000;

/**
 * Labeled fixture, not market data: `closed` Binance-convention daily candles
 * ending yesterday, plus today's still-open candle at a price no closed bar has.
 */
function series(closed: number, path: (i: number) => number, lastOpen = TODAY - DAY): Candle[] {
  const first = lastOpen - (closed - 1) * DAY;
  const bar = (i: number, close: number): Candle => ({
    timestamp: first + i * DAY,
    closeTime: first + i * DAY + DAY - 1,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
  });
  const rows = Array.from({ length: closed }, (_, i) => bar(i, path(i)));
  return lastOpen === TODAY - DAY ? [...rows, bar(closed, path(closed) * 10)] : rows;
}

const wave = (i: number) => 100 + Math.sin(i / 6) * 8;
const rising = (i: number) => 50 + i * 0.4;
const falling = (i: number) => 200 - i * 0.5;

const UNIVERSE = ['SOL-USD', 'AAPL', 'BTC-USD', 'EURUSD=X', 'ETH-USD', 'SPY'];
const SERIES: Record<string, Candle[]> = {
  'BTC-USD': series(199, wave),
  'ETH-USD': series(199, rising),
  'SOL-USD': series(199, falling),
};

function fetchFrom(map: Record<string, Candle[] | Error>) {
  const calls: string[] = [];
  const fetchCandles = async (ticker: string) => {
    calls.push(ticker);
    const value = map[ticker];
    if (value instanceof Error) throw value;
    return value ?? [];
  };
  return { calls, fetchCandles };
}

async function scan(universe: readonly string[], map: Record<string, Candle[] | Error>) {
  const inputs = await collectScanInputs(universe, fetchFrom(map).fetchCandles);
  return evaluateScan(inputs, { evaluationTime: NOW, universeSource: 'fixture' });
}

describe('collectScanInputs', () => {
  it('attempts every supported member exactly once and never requests unsupported ones', async () => {
    const { calls, fetchCandles } = fetchFrom(SERIES);
    const inputs = await collectScanInputs([...UNIVERSE, 'BTC-USD'], fetchCandles);
    expect([...calls].sort()).toEqual(['BTC-USD', 'ETH-USD', 'SOL-USD']);
    expect(inputs.map((input) => [input.ticker, input.instrument])).toEqual([
      ['AAPL', null],
      ['BTC-USD', 'BINANCE:BTCUSDT'],
      ['ETH-USD', 'BINANCE:ETHUSDT'],
      ['EURUSD=X', null],
      ['SOL-USD', 'BINANCE:SOLUSDT'],
      ['SPY', null],
    ]);
  });

  it('keeps at most `concurrency` requests in flight', async () => {
    const universe = Array.from({ length: 12 }, (_, i) => `C${i}-USD`);
    let inFlight = 0;
    let peak = 0;
    const inputs = await collectScanInputs(
      universe,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
        return [];
      },
      3,
    );
    expect(peak).toBe(3);
    expect(inputs.every((input) => input.candles !== undefined)).toBe(true);
  });

  it('stops requesting after a rate-limit answer and records the rest as not requested', async () => {
    const universe = ['A-USD', 'B-USD', 'C-USD', 'D-USD'];
    const { calls, fetchCandles } = fetchFrom({
      'A-USD': SERIES['BTC-USD']!,
      'B-USD': new ProviderRateLimitError(429, 30_000),
    });
    const inputs = await collectScanInputs(universe, fetchCandles, 1);
    expect(calls).toEqual(['A-USD', 'B-USD']);
    expect(inputs.map((input) => input.error?.code ?? 'OK')).toEqual([
      'OK',
      'RATE_LIMITED',
      'RATE_LIMITED',
      'RATE_LIMITED',
    ]);
    expect(inputs[1]?.error?.detail).toBe('Binance rate limit: HTTP 429 (retry after 30s)');
    expect(inputs[2]?.error?.detail).toMatch(/^Not requested: /);
  });

  it('records network and malformed-provider failures on their member without rejecting', async () => {
    const inputs = await collectScanInputs(['BTC-USD', 'ETH-USD'], async (ticker) => {
      if (ticker === 'BTC-USD') throw new Error('network down');
      throw new CandleProviderDataError('Binance kline row 3 is not an array');
    });
    expect(inputs.map((input) => input.error)).toEqual([
      { code: 'FETCH_FAILED', detail: 'network down' },
      {
        code: 'DATA_INVALID',
        detail: 'MALFORMED_PROVIDER_ROW: Binance kline row 3 is not an array',
      },
    ]);
  });
});

describe('evaluateScan', () => {
  it('reports every unsupported member explicitly, with its reason', async () => {
    const result = await scan(UNIVERSE, SERIES);
    expect(result.coverage).toMatchObject({
      configured: 6,
      supported: 3,
      evaluated: 3,
      unsupported: 3,
      notEvaluated: 0,
    });
    const unsupported = result.results.filter((item) => item.status === 'UNSUPPORTED');
    expect(unsupported.map((item) => [item.ticker, item.assetClass])).toEqual([
      ['AAPL', 'equity'],
      ['EURUSD=X', 'forex'],
      ['SPY', 'equity'],
    ]);
    expect(unsupported.every((item) => item.detail?.startsWith('No validated daily candle'))).toBe(
      true,
    );
    expect(unsupported.every((item) => item.rank === null && item.model === null)).toBe(true);
  });

  it('ranks by score, breaks ties by ticker, and is identical for any input order', async () => {
    const tied = { ...SERIES, 'ADA-USD': SERIES['BTC-USD']! };
    const universe = [...UNIVERSE, 'ADA-USD'];
    const first = await scan(universe, tied);
    const second = await scan([...universe].reverse(), tied);
    expect(second).toEqual(first);
    const ranked = first.results.filter((item) => item.rank !== null);
    const scores = ranked.map((item) => item.model?.signal_score ?? -1);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(ranked.map((item) => item.rank)).toEqual([1, 2, 3, 4]);
    const ada = ranked.findIndex((item) => item.ticker === 'ADA-USD');
    const btc = ranked.findIndex((item) => item.ticker === 'BTC-USD');
    expect(ranked[ada]?.model?.signal_score).toBe(ranked[btc]?.model?.signal_score);
    expect(btc).toBe(ada + 1);
  });

  it('scores only closed candles, excluding a candle that closes after the scan started', async () => {
    const candles = SERIES['BTC-USD']!;
    const closed = candles.slice(0, -1);
    const [btc] = (await scan(['BTC-USD'], { 'BTC-USD': candles })).results;
    expect(btc?.status).toBe('EVALUATED');
    expect(btc?.closedCandles).toBe(199);
    expect(btc?.dataAsOf).toBe(TODAY - 1);
    expect(btc?.model).toEqual(evaluateCandles(closed));

    // Scanned one millisecond before yesterday's candle closed: it is still open.
    const early = evaluateScan([{ ticker: 'BTC-USD', instrument: 'BINANCE:BTCUSDT', candles }], {
      evaluationTime: TODAY - 2,
      universeSource: 'fixture',
    }).results[0];
    expect(early?.dataAsOf).toBe(TODAY - DAY - 1);
    expect(early?.closedCandles).toBe(198);
  });

  it('reports stale, invalid and short histories instead of ranking them', async () => {
    const stale = series(199, wave, TODAY - 3 * DAY);
    const duplicate = [...SERIES['ETH-USD']!];
    duplicate.splice(100, 0, { ...duplicate[100]! });
    const result = await scan(['BTC-USD', 'ETH-USD', 'SOL-USD'], {
      'BTC-USD': stale,
      'ETH-USD': duplicate,
      'SOL-USD': series(SCAN_MIN_CLOSED_CANDLES - 1, falling),
    });
    expect(result.results.map((item) => [item.ticker, item.status, item.rank])).toEqual([
      ['BTC-USD', 'STALE_DATA', null],
      ['ETH-USD', 'DATA_INVALID', null],
      ['SOL-USD', 'INSUFFICIENT_HISTORY', null],
    ]);
    expect(result.results[0]?.detail).toContain('more than 48h before the scan');
    expect(result.results[1]?.detail).toContain('DUPLICATE_TIMESTAMP');
    expect(result.results[2]?.detail).toBe(
      '198 closed daily candles; the scan ranks only full 199-candle windows.',
    );
    expect(result.status).toBe('FAILED');
  });

  it('is COMPLETE only when every supported member is scored', async () => {
    expect((await scan(UNIVERSE, SERIES)).status).toBe('COMPLETE');

    const partial = await scan(UNIVERSE, { ...SERIES, 'SOL-USD': new Error('HTTP 503') });
    expect(partial.status).toBe('PARTIAL');
    expect(partial.coverage).toMatchObject({ supported: 3, evaluated: 2, notEvaluated: 1 });
    expect(partial.coverage.byStatus.FETCH_FAILED).toBe(1);
    expect(partial.results.find((item) => item.ticker === 'SOL-USD')?.detail).toBe('HTTP 503');

    const failed = await scan(UNIVERSE, {});
    expect(failed.status).toBe('FAILED');
    expect((await scan(['AAPL', 'SPY'], {})).status).toBe('FAILED');
  });

  it('stamps the scan with its versions, universe and data-as-of', async () => {
    const result = await scan(UNIVERSE, SERIES);
    expect(result).toMatchObject({
      scannerVersion: 'market-scan-v1',
      modelVersion: '1.0.0',
      candlePolicyVersion: 'binance-daily-v1',
      timeframe: '1d',
      evaluationTime: NOW,
      universe: { source: 'fixture', members: [...UNIVERSE].sort() },
      dataAsOf: { oldest: TODAY - 1, newest: TODAY - 1 },
    });
  });

  it('keeps rank, setup conditions and risk-profile eligibility separate', async () => {
    const result = await scan(UNIVERSE, SERIES);
    for (const item of result.results.filter((entry) => entry.model)) {
      const model = item.model as CanonicalScore;
      expect(item.setups).toEqual(modelSetups(model));
      expect(item.riskProfiles).toEqual({
        conservative: qualifiesForRiskProfile('conservative', model),
        moderate: qualifiesForRiskProfile('moderate', model),
        aggressive: qualifiesForRiskProfile('aggressive', model),
      });
    }
  });
});

describe('modelSetups (Pine longSetup / riskSetup)', () => {
  const reading = (
    signal_score: number,
    regime: CanonicalScore['regime'],
    momentumPercent: number,
  ) => ({
    signal_score,
    regime,
    inputs: { rsi: 40, momentumPercent, volatilityPercent: 0.02 },
  });

  it('needs bullish momentum as well as a high score for a long setup', () => {
    expect(modelSetups(reading(78, 'TRENDING', 0.0005))).toEqual({ long: true, risk: false });
    expect(modelSetups(reading(90, 'NEUTRAL', 0.0004))).toEqual({ long: false, risk: false });
    expect(modelSetups(reading(77, 'TRENDING', 0.01))).toEqual({ long: false, risk: false });
  });

  it('flags risk on a low score or a high-volatility regime, alongside a long setup', () => {
    expect(modelSetups(reading(28, 'NEUTRAL', -0.01))).toEqual({ long: false, risk: true });
    expect(modelSetups(reading(29, 'NEUTRAL', -0.01))).toEqual({ long: false, risk: false });
    expect(modelSetups(reading(79, 'HIGH_VOLATILITY', 0.01))).toEqual({ long: true, risk: true });
  });
});

describe('scan path is read-only', () => {
  it('imports no database client, ledger, broker or order code', () => {
    for (const file of [
      'src/lib/marketScanner.ts',
      'src/hooks/useMarketScan.ts',
      'src/components/MarketScanSummary.tsx',
      'scripts/marketScanStore.ts',
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(
        /supabaseClient|tradeLedger|brokers|tradeRouter|portfolioStore|\.rpc\(|\.from\(['"]|method:/,
      );
    }
  });

  it('never fetches for a member whose class has no source', async () => {
    const inputs: ScanInput[] = await collectScanInputs(['AAPL', 'EURUSD=X'], () => {
      throw new Error('must not be called');
    });
    expect(inputs.every((input) => input.candles === undefined && !input.error)).toBe(true);
  });
});
