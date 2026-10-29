import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateCandles } from '@/lib/canonicalModel';
import {
  sessionFinalAt,
  sessionOpen,
  tradingSessions,
  type EquityDailyBar,
} from '@/lib/usEquityDaily';
import { stableSerialize } from './evaluationStore';
import {
  barsBySession,
  firstFullWindowIndex,
  frozenFactDifferences,
  horizonResults,
  measureOutcome,
  observedSessions,
  replayDate,
  RESEARCH_SPECIFICATION,
  RESEARCH_SPECIFICATION_ID,
  researchSummary,
  runScannerResearch,
  runStudy,
  saveResearchResults,
  scannerParity,
  studyObservations,
  type ReplayDate,
  type ReplayResult,
  type ResearchMember,
  type ResearchOutcome,
  type StudyObservation,
} from './scannerResearch';
import { renderScannerResearchReport } from './scannerResearchReport';
import {
  selectDevScanUniverse,
  TRADINGVIEW_SYMBOLS,
  type TradingViewOhlcvExport,
} from './tradingViewImport';

/**
 * Labeled fixtures, not market data: sessions from the published NYSE
 * calendar, prices from synthetic paths, shaped like `get_ohlcv` 1D
 * responses. Nothing here was fetched from TradingView.
 */
const NOTICE =
  'Market data notice: the last bar is still forming and may change; regular session only; prices are split-adjusted only.';
const UNIVERSE = selectDevScanUniverse();
/** 214 sessions: 16 evaluation dates keep the scanner-parity runs short. */
const SESSIONS = tradingSessions('2026-01-02', '2026-11-05');
const LAST = SESSIONS.at(-1)!;
/** Long enough for a window to pass a gap completely. */
const LONG = tradingSessions('2026-01-02', '2027-12-31');

const iso = (time: number) => new Date(time).toISOString();

/** Open and close differ, so a test can tell which one an outcome used. */
function pathBars(sessions: readonly string[], price: (i: number) => number): EquityDailyBar[] {
  return sessions.map((session, i) => {
    const close = price(i);
    const open = close * 0.995;
    return { session, open, high: close * 1.01, low: open * 0.99, close, volume: 1_000 };
  });
}

const pathOf = (k: number) => (i: number) =>
  100 + 10 * Math.sin((i + 7 * k) / (5 + (k % 7))) + 0.05 * i * ((k % 3) - 1);

function response(symbol: string, bars: readonly EquityDailyBar[]) {
  return {
    success: true,
    symbol,
    interval: '1D',
    notice: NOTICE,
    bars: bars.map((bar) => ({
      t: sessionOpen(bar.session) / 1000,
      o: bar.open,
      h: bar.high,
      l: bar.low,
      c: bar.close,
      v: bar.volume,
    })),
  };
}

/** An export retrieved an hour after `last` became final; `barsOf` returns null for "never retrieved". */
function exportOf(
  barsOf: (ticker: string, k: number) => readonly EquityDailyBar[] | null = (_, k) =>
    pathBars(SESSIONS, pathOf(k)),
  last = LAST,
): TradingViewOhlcvExport {
  const startedAt = sessionFinalAt(last) + 3_600_000;
  return {
    schemaVersion: '1',
    source: 'tradingview-mcp',
    retrieval: { startedAt: iso(startedAt), completedAt: iso(startedAt + 60_000) },
    instruments: UNIVERSE.flatMap((ticker, k) => {
      const bars = barsOf(ticker, k);
      const symbol = TRADINGVIEW_SYMBOLS[ticker]!;
      return bars === null
        ? []
        : [
            {
              ticker,
              symbol,
              receivedAt: iso(startedAt + 30_000),
              response: response(symbol, bars),
            },
          ];
    }),
  };
}

function member(ticker: string, bars: readonly EquityDailyBar[]): ResearchMember {
  return { ticker, type: 'stock', bars, error: null };
}

let clean: ReturnType<typeof runStudy> | undefined;
/** The fault-free fixture study, computed once: each run includes the scanner-parity pass. */
const cleanStudy = () => (clean ??= runStudy(exportOf(), 'fixture'));
/** Timeout for tests that run whole studies, scanner-parity pass included. */
const STUDY_TIMEOUT = 60_000;

describe('retrospective scanner study specification', () => {
  it('keeps the frozen machine-readable specification aligned with code', async () => {
    const documented = JSON.parse(
      await readFile('docs/scanner-research.v1.json', 'utf8'),
    ) as unknown;
    expect(stableSerialize(documented)).toBe(stableSerialize(RESEARCH_SPECIFICATION));
    expect(RESEARCH_SPECIFICATION_ID).toBe(
      'ab0d42aa14413cd2f05a2b29a516c85502aa0ff410652375a8390eb0860bebdf',
    );
  });
});

