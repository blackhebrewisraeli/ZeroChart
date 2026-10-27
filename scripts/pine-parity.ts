/**
 * `npm run parity`: checks the production TypeScript model against the
 * independent Decimal reference in docs/pine-parity-fixtures.json and prints the
 * TypeScript-versus-Pine discrepancy matrix (docs/PINE_PARITY_ASSESSMENT.md).
 *
 * `npm run parity -- --pine-export FILE.csv [--case NAME]` compares a TradingView
 * "Export chart data" CSV from pine/diagnostics/zerochart_parity_harness.pine with
 * production TypeScript on the exact bars Pine saw. Only that path is runtime
 * evidence of Pine behavior; the fixture's `pineDocumented` model is a hypothesis.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateCandles, type EngineCandle, type MarketRegime } from '@/lib/canonicalModel';
import { DAY_MS, validateBinanceDailyCandles } from '@/lib/candleValidation';
import { atr, macd, rsi } from '@/lib/indicators';

export const MODEL_WINDOW = 200;
const FIXTURES = 'docs/pine-parity-fixtures.json';
const SNAPSHOT = 'docs/pine-parity-btcusdt-1d.json';

const REGIME_LETTER: Record<MarketRegime, string> = {
  NEUTRAL: 'N',
  TRENDING: 'T',
  MEAN_REVERTING: 'M',
  HIGH_VOLATILITY: 'H',
};
/** Regime codes the harness plots, in Pine's first-match order after NEUTRAL. */
export const REGIME_CODES = ['N', 'T', 'M', 'H'] as const;

type ModelName = 'app' | 'pineDocumented' | 'customInit';
type KeyValues = { rsi: number; histogram: number; atr: number; score: number; regime: string };

export interface ParityFixtures {
  provenance: { tolerances: { relative: number; absoluteFloor: number } };
  cases: Array<{
    name: string;
    evaluatedBars: [number, number];
    candles?: { highs: number[]; lows: number[]; closes: number[] };
    perBar: Record<ModelName, Array<string | null>>;
    keyPoints: Record<string, Record<ModelName, KeyValues | null>>;
  }>;
  matrix: Array<{
    case: string;
    comparison: string;
    segment: string;
    bars: [number, number];
    compared: number;
    readinessMismatches: number;
    maxAbs: Record<'rsi' | 'momentum' | 'volatility' | 'component' | 'weighted', number> | null;
    regimeMismatches: number;
    scoreMismatches: number;
    decisionMismatches: number;
    transitionMismatches: number;
    classification: string;
  }>;
}

export interface Reading {
  /** score + regime letter + momentum class, or null when the model is not ready. */
  compact: string | null;
  rsi: number;
  histogram: number;
  atr: number;
}

/** Production scoring of one window, plus the raw indicators it was built from. */
export function readWindow(window: readonly EngineCandle[]): Reading {
  const closes = window.map((candle) => candle.close);
  const last = closes.length - 1;
  const histogram = macd(closes).histogram[last] ?? Number.NaN;
  const result = evaluateCandles(window);
  let compact: string | null = null;
  if (result.status === 'OK') {
    const momentum = histogram / result.close;
    const momentumClass = momentum >= 0.0005 ? 'B' : momentum > 0 ? 'P' : 'N';
    compact = `${result.signal_score}${REGIME_LETTER[result.regime]}${momentumClass}`;
  }
  return {
    compact,
    rsi: rsi(closes)[last] ?? Number.NaN,
    histogram,
    atr:
      atr(
        window.map((candle) => candle.high),
        window.map((candle) => candle.low),
        closes,
      )[last] ?? Number.NaN,
  };
}

/**
 * Eligibility (conservative, moderate, aggressive) and Pine setups (long, risk,
 * high conviction) implied by a compact reading; all false when not ready.
 */
export function decisions(compact: string | null): boolean[] {
  const match = compact?.match(/^(\d+)([NTMH])([BPN])$/);
  if (!match) return [false, false, false, false, false, false];
  const score = Number(match[1]);
  const [regime, momentum] = [match[2], match[3]];
  return [
    score >= 60 && regime !== 'H',
    score >= 60,
    score >= 71 && momentum !== 'N',
    score >= 78 && momentum === 'B',
    score <= 28 || regime === 'H',
    score >= 80,
  ];
}

function sameDecisions(a: string | null, b: string | null): boolean {
  return decisions(a).every((value, index) => value === decisions(b)[index]);
}

function relativeError(actual: number, expected: number, floor: number): number {
  return Math.abs(actual - expected) / Math.max(Math.abs(expected), floor);
}

export function snapshotCandles(rows: readonly (readonly (string | number)[])[]) {
  return rows.map(([timestamp, open, high, low, close, closeTime]) => ({
    timestamp: Number(timestamp),
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    closeTime: Number(closeTime),
  }));
}

