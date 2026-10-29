import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CandleProviderDataError } from '@/lib/binance';
import { parseTradingViewDevScan, TRADINGVIEW_DEV_SCAN_FILE } from '@/lib/tradingViewDevScan';
import { sessionOpen, US_EQUITY_INSTRUMENTS } from '@/lib/usEquityDaily';
import { bars, EQUITY_NOW, falling, rising, wave } from '@/test/usEquityFixtures';
import { reproduceScan } from './marketScanStore';
import {
  importTradingViewScan,
  parseExport,
  selectDevScanUniverse,
  TRADINGVIEW_SYMBOLS,
  tradingViewSeries,
  type TradingViewOhlcvExport,
} from './tradingViewImport';

/**
 * Labeled fixtures, not market data: sessions from the NYSE calendar, prices
 * from synthetic paths, shaped like a `get_ohlcv` 1D response. Nothing here
 * was fetched from TradingView.
 */
const NOTICE =
  'Market data notice: the last bar is still forming and may change; regular session only; prices are split-adjusted only.';
const COMMIT = 'c'.repeat(40);
const PATHS = [wave, rising, falling];

function response(symbol: string, path = wave) {
  return {
    success: true,
    symbol,
    interval: '1D',
    notice: NOTICE,
    bars: bars(path).map((bar) => ({
      t: sessionOpen(bar.session) / 1000,
      o: bar.open,
      h: bar.high,
      l: bar.low,
      c: bar.close,
      v: bar.volume,
    })),
  };
}

function exportOf(
  edit: (entries: TradingViewOhlcvExport['instruments']) => void = () => {},
): TradingViewOhlcvExport {
  const instruments = selectDevScanUniverse().map((ticker, i) => ({
    ticker,
    symbol: TRADINGVIEW_SYMBOLS[ticker]!,
    receivedAt: new Date(EQUITY_NOW - 60_000).toISOString(),
    response: response(TRADINGVIEW_SYMBOLS[ticker]!, PATHS[i % PATHS.length]),
  }));
  edit(instruments);
  return {
    schemaVersion: '1',
    source: 'tradingview-mcp',
    retrieval: {
      startedAt: new Date(EQUITY_NOW - 120_000).toISOString(),
      completedAt: new Date(EQUITY_NOW).toISOString(),
    },
    pineAlerts: { checkedAt: new Date(EQUITY_NOW).toISOString(), symbols: ['BINANCE:BTCUSDT'] },
    instruments,
  };
}

async function importInto(file: TradingViewOhlcvExport) {
  const store = await mkdtemp(join(tmpdir(), 'zerochart-tv-'));
  const path = join(store, 'export.json');
  await writeFile(path, JSON.stringify(file));
  const result = await importTradingViewScan({
    file: path,
    store,
    repositoryCommit: COMMIT,
    now: () => EQUITY_NOW + 5 * 60_000,
  });
  return { store, ...result };
}

describe('TradingView development universe', () => {
  it('picks 50 configured tickers by digest alone, whatever order they arrive in', () => {
    const picked = selectDevScanUniverse();
    expect(picked).toHaveLength(50);
    expect(picked.every((ticker) => Object.hasOwn(US_EQUITY_INSTRUMENTS, ticker))).toBe(true);
    expect(selectDevScanUniverse([...Object.keys(US_EQUITY_INSTRUMENTS)].reverse())).toEqual(
      picked,
    );
    expect(selectDevScanUniverse(['AAPL', 'BTC-USD', 'EURUSD=X'])).toEqual(['AAPL']);
  });

  it('names one exchange-qualified primary listing for exactly the selected tickers', () => {
    expect(Object.keys(TRADINGVIEW_SYMBOLS).sort()).toEqual(selectDevScanUniverse());
    for (const [ticker, symbol] of Object.entries(TRADINGVIEW_SYMBOLS)) {
      expect(symbol).toMatch(new RegExp(`^(NASDAQ|NYSE|AMEX|CBOE):${ticker}$`));
    }
  });
});

