// @vitest-environment node

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import fixturesJson from '../docs/pine-parity-fixtures.json';
import snapshotJson from '../docs/pine-parity-btcusdt-1d.json';
import runtimeJson from '../docs/pine-parity-runtime-2026-10-27.json';
import { CANONICAL_MODEL_VERSION, MIN_CANDLES } from '@/lib/canonicalModel';
import { buildPineScript } from '@/lib/pineScriptTemplate';
import { parseSignal } from '../supabase/functions/tv-webhook/payload';
import {
  EXPORT_COLUMNS,
  MODEL_WINDOW,
  REGIME_CODES,
  comparePineExport,
  decisions,
  parsePineExport,
  readWindow,
  selfCheckPine,
  snapshotCandles,
  verifyAgainstReference,
  type ParityFixtures,
} from './pine-parity';

const fixtures = fixturesJson as unknown as ParityFixtures;
const snapshot = snapshotCandles(snapshotJson.rows);
const row = (caseName: string, comparison: string, segment: string) =>
  fixtures.matrix.find(
    (item) => item.case === caseName && item.comparison === comparison && item.segment === segment,
  );

describe('production TypeScript against the independent Decimal app contract', () => {
  it('matches score, regime and momentum class on every bar, and indicators within 1e-12', () => {
    const results = verifyAgainstReference(fixtures, snapshot);
    expect(results.map((item) => item.case)).toEqual([
      'rising',
      'falling',
      'flat',
      'irregular',
      'threshold',
      'btcusdt-1d',
    ]);
    for (const result of results) {
      expect(result, result.case).toMatchObject({ compactMismatches: 0, withinTolerance: true });
    }
  });
});

describe('discrepancy matrix claims (Decimal models, not Pine runtime evidence)', () => {
  it('custom initialization alone is exact only until the 200-candle window rolls', () => {
    for (const name of ['rising', 'falling', 'flat', 'irregular', 'threshold']) {
      expect(row(name, 'customInit-vs-app', 'shared-history')?.classification).toBe('EXACT');
    }
    expect(row('irregular', 'customInit-vs-app', 'rolling-window')?.classification).toBe(
      'NUMERICAL_ONLY',
    );
    // 200 candles bound the drift; they do not make a rounding tie land the same way.
    expect(row('threshold', 'customInit-vs-app', 'rolling-window')).toMatchObject({
      scoreMismatches: 1,
      decisionMismatches: 1,
      classification: 'DECISION_CHANGED',
    });
  });

  it('the documented Pine conventions change decisions during warm-up and on flat prices', () => {
    expect(row('irregular', 'pineDocumented-vs-app', 'warm-up')?.readinessMismatches).toBe(19);
    expect(row('irregular', 'pineDocumented-vs-app', 'shared-history')?.scoreMismatches).toBe(24);
    expect(row('flat', 'pineDocumented-vs-app', 'rolling-window')).toMatchObject({
      scoreMismatches: 120,
      classification: 'DECISION_CHANGED',
    });
  });

  it('keeps a year of real BTCUSDT daily decisions identical, with a bounded drift', () => {
    const real = row('btcusdt-1d', 'pineDocumented-vs-app', 'rolling-window');
    expect(real).toMatchObject({ compared: 365, decisionMismatches: 0, scoreMismatches: 0 });
    expect(real?.maxAbs?.weighted).toBeLessThan(1e-3);
  });

  it('places the threshold case on the 60-point eligibility boundary', () => {
    const threshold = fixtures.cases.find((item) => item.name === 'threshold')!;
    const app = threshold.perBar.app.at(-1);
    const custom = threshold.perBar.customInit.at(-1);
    expect(
      [app, custom].map((compact) => Number(compact?.slice(0, -2))).sort((a, b) => a - b),
    ).toEqual([59, 60]);
    expect(decisions(app ?? null)[1]).not.toBe(decisions(custom ?? null)[1]);
  });
});