/** Production TypeScript against the Decimal `app` reference, bar by bar. */
export function verifyAgainstReference(
  fixtures: ParityFixtures,
  snapshot: ReturnType<typeof snapshotCandles>,
) {
  const { relative, absoluteFloor } = fixtures.provenance.tolerances;
  return fixtures.cases.map((fixture) => {
    const synthetic = fixture.candles;
    const [first, lastBar] = fixture.evaluatedBars;
    const windowAt = (bar: number): EngineCandle[] => {
      if (synthetic) {
        const start = Math.max(0, bar - MODEL_WINDOW + 1);
        return synthetic.closes.slice(start, bar + 1).map((close, offset) => ({
          high: synthetic.highs[start + offset]!,
          low: synthetic.lows[start + offset]!,
          close,
        }));
      }
      // The real case goes through the production daily contract: closed candles only,
      // the last 200 of them, validated under binance-daily-v1.
      const validation = validateBinanceDailyCandles(snapshot, {
        evaluationTime: snapshot[bar]!.timestamp + DAY_MS - 1,
        modelWindow: MODEL_WINDOW,
      });
      if (!validation.structurallyValid) throw new Error(`snapshot invalid at bar ${bar}`);
      return validation.closed;
    };

    let compactMismatches = 0;
    let maxRelativeError = 0;
    for (let bar = first; bar <= lastBar; bar += 1) {
      const reading = readWindow(windowAt(bar));
      if (reading.compact !== fixture.perBar.app[bar - first]) compactMismatches += 1;
      const expected = fixture.keyPoints[String(bar)]?.app;
      if (expected) {
        for (const key of ['rsi', 'histogram', 'atr'] as const) {
          maxRelativeError = Math.max(
            maxRelativeError,
            relativeError(reading[key], expected[key], absoluteFloor),
          );
        }
      }
    }
    return {
      case: fixture.name,
      bars: lastBar - first + 1,
      compactMismatches,
      maxRelativeError,
      withinTolerance: compactMismatches === 0 && maxRelativeError <= relative,
    };
  });
}

function format(value: number): string {
  return value === 0 ? '0' : value.toExponential(2);
}

export function matrixMarkdown(fixtures: ParityFixtures): string {
  const lines = [
    '| Case | Comparison | Segment (bars) | Compared | Max abs Δ RSI / momentum / volatility | Max abs Δ component / weighted | Readiness | Regime | Score | Decisions | Transitions | Class |',
    '| --- | --- | --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const row of fixtures.matrix) {
    const max = row.maxAbs;
    lines.push(
      `| ${row.case} | ${row.comparison} | ${row.segment} (${row.bars[0]}-${row.bars[1]}) | ${row.compared} | ` +
        `${max ? [max.rsi, max.momentum, max.volatility].map(format).join(' / ') : 'n/a'} | ` +
        `${max ? [max.component, max.weighted].map(format).join(' / ') : 'n/a'} | ` +
        `${row.readinessMismatches} | ${row.regimeMismatches} | ${row.scoreMismatches} | ` +
        `${row.decisionMismatches} | ${row.transitionMismatches} | ${row.classification} |`,
    );
  }
  return lines.join('\n');
}

/** Harness plot titles; TradingView names export columns after them. */
export const EXPORT_COLUMNS = [
  'zc_bar',
  'zc_confirmed',
  'zc_high',
  'zc_low',
  'zc_close',
  'zc_prod_ready',
  'zc_prod_rsi',
  'zc_prod_hist',
  'zc_prod_atr',
  'zc_prod_score',
  'zc_prod_regime',
  'zc_cand_ready',
  'zc_cand_rsi',
  'zc_cand_hist',
  'zc_cand_atr',
  'zc_cand_score',
  'zc_cand_regime',
] as const;
type ExportRow = Record<(typeof EXPORT_COLUMNS)[number], number>;

export function parsePineExport(csv: string): ExportRow[] {
  const [header = '', ...lines] = csv.trim().split(/\r?\n/);
  const names = header.split(',').map((name) => name.trim().replace(/^"|"$/g, ''));
  const indices = EXPORT_COLUMNS.map((column) => {
    const index = names.findIndex((name) => name === column || name.endsWith(` ${column}`));
    if (index < 0) throw new Error(`Pine export has no "${column}" column`);
    return index;
  });
  return lines.map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(
      EXPORT_COLUMNS.map((column, i) => {
        const cell = cells[indices[i]!]?.trim() ?? '';
        return [column, cell === '' || cell === 'NaN' ? Number.NaN : Number(cell)];
      }),
    ) as ExportRow;
  });
}

function exportCompact(score: number, regime: number, histogram: number, close: number) {
  if (!Number.isFinite(score) || !Number.isFinite(regime)) return null;
  const momentum = histogram / close;
  return `${score}${REGIME_CODES[regime] ?? '?'}${momentum >= 0.0005 ? 'B' : momentum > 0 ? 'P' : 'N'}`;
}

/**
 * Production TypeScript on the bars the Pine harness saw, against the harness's
 * production (`prod_*`) and candidate (`cand_*`) readings. Only confirmed bars count.
 */