describe('historical window selection', () => {
  const bars = pathBars(LONG, pathOf(3));
  const members = [member('AAA', bars), member('BBB', pathBars(LONG, pathOf(4)))];

  it('scores the 199 sessions ending at the evaluation date, and nothing shorter', () => {
    const at = 220;
    const [result] = replayDate(members, LONG, at).results;
    const expected = evaluateCandles(bars.slice(at - 198, at + 1));
    expect(expected.status).toBe('OK');
    expect(result?.dataAsOf).toBe(LONG[at]);
    expect(result?.score).toBe(expected.status === 'OK' ? expected.signal_score : null);
    expect(replayDate(members, LONG, 197).results[0]?.status).toBe('INSUFFICIENT_HISTORY');
    expect(replayDate(members, LONG, 198).results[0]?.status).toBe('EVALUATED');
  });

  it('starts on the first session every member with enough bars has a full window', () => {
    const index = new Map(LONG.map((session, i) => [session, i]));
    const late = member('LATE', bars.slice(10));
    const short = member('SHORT', bars.slice(-50));
    expect(firstFullWindowIndex([members[0]!], index)).toBe(198);
    expect(firstFullWindowIndex([members[0]!, late, short], index)).toBe(208);
  });

  it('ranks by score, then ticker, among evaluated members only', () => {
    const tied = [member('ZED', bars), member('ABE', bars), member('GAP', [])];
    const results = replayDate(tied, LONG, 220).results;
    expect(results.map((result) => [result.ticker, result.rank])).toEqual([
      ['ZED', 2],
      ['ABE', 1],
      ['GAP', null],
    ]);
  });

  it('marks a missing session DATA_INVALID for exactly the 198 dates whose window spans it', () => {
    const missing = 205;
    const gapped = member(
      'GAP',
      bars.filter((_, i) => i !== missing),
    );
    const statusAt = (at: number) => replayDate([gapped], LONG, at).results[0]?.status;
    expect(statusAt(missing)).toBe('EVALUATED'); // the session before still counts as fresh
    const invalid = LONG.map((_, at) => at).filter((at) => statusAt(at) === 'DATA_INVALID');
    expect(invalid).toEqual(Array.from({ length: 198 }, (_, i) => missing + 1 + i));
    expect(statusAt(missing + 199)).toBe('EVALUATED');
  });

  it('marks a series STALE_DATA two sessions after its last bar', () => {
    const ended = member('END', bars.slice(0, 230));
    const statusAt = (at: number) => replayDate([ended], LONG, at).results[0]?.status;
    expect(statusAt(230)).toBe('EVALUATED');
    expect(statusAt(231)).toBe('STALE_DATA');
  });
});

describe('no future-bar leakage', () => {
  const members = UNIVERSE.slice(0, 6).map((ticker, k) =>
    member(ticker, pathBars(LONG, pathOf(k))),
  );
  const at = 215;

  it('gives the same scan whatever the bars after the evaluation date say', () => {
    const before = replayDate(members, LONG, at);
    const scrambled = members.map((m) => ({
      ...m,
      bars: m.bars.map((bar, i) =>
        i > at ? { ...bar, open: bar.open * 7, high: bar.high * 9, close: bar.close * 3 } : bar,
      ),
    }));
    expect(replayDate(scrambled, LONG, at)).toEqual(before);
    const touched = members.map((m) => ({
      ...m,
      bars: m.bars.map((bar, i) =>
        i === at ? { ...bar, high: bar.high * 1.3, close: bar.close * 1.3 } : bar,
      ),
    }));
    expect(replayDate(touched, LONG, at)).not.toEqual(before);
  });

  it(
    'replays the same past dates from an export that ends earlier',
    () => {
      const cut = SESSIONS.length - 5;
      const full = cleanStudy();
      const early = runStudy(
        exportOf((_, k) => pathBars(SESSIONS.slice(0, cut), pathOf(k)), SESSIONS[cut - 1]),
        'fixture',
      );
      expect(early.replay.length).toBe(full.replay.length - 5);
      expect(early.replay).toEqual(full.replay.slice(0, early.replay.length));
    },
    STUDY_TIMEOUT,
  );
});