describe('Pine runtime evidence (TradingView, 2026-10-27, docs/pine-parity-runtime-2026-10-27.json)', () => {
  const runs = runtimeJson.runs as Record<string, string[]>;
  const fixtureFor = (run: string) =>
    fixtures.cases.find((item) => (run === 'Chart' ? !item.candles : item.name === run))!;
  const summary = (run: string) =>
    Object.fromEntries(
      [...runs[run]!.at(-1)!.matchAll(/(\w+)=(\d+)(?:\/(\d+))?/g)].map((match) => [
        match[1]!,
        Number(match[2]),
      ]),
    );
  const keyPoints = Object.entries(runs).flatMap(([run, lines]) =>
    lines.flatMap((line) => {
      const match = line.match(/bar=(\d+) cand=(\S+) prod=(\S+)/);
      if (!match) return [];
      const values = (text: string) => {
        const [rsi, histogram, atr] = text.split('|').map(Number);
        return { rsi: rsi!, histogram: histogram!, atr: atr! };
      };
      return [{ run, bar: Number(match[1]), cand: values(match[2]!), prod: values(match[3]!) }];
    }),
  );
  const relative = (a: number, b: number) => (a === b ? 0 : Math.abs(a - b) / Math.abs(b));

  it('ran the committed self-check, byte for byte', () => {
    const source = readFileSync('pine/diagnostics/zerochart_parity_selfcheck.pine');
    expect(createHash('sha256').update(source).digest('hex')).toBe(runtimeJson.script.sha256);
  });

  it('the candidate reproduced every app reading in Pine, and Pine saw the snapshot bars', () => {
    for (const run of Object.keys(runs)) {
      expect(summary(run), run).toMatchObject({
        compared: fixtureFor(run).perBar.app.length,
        candVsApp: 0,
      });
    }
    expect(runs['Chart']!.at(-1)).toContain('inputs=564/564');
  });

  it('candidate indicators equal production TypeScript within 1e-14, not always bit for bit', () => {
    const errors = keyPoints.flatMap(({ run, bar, cand }) => {
      const candles = fixtureFor(run).candles;
      const start = bar - MODEL_WINDOW + 1;
      const window = candles
        ? candles.closes.slice(Math.max(0, start), bar + 1).map((close, offset) => ({
            high: candles.highs[Math.max(0, start) + offset]!,
            low: candles.lows[Math.max(0, start) + offset]!,
            close,
          }))
        : snapshot.slice(start, bar + 1);
      const ts = readWindow(window);
      return (['rsi', 'histogram', 'atr'] as const).map((key) => relative(cand[key], ts[key]));
    });
    expect(errors).toHaveLength(26 * 3);
    expect(Math.max(...errors)).toBeLessThan(1e-14);
    // Same operation order, yet two histograms differ in the last bits at runtime.
    expect(errors.filter((error) => error > 0)).toHaveLength(2);
  });

  it('production Pine follows SMA-seeded EMAs on continuous history, with RSI 100 when flat', () => {
    for (const { run, bar, prod } of keyPoints) {
      const { customInit, pineDocumented } = fixtureFor(run).keyPoints[String(bar)]!;
      const rsi = run === 'flat' ? 100 : customInit!.rsi;
      expect(relative(prod.rsi, rsi), `${run} ${bar}`).toBeLessThan(1e-13);
      expect(relative(prod.histogram, customInit!.histogram), `${run} ${bar}`).toBeLessThan(1e-13);
      expect(relative(prod.atr, customInit!.atr), `${run} ${bar}`).toBeLessThan(1e-13);
      // Hypothesis H1's first-sample EMA is refuted during the transient.
      if (run === 'rising' && bar === 33) expect(pineDocumented!.histogram).toBeGreaterThan(0.2);
    }
    expect(Object.keys(runs).map((run) => summary(run)['prodVsApp'])).toEqual([0, 0, 0, 287, 0, 1]);
  });
});