describe('tradingViewSeries', () => {
  const from = '2026-01-13';

  it('keys bars by their 09:30 New York session, across the DST change', () => {
    const series = tradingViewSeries(response('NYSE:BAC'), { symbol: 'NYSE:BAC', from });
    expect(series.adjustment).toBe('SPLIT');
    expect(series.bars.at(-1)?.session).toBe('2026-10-27');
    const march = series.bars.find((bar) => bar.session === '2026-03-06');
    expect(march).toBeDefined();
    expect(series.bars.every((bar) => bar.session >= from)).toBe(true);
  });

  it('rejects a bar stamped anything but the session open, rather than re-dating it', () => {
    const body = response('NYSE:BAC');
    body.bars[150]!.t = Date.UTC(2026, 7, 20) / 1000;
    expect(() => tradingViewSeries(body, { symbol: 'NYSE:BAC', from })).toThrow(
      /not the 09:30 America\/New_York open of 2026-08-19/,
    );
  });

  it('refuses another instrument, interval, an unstated adjustment or a non-numeric bar', () => {
    const check = (edit: (body: ReturnType<typeof response>) => void) => {
      const body = response('NYSE:BAC');
      edit(body);
      return () => tradingViewSeries(body, { symbol: 'NYSE:BAC', from });
    };
    expect(check((body) => (body.symbol = 'BOATS:BAC'))).toThrow(CandleProviderDataError);
    expect(check((body) => (body.interval = '1W'))).toThrow(/not 1D/);
    expect(check((body) => (body.notice = 'regular session only'))).toThrow(
      /adjustment basis is unresolved/,
    );
    expect(check((body) => ((body.bars[3] as { c: unknown }).c = null))).toThrow(/non-numeric/);
    expect(check((body) => (body.success = false))).toThrow(/did not succeed/);
  });
});

describe('importTradingViewScan', () => {
  it('scores every selected ticker with the canonical engine and reproduces offline', async () => {
    const { store, snapshot, view } = await importInto(exportOf());
    expect(snapshot.scan.status).toBe('COMPLETE');
    expect(snapshot.scan.coverage).toMatchObject({ configured: 50, evaluated: 50 });
    expect(snapshot.scan.cohorts[0]).toMatchObject({
      assetClass: 'equity',
      provider: 'tradingview-mcp-get_ohlcv',
      candlePolicyVersion: 'us-equity-daily-v1',
      minClosedCandles: 199,
    });
    const first = snapshot.scan.results[0]!;
    expect(first).toMatchObject({ rank: 1, closedCandles: 199, cached: false });
    expect(first.fetchedAt).toBe(EQUITY_NOW - 60_000);
    expect(snapshot.startedAt).toBe(new Date(EQUITY_NOW).toISOString());
    expect(await reproduceScan(snapshot.scanId, store)).toEqual({
      status: 'MATCH',
      scanId: snapshot.scanId,
    });
    const written = parseTradingViewDevScan(
      JSON.parse(await readFile(join(store, TRADINGVIEW_DEV_SCAN_FILE), 'utf8')),
    );
    expect(written).toEqual(view);
    expect(view.source).toMatchObject({ notice: NOTICE, symbols: TRADINGVIEW_SYMBOLS });
  });

  it('keeps every failure, with its reason, instead of dropping the ticker', async () => {
    const [a, b, c, d] = selectDevScanUniverse();
    const { snapshot } = await importInto(
      exportOf((entries) => {
        entries[0] = { ticker: a!, symbol: TRADINGVIEW_SYMBOLS[a!]!, error: 'HTTP 429' };
        entries.splice(1, 1);
        entries[1]!.symbol = 'BOATS:X';
        (entries[2]!.response as { notice: string }).notice = 'delayed';
      }),
    );
    const byTicker = new Map(snapshot.scan.results.map((result) => [result.ticker, result]));
    expect(snapshot.scan.status).toBe('PARTIAL');
    expect(snapshot.scan.coverage).toMatchObject({ configured: 50, evaluated: 46 });
    expect(byTicker.get(a!)).toMatchObject({ status: 'FETCH_FAILED' });
    expect(byTicker.get(a!)?.detail).toMatch(/HTTP 429/);
    expect(byTicker.get(b!)?.detail).toMatch(/was never retrieved/);
    expect(byTicker.get(c!)).toMatchObject({ status: 'DATA_INVALID' });
    expect(byTicker.get(d!)?.detail).toMatch(/adjustment basis is unresolved/);
  });

  it('refuses a retrieval that a session close interrupted, and files it does not recognise', async () => {
    const straddle = exportOf();
    // 04:00 UTC on 28 Oct: 27 Oct turns final at 05:00 UTC, inside the window.
    straddle.retrieval.startedAt = new Date(EQUITY_NOW - 13 * 3_600_000).toISOString();
    await expect(importInto(straddle)).rejects.toThrow(/became final during retrieval/);

    const foreign = exportOf((entries) => entries.push({ ...entries[0]!, ticker: 'XOM' }));
    expect(() => parseExport(foreign)).toThrow(/XOM is not in the dev-scan universe/);
    const late = exportOf((entries) => (entries[0]!.receivedAt = '2027-01-01T00:00:00Z'));
    expect(() => parseExport(late)).toThrow(/inside the retrieval window/);
    expect(() => parseTradingViewDevScan({ kind: 'tradingview-dev-scan' })).toThrow();
  });
});