describe('reference and endpoint sessions', () => {
  // Thanksgiving week: 26 Nov is a holiday, so sessions, not calendar days, are counted.
  const sessions = tradingSessions('2026-11-20', '2026-12-04');
  const week = sessions.map((session, i) => ({
    session,
    open: 100 + i,
    high: 300,
    low: 50,
    close: 200 + i,
    volume: 1,
  }));
  const at = sessions.indexOf('2026-11-25');

  it('uses the OPEN after the decision as reference and the OPEN h sessions later as endpoint', () => {
    expect(sessions[at + 1]).toBe('2026-11-27');
    const bars = barsBySession(week);
    expect(measureOutcome(bars, sessions, at, 1)).toEqual({
      status: 'AVAILABLE',
      change: (105 / 104 - 1) * 100,
    });
    expect(measureOutcome(bars, sessions, at, 5)).toEqual({
      status: 'AVAILABLE',
      change: (109 / 104 - 1) * 100,
    });
  });

  it('leaves a horizon PENDING until its endpoint session is final', () => {
    const bars = barsBySession(week);
    expect(measureOutcome(bars, sessions, sessions.length - 3, 1).status).toBe('AVAILABLE');
    expect(measureOutcome(bars, sessions, sessions.length - 2, 1).status).toBe('PENDING');
    expect(measureOutcome(bars, sessions, at + 1, 5).status).toBe('PENDING');
  });

  it('reports a missing, duplicated or invalid bar without substituting a neighbour', () => {
    const without = (session: string) => barsBySession(week.filter((b) => b.session !== session));
    expect(measureOutcome(without('2026-11-30'), sessions, at, 1).status).toBe('MISSING');
    expect(measureOutcome(without('2026-11-27'), sessions, at, 1).status).toBe('MISSING');
    expect(measureOutcome(without('2026-11-30'), sessions, at - 1, 1).status).toBe('AVAILABLE');
    expect(measureOutcome(barsBySession([...week, week[4]!]), sessions, at, 1).status).toBe(
      'INVALID',
    );
    const broken = week.map((bar, i) => (i === 5 ? { ...bar, open: 400 } : bar));
    expect(measureOutcome(barsBySession(broken), sessions, at, 1).status).toBe('INVALID');
  });

  it(
    'counts PENDING outcomes for the last h + 1 dates of a complete export',
    () => {
      const study = cleanStudy();
      const dates = study.evaluationDates.count;
      for (const { horizon, outcomes } of study.horizons) {
        expect(outcomes).toEqual({
          AVAILABLE: 50 * Math.max(0, dates - horizon - 1),
          PENDING: 50 * Math.min(dates, horizon + 1),
          MISSING: 0,
          INVALID: 0,
        });
      }
    },
    STUDY_TIMEOUT,
  );
});

function observation(
  ticker: string,
  session: string,
  change: number | null,
  extra: Partial<StudyObservation> = {},
): StudyObservation {
  const outcome: ResearchOutcome =
    change === null ? { status: 'PENDING', change: null } : { status: 'AVAILABLE', change };
  return {
    ticker,
    type: 'stock',
    session,
    rank: 1,
    quintile: 1,
    long: false,
    risk: false,
    longTransition: false,
    riskTransition: false,
    longOnsetUnknown: false,
    riskOnsetUnknown: false,
    outcomes: { 1: outcome, 5: outcome, 20: outcome },
    ...extra,
  };
}