describe('decision boundaries', () => {
  it.each([
    ['59NP', [false, false, false, false, false, false]],
    ['60NP', [true, true, false, false, false, false]],
    ['60HP', [false, true, false, false, true, false]],
    ['71TN', [true, true, false, false, false, false]],
    ['71TP', [true, true, true, false, false, false]],
    ['78TP', [true, true, true, false, false, false]],
    ['78TB', [true, true, true, true, false, false]],
    ['80TB', [true, true, true, true, false, true]],
    ['28MN', [false, false, false, false, true, false]],
    ['29MN', [false, false, false, false, false, false]],
  ])('%s -> %j', (compact, expected) => {
    expect(decisions(compact)).toEqual(expected);
  });

  it('treats a not-ready reading as no decision', () => {
    expect(decisions(null)).toEqual([false, false, false, false, false, false]);
  });
});

describe('Pine export comparison', () => {
  const irregular = fixtures.cases.find((item) => item.name === 'irregular')!;
  const candles = irregular.candles!;

  // A synthetic export whose Pine readings equal production TypeScript.
  function exportCsv(mutate?: (cells: Record<string, number | string>, bar: number) => void) {
    const lines = [`time,${EXPORT_COLUMNS.join(',')}`];
    candles.closes.forEach((close, bar) => {
      const start = Math.max(0, bar - MODEL_WINDOW + 1);
      const reading = readWindow(
        candles.closes.slice(start, bar + 1).map((value, offset) => ({
          high: candles.highs[start + offset]!,
          low: candles.lows[start + offset]!,
          close: value,
        })),
      );
      const match = reading.compact?.match(/^(\d+)([NTMH])/);
      const pine = {
        ready: match ? 1 : 0,
        rsi: reading.rsi,
        hist: reading.histogram,
        atr: reading.atr,
        score: match ? Number(match[1]) : '',
        regime: match ? REGIME_CODES.indexOf(match[2] as (typeof REGIME_CODES)[number]) : '',
      };
      const cells: Record<string, number | string> = {
        zc_bar: bar,
        zc_confirmed: 1,
        zc_high: candles.highs[bar]!,
        zc_low: candles.lows[bar]!,
        zc_close: close,
        ...Object.fromEntries(
          Object.entries(pine).flatMap(([key, value]) => [
            [`zc_prod_${key}`, value],
            [`zc_cand_${key}`, value],
          ]),
        ),
      };
      mutate?.(cells, bar);
      lines.push(`${bar * 86_400},${EXPORT_COLUMNS.map((column) => cells[column]).join(',')}`);
    });
    return lines.join('\n');
  }

  it('accepts a candidate that reproduces production TypeScript on every confirmed bar', () => {
    const report = comparePineExport(parsePineExport(exportCsv()), irregular);
    expect(report.confirmedBars).toBe(candles.closes.length);
    expect(report.candidate).toMatchObject({
      readinessMismatches: 0,
      scoreMismatches: 0,
      regimeMismatches: 0,
      decisionMismatches: 0,
    });
    expect(report.fixtureInputMismatches).toBe(0);
    // Production-equal readings disagree with hypothesis H1 wherever H1 differs from the app.
    expect(report.hypothesisH1Mismatches).toBeGreaterThan(0);
  });

  it('reports a changed candidate score and ignores the unconfirmed realtime bar', () => {
    const last = candles.closes.length - 1;
    const report = comparePineExport(
      parsePineExport(
        exportCsv((cells, bar) => {
          if (bar === 250) cells['zc_cand_score'] = Number(cells['zc_cand_score']) + 1;
          if (bar === last) cells['zc_confirmed'] = 0;
        }),
      ),
    );
    expect(report.confirmedBars).toBe(last);
    expect(report.candidate.scoreMismatches).toBe(1);
  });

  it('refuses a partial export, which would change the window', () => {
    const csv = exportCsv()
      .split('\n')
      .filter((_, index) => index !== 100)
      .join('\n');
    expect(() => comparePineExport(parsePineExport(csv))).toThrow(/contiguous/);
  });
});