export function comparePineExport(
  rows: readonly ExportRow[],
  fixture?: ParityFixtures['cases'][number],
) {
  const confirmed = rows.filter((row) => row.zc_confirmed === 1);
  const contiguous = confirmed.every(
    (row, index) => index === 0 || row.zc_bar === confirmed[index - 1]!.zc_bar + 1,
  );
  if (!contiguous) throw new Error('Pine export bars must be contiguous; export the full chart');
  const tally = (name: 'prod' | 'cand') => ({
    name,
    bars: 0,
    readinessMismatches: 0,
    scoreMismatches: 0,
    regimeMismatches: 0,
    decisionMismatches: 0,
    maxAbs: { rsi: 0, histogram: 0, atr: 0 },
  });
  const results = { prod: tally('prod'), cand: tally('cand') };
  let inputMismatches = 0;
  let hypothesisMismatches = 0;

  confirmed.forEach((row, index) => {
    const start = Math.max(0, index - MODEL_WINDOW + 1);
    const window = confirmed.slice(start, index + 1).map((bar) => ({
      high: bar.zc_high,
      low: bar.zc_low,
      close: bar.zc_close,
    }));
    const ts = readWindow(window);
    for (const side of ['prod', 'cand'] as const) {
      const tallied = results[side];
      const score = row[`zc_${side}_score`];
      const regime = row[`zc_${side}_regime`];
      const ready = row[`zc_${side}_ready`] === 1;
      const pine = ready
        ? exportCompact(score, regime, row[`zc_${side}_hist`], row.zc_close)
        : null;
      tallied.bars += 1;
      if ((pine === null) !== (ts.compact === null)) tallied.readinessMismatches += 1;
      if (pine && ts.compact) {
        if (pine.slice(0, -2) !== ts.compact.slice(0, -2)) tallied.scoreMismatches += 1;
        if (pine.at(-2) !== ts.compact.at(-2)) tallied.regimeMismatches += 1;
        for (const [key, value] of [
          ['rsi', row[`zc_${side}_rsi`]],
          ['histogram', row[`zc_${side}_hist`]],
          ['atr', row[`zc_${side}_atr`]],
        ] as const) {
          tallied.maxAbs[key] = Math.max(tallied.maxAbs[key], Math.abs(value - ts[key]));
        }
      }
      if (!sameDecisions(pine, ts.compact)) tallied.decisionMismatches += 1;
    }

    if (fixture?.candles) {
      const bar = row.zc_bar;
      const expected = [
        fixture.candles.highs[bar],
        fixture.candles.lows[bar],
        fixture.candles.closes[bar],
      ];
      if (expected[0] !== undefined) {
        if (
          expected[0] !== row.zc_high ||
          expected[1] !== row.zc_low ||
          expected[2] !== row.zc_close
        ) {
          inputMismatches += 1;
        }
        const documented = fixture.perBar.pineDocumented[bar - fixture.evaluatedBars[0]];
        const pine =
          row.zc_prod_ready === 1
            ? exportCompact(row.zc_prod_score, row.zc_prod_regime, row.zc_prod_hist, row.zc_close)
            : null;
        if (documented !== pine) hypothesisMismatches += 1;
      }
    }
  });

  return {
    confirmedBars: confirmed.length,
    production: results.prod,
    candidate: results.cand,
    ...(fixture
      ? { fixtureInputMismatches: inputMismatches, hypothesisH1Mismatches: hypothesisMismatches }
      : {}),
  };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(resolve(path), 'utf8')) as T;
}

async function main(argv: string[]): Promise<number> {
  const fixtures = await readJson<ParityFixtures>(FIXTURES);
  const snapshot = snapshotCandles((await readJson<{ rows: string[][] }>(SNAPSHOT)).rows);
  const option = (name: string) => {
    const index = argv.indexOf(name);
    return index < 0 ? undefined : argv[index + 1];
  };

  const exportPath = option('--pine-export');
  if (exportPath) {
    const caseName = option('--case');
    const fixture = caseName ? fixtures.cases.find((item) => item.name === caseName) : undefined;
    if (caseName && !fixture?.candles) throw new Error(`No synthetic fixture case "${caseName}"`);
    const report = comparePineExport(parsePineExport(await readFile(exportPath, 'utf8')), fixture);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    const candidate = report.candidate;
    return candidate.readinessMismatches +
      candidate.scoreMismatches +
      candidate.regimeMismatches ===
      0
      ? 0
      : 1;
  }

  const verification = verifyAgainstReference(fixtures, snapshot);
  process.stdout.write('## Production TypeScript vs independent Decimal app reference\n\n');
  for (const item of verification) {
    process.stdout.write(
      `- ${item.case}: ${item.bars} bars, ${item.compactMismatches} score/regime/momentum mismatches, ` +
        `max key-point relative error ${format(item.maxRelativeError)} ` +
        `${item.withinTolerance ? '(within tolerance)' : '(OUT OF TOLERANCE)'}\n`,
    );
  }
  process.stdout.write(`\n## Discrepancy matrix (Decimal models)\n\n${matrixMarkdown(fixtures)}\n`);
  return verification.every((item) => item.withinTolerance) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