describe('same-date baseline comparisons', () => {
  const d1 = '2026-03-02';
  const d2 = '2026-03-03';
  const observations = [
    observation('A', d1, 2, { long: true }),
    observation('B', d1, 0),
    observation('C', d1, -2, { type: 'etf' }),
    observation('D', d1, null, { long: true }), // pending: in no mean
    observation('A', d2, 1, { long: true }),
    observation('B', d2, 3),
  ];
  const spy = new Map<string, number | null>([
    [d1, 1],
    [d2, -1],
  ]);
  const result = horizonResults(observations, 1, spy);

  it('compares a group with the universe mean of its own dates', () => {
    expect(result.groups['long-setup']).toEqual({
      observations: 2,
      distinctAssets: 1,
      distinctDates: 2,
      mean: 1.5,
      median: 1.5,
      positiveFraction: 1,
      sameDateUniverseMean: 1, // d1 mean 0, d2 mean 2
      meanDifferenceVsUniverse: 0.5, // (2 - 0) and (1 - 2)
      medianDifferenceVsUniverse: 0.5,
      fractionAboveUniverse: 0.5,
      meanDifferenceVsBenchmark: 1.5, // (2 - 1) and (1 - -1)
    });
    expect(result.groups.universe.meanDifferenceVsUniverse).toBe(0);
    expect(result.outcomes).toEqual({ AVAILABLE: 5, PENDING: 1, MISSING: 0, INVALID: 0 });
  });

  it('compares stocks and ETFs with the same-date universe of their own type', () => {
    // Stock-only means: d1 (2 + 0) / 2 = 1, d2 (1 + 3) / 2 = 2; so A's differences are +1 and -1.
    expect(result.byType['long-setup'].stock.meanDifferenceVsUniverse).toBe(0);
    expect(result.byType['long-setup'].stock.sameDateUniverseMean).toBe(1.5);
    expect(result.byType.universe.etf).toMatchObject({ observations: 1, mean: -2 });
    expect(result.byType.universe.etf.meanDifferenceVsUniverse).toBe(0);
  });

  it('measures SPY once per date against the same universe, and breaks results down', () => {
    expect(result.groups['benchmark-spy']).toMatchObject({
      observations: 2,
      mean: 0,
      sameDateUniverseMean: 1,
      meanDifferenceVsUniverse: -1, // (1 - 0) and (-1 - 2)
    });
    expect(Object.keys(result.byYear['long-setup'])).toEqual(['2026']);
    expect(result.byAsset['long-setup'].concentration).toEqual({
      largestAssetShare: 1,
      assetsForHalf: 1,
    });
    expect(Object.keys(result.byAsset.universe.assets)).toEqual(['A', 'B', 'C']);
  });
});

function result(
  ticker: string,
  long: boolean | null,
  extra: Partial<ReplayResult> = {},
): ReplayResult {
  return {
    ticker,
    status: long === null ? 'DATA_INVALID' : 'EVALUATED',
    detail: null,
    dataAsOf: null,
    rank: long === null ? null : 1,
    score: long === null ? null : 80,
    regime: long === null ? null : 'NEUTRAL',
    setups: long === null ? null : { long, risk: false },
    ...extra,
  };
}

describe('repeated setups versus transitions', () => {
  const day = (session: string, results: ReplayResult[]): ReplayDate => ({ session, results });
  const replay = [
    day('2026-03-02', [result('A', true), result('B', false), result('C', false)]),
    day('2026-03-03', [result('A', true), result('B', true), result('C', null)]),
    day('2026-03-04', [result('A', true), result('B', true), result('C', true)]),
    day('2026-03-05', [result('A', true), result('B', false), result('C', true)]),
    day('2026-03-06', [result('A', true), result('B', true), result('C', true)]),
  ];
  const flags = studyObservations(replay, new Map(), () => ({ status: 'PENDING', change: null }))
    .filter((o) => o.long)
    .map(
      (o) =>
        `${o.ticker}${o.session.slice(-1)}:${o.longTransition ? 'new' : ''}${o.longOnsetUnknown ? '?' : ''}`,
    );

  it('counts a standing setup once per date but as new only when it turns on', () => {
    expect(flags).toEqual([
      'A2:?', // first date: onset unknown
      'A3:',
      'B3:new',
      'A4:',
      'B4:',
      'C4:?', // C was not evaluated the date before
      'A5:',
      'C5:',
      'A6:',
      'B6:new', // turned off on the 5th, on again on the 6th
      'C6:',
    ]);
  });

  it('assigns rank quintiles from the evaluated count on each date', () => {
    const ranked = [1, 2, 3, 4, 5, 6, 7].map((rank) => result(`R${rank}`, false, { rank }));
    const quintiles = studyObservations(
      [day('2026-03-02', [...ranked, result('X', null)])],
      new Map(),
      () => ({ status: 'PENDING', change: null }),
    ).map((o) => o.quintile);
    expect(quintiles).toEqual([1, 2, 3, 3, 4, 5, 5]); // ceil(5 * rank / 7)
  });
});