describe('production Pine, the tested candidate and diagnostics (source checks, not runtime evidence)', () => {
  const read = (path: string) => readFileSync(path, 'utf8');
  const production = read('pine/zerochart_quant_hud.pine');
  const candidate = read('pine/candidates/zerochart_quant_hud_w200.pine');
  const harness = read('pine/diagnostics/zerochart_parity_harness.pine');

  it('ships the promoted window-200 script to users', () => {
    expect(buildPineScript()).toBe(production);
    expect(production).toContain('zcMacdHist(close, windowLength)');
    expect(production).not.toContain('ta.macd(');
    const sources = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? sources(path) : [path];
      });
    for (const path of sources('src')) {
      expect(read(path), path).not.toMatch(/pine\/(candidates|diagnostics)/);
    }
  });

  it('promotes the candidate that ran on TradingView, changing only comments, title and version', () => {
    // docs/PINE_PARITY_ASSESSMENT.md section 4 records this hash for the candidate that ran.
    expect(
      createHash('sha256')
        .update(readFileSync('pine/candidates/zerochart_quant_hud_w200.pine'))
        .digest('hex'),
    ).toBe('014af558bd9215e494a38028def2c54101c73459d7be3522c095b0354b436842');
    const code = (source: string) =>
      source
        .split('\n')
        .filter(
          (line) =>
            !line.startsWith('//') && !/^indicator\(|^const string MODEL_VERSION/.test(line),
        )
        .join('\n');
    expect(code(production)).toBe(code(candidate));
    expect(production).toContain(`const string MODEL_VERSION = "${CANONICAL_MODEL_VERSION}-pw200"`);
  });

  it("keeps the candidate's .c1 attribution distinct from the promoted version", () => {
    const version = candidate.match(/const string MODEL_VERSION = "([^"]+)"/)?.[1];
    expect(version).toBe('1.0.0-pw200.c1');
    expect(version).not.toBe(`${CANONICAL_MODEL_VERSION}-pw200`);
    const parsed = parseSignal({
      signal_kind: 'strategy',
      ticker: 'BTCUSDT',
      action: 'BUY',
      signal_score: 80,
      price: 80_000,
      quantity: 0.01,
      stop_loss: 78_000,
      event_id: '2026-10-27T00:00:00Z',
      exchange: 'BINANCE',
      timeframe: '1D',
      bar_time: '2026-10-26T00:00:00Z',
      model_version: version,
    });
    expect(parsed).toMatchObject({ ok: true, signal: { model_version: '1.0.0-pw200.c1' } });
  });

  it('declares the app window contract in production, the candidate and the harness', () => {
    for (const source of [production, candidate, harness]) {
      expect(source).toMatch(new RegExp(`int MODEL_WINDOW\\s+= ${MODEL_WINDOW}\\b`));
      expect(source).toMatch(new RegExp(`int MIN_CANDLES\\s+= ${MIN_CANDLES}\\b`));
    }
    expect(harness).toContain(
      `float THRESHOLD_CLOSE = ${(fixturesJson.provenance as { thresholdClose: number }).thresholdClose}`,
    );
  });

  it('keeps the harness free of alerts and secrets', () => {
    expect(harness).not.toMatch(/alert(condition)?\(|USER_SECRET_PLACEHOLDER|secret_token/);
  });

  it('keeps the committed self-check generated from the harness and the fixtures', () => {
    const selfCheck = read('pine/diagnostics/zerochart_parity_selfcheck.pine');
    expect(selfCheck).toBe(selfCheckPine(harness, fixtures, snapshot));
    expect(selfCheck.startsWith(harness)).toBe(true);
    expect(selfCheck).not.toMatch(/alert(condition)?\(|USER_SECRET_PLACEHOLDER|secret_token/);
    // Every case's expected app readings reach Pine complete and in bar order.
    const branches = selfCheck.split(/\n {4}(?:else )?if barSource == "[^"]+"\n/).slice(1);
    for (const [index, fixture] of fixtures.cases.entries()) {
      const app = [...branches[index]!.matchAll(/array\.concat\(expApp, str\.split\("([^"]*)"/g)];
      expect(app.flatMap((match) => match[1]!.split(','))).toEqual(
        fixture.perBar.app.map((value) => value ?? '-'),
      );
    }
  });
});