describe('the actual scanner on the same export', () => {
  const faulty = exportOf((ticker, k) => {
    const bars = pathBars(SESSIONS, pathOf(k));
    if (k === 0) return null; // never retrieved
    if (k === 1) return bars.slice(-150); // short history
    if (k === 2) return bars.slice(0, -5); // stops early: stale
    if (k === 3) return bars.filter((_, i) => i !== SESSIONS.length - 30); // missing session
    if (k === 4) return [...bars, bars[SESSIONS.length - 40]!]; // duplicate session
    if (k === 5)
      return bars.map((bar, i) =>
        i === SESSIONS.length - 20 ? { ...bar, low: bar.high * 2 } : bar,
      );
    return bars;
  });
  faulty.instruments[5]!.symbol = 'NYSE:ELSEWHERE';
  const study = runStudy(faulty, 'fixture');

  it('matches importInputs + evaluateScan on every date the published calendar serves', () => {
    expect(study.parity).toMatchObject({ status: 'MATCH', mismatches: [] });
    // Compared: every replayed date whose 200-session request range the published calendar
    // holds, i.e. from its 200th session (index 199) on.
    const servable = study.replay.filter((date) => SESSIONS.indexOf(date.session) >= 199);
    expect(servable.length).toBeGreaterThan(5);
    expect(study.parity.datesCompared).toBe(servable.length);
    for (const status of ['FETCH_FAILED', 'INSUFFICIENT_HISTORY', 'STALE_DATA', 'DATA_INVALID']) {
      expect(study.coverage.byStatus[status as 'EVALUATED']).toBeGreaterThan(0);
    }
  });

  it(
    'reports a replay that departs from the scanner',
    () => {
      const tampered = study.replay.map((date, i) =>
        i === 10
          ? { ...date, results: date.results.map((r, j) => (j === 20 ? { ...r, score: 1 } : r)) }
          : date,
      );
      const parity = scannerParity(faulty, tampered);
      expect(parity.status).toBe('MISMATCH');
      expect(parity.mismatches).toEqual([
        expect.objectContaining({ session: study.replay[10]!.session, field: 'score', replay: 1 }),
      ]);
    },
    STUDY_TIMEOUT,
  );

  it('refuses observed sessions that differ from the published calendar', () => {
    const holiday = member('HOL', [
      ...pathBars(SESSIONS, pathOf(1)),
      ...pathBars(['2026-11-26'], pathOf(1)),
    ]);
    const cutoff = sessionFinalAt(LAST) + 1;
    expect(() => observedSessions([holiday], cutoff)).toThrow(/published calendar/);
    const gap = member(
      'GAP',
      pathBars(
        SESSIONS.filter((s) => s !== '2026-06-01'),
        pathOf(1),
      ),
    );
    expect(() => observedSessions([gap], cutoff)).toThrow(/published calendar/);
    expect(() =>
      observedSessions([member('OK', pathBars(SESSIONS, pathOf(1)))], cutoff),
    ).not.toThrow();
  });
});

describe('deterministic reproduction', () => {
  it(
    'gives byte-identical results however the export orders its instruments',
    () => {
      const file = exportOf();
      const reordered = { ...file, instruments: [...file.instruments].reverse() };
      expect(JSON.stringify(runStudy(reordered, 'fixture'))).toBe(JSON.stringify(cleanStudy()));
    },
    STUDY_TIMEOUT,
  );

  it('writes results once and reports a rerun as UNCHANGED or CONFLICT', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'zerochart-research-')), 'results.json');
    expect(await saveResearchResults(path, 'a\n')).toBe('CREATED');
    expect(await saveResearchResults(path, 'a\n')).toBe('UNCHANGED');
    expect(await saveResearchResults(path, 'b\n')).toBe('CONFLICT');
    expect(await readFile(path, 'utf8')).toBe('a\n');
  });

  it(
    'runs only on the frozen export and its frozen facts',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'zerochart-research-'));
      const file = join(dir, 'export.json');
      await writeFile(file, JSON.stringify(exportOf()));
      await expect(
        runScannerResearch({ file, outputDir: dir, repositoryCommit: 'c'.repeat(40) }),
      ).rejects.toThrow(/frozen on export/);
      const differences = frozenFactDifferences(cleanStudy());
      expect(differences).toContain('calendar.firstSession: 2026-01-02 (frozen 2022-11-01)');
    },
    STUDY_TIMEOUT,
  );
});

describe('summary and report', () => {
  it(
    'summarizes aggregates only, with no ticker',
    () => {
      const summary = JSON.stringify(researchSummary(cleanStudy()));
      expect(UNIVERSE.filter((ticker) => summary.includes(`"${ticker}"`))).toEqual([]);
      expect(summary).toContain('"specificationId"');
    },
    STUDY_TIMEOUT,
  );

  it(
    'labels the evidence and shows every horizon, without scripts',
    () => {
      const html = renderScannerResearchReport(cleanStudy(), {
        generatedAt: '2026-10-29T00:00:00.000Z',
        repositoryCommit: 'c'.repeat(40),
        resultHash: 'f'.repeat(64),
      });
      expect(html).toContain('retrospective historical research, not prospective evidence');
      expect(html).toContain('A decline is not profit');
      for (const label of ['1 session:', '5 sessions:', '20 sessions:'])
        expect(html).toContain(label);
      expect(html).not.toMatch(/<script/i);
    },
    STUDY_TIMEOUT,
  );
});
