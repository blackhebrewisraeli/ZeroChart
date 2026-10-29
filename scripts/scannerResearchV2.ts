import { compareTickers } from '@/lib/marketScanner';
import {
  concentration,
  GROUP_MEMBERSHIP,
  groupBy,
  loadFrozenExport,
  meansBy,
  prepareStudy,
  RESEARCH_HORIZONS,
  RESEARCH_SPECIFICATION_V2,
  RESEARCH_SPECIFICATION_V2_ID,
  studyBase,
  summarize,
  writeStudy,
  type ResearchHorizon,
  type ResearchOutcome,
  type ResearchPoint,
  type StudyObservation,
} from './scannerResearch';
import { renderScannerResearchV2Report } from './scannerResearchReport';
import type { TradingViewOhlcvExport } from './tradingViewImport';

/**
 * v2 of the retrospective scanner study (docs/scanner-research.v2.json): v1's
 * groups against the same-date mean of their own volatility tercile, for all
 * members and for stocks alone. Volatility is the model's own ATR/close on
 * the evaluation date; everything else is v1's replay, unchanged.
 */

const SPEC = RESEARCH_SPECIFICATION_V2;
export type Population = keyof typeof SPEC.populations & ('all' | 'stocks');
export const POPULATIONS: Record<Population, (observation: StudyObservation) => boolean> = {
  all: () => true,
  stocks: (observation) => observation.type === 'stock',
};

type TercileGroupId = (typeof SPEC.comparisons.groupsAgainstPopulation)[number];
export type MatchedGroupId = (typeof SPEC.comparisons.groupsAgainstVolatilityMatched)[number];
export type V2GroupId = TercileGroupId | MatchedGroupId;
export const TERCILE_GROUPS = SPEC.comparisons.groupsAgainstPopulation;
export const MATCHED_GROUPS = SPEC.comparisons.groupsAgainstVolatilityMatched;

/** A v1 observation placed within one population: its rank and quintile there, and its tercile. */
export interface V2Observation extends StudyObservation {
  tercile: 1 | 2 | 3;
}

/**
 * Ranks, quintiles and volatility terciles among one population's EVALUATED
 * members on each date. `volatility` maps session → ticker → ATR/close.
 */
export function populationObservations(
  observations: readonly StudyObservation[],
  volatility: ReadonlyMap<string, ReadonlyMap<string, number>>,
  population: Population,
): V2Observation[] {
  const included = observations.filter(POPULATIONS[population]);
  return [...groupBy(included, (o) => o.session)].flatMap(([session, day]) => {
    const vol = (o: StudyObservation) => {
      const value = volatility.get(session)?.get(o.ticker);
      if (value === undefined) throw new Error(`No ATR/close for ${o.ticker} on ${session}`);
      return value;
    };
    const ranks = new Map(
      [...day].sort((a, b) => a.rank - b.rank).map((o, i) => [o.ticker, i + 1] as const),
    );
    const positions = new Map(
      [...day]
        .sort((a, b) => vol(a) - vol(b) || compareTickers(a.ticker, b.ticker))
        .map((o, i) => [o.ticker, i + 1] as const),
    );
    return day.map((o): V2Observation => {
      const rank = ranks.get(o.ticker) ?? 0;
      const position = positions.get(o.ticker) ?? 0;
      return {
        ...o,
        rank,
        quintile: Math.ceil((5 * rank) / day.length),
        tercile: Math.ceil((3 * position) / day.length) as 1 | 2 | 3,
      };
    });
  });
}

const TERCILE_MEMBERSHIP: Record<TercileGroupId, (o: V2Observation) => boolean> = {
  'volatility-tercile-1': (o) => o.tercile === 1,
  'volatility-tercile-2': (o) => o.tercile === 2,
  'volatility-tercile-3': (o) => o.tercile === 3,
};

/** v1's statistics under v2's names: the baseline is whatever the row says it is. */
export interface BaselineStats {
  observations: number;
  distinctAssets: number;
  distinctDates: number;
  mean: number | null;
  median: number | null;
  positiveFraction: number | null;
  baselineMean: number | null;
  meanDifferenceVsBaseline: number | null;
  medianDifferenceVsBaseline: number | null;
  fractionAboveBaseline: number | null;
  meanDifferenceVsBenchmark: number | null;
}

export function againstBaseline(points: readonly ResearchPoint[]): BaselineStats {
  const stats = summarize(points);
  return {
    observations: stats.observations,
    distinctAssets: stats.distinctAssets,
    distinctDates: stats.distinctDates,
    mean: stats.mean,
    median: stats.median,
    positiveFraction: stats.positiveFraction,
    baselineMean: stats.sameDateUniverseMean,
    meanDifferenceVsBaseline: stats.meanDifferenceVsUniverse,
    medianDifferenceVsBaseline: stats.medianDifferenceVsUniverse,
    fractionAboveBaseline: stats.fractionAboveUniverse,
    meanDifferenceVsBenchmark: stats.meanDifferenceVsBenchmark,
  };
}

export interface V2HorizonResults {
  horizon: ResearchHorizon;
  outcomes: Record<ResearchOutcome['status'], number>;
  /** Measured observations whose same-date tercile had no AVAILABLE outcome: excluded. */
  withoutBaseline: number;
  groups: Record<V2GroupId, BaselineStats>;
  byYear: Record<V2GroupId, Record<string, BaselineStats>>;
  byAsset: Record<
    V2GroupId,
    { concentration: ReturnType<typeof concentration>; assets: Record<string, BaselineStats> }
  >;
}

export function v2HorizonResults(
  observations: readonly V2Observation[],
  horizon: ResearchHorizon,
  benchmark: ReadonlyMap<string, number | null>,
): V2HorizonResults {
  const outcomes = { AVAILABLE: 0, PENDING: 0, MISSING: 0, INVALID: 0 };
  for (const observation of observations) outcomes[observation.outcomes[horizon].status] += 1;
  const measured = observations.filter((o) => o.outcomes[horizon].status === 'AVAILABLE');
  const dateMeans = meansBy(measured, horizon, (o) => o.session);
  const tercileMeans = meansBy(measured, horizon, (o) => `${o.session}|${o.tercile}`);
  let withoutBaseline = 0;
  const points = (
    members: readonly V2Observation[],
    baselineOf: (o: V2Observation) => number | undefined,
  ) =>
    members.flatMap((o): ResearchPoint[] => {
      const baseline = baselineOf(o);
      if (baseline === undefined) {
        withoutBaseline += 1;
        return [];
      }
      return [
        {
          ticker: o.ticker,
          session: o.session,
          change: o.outcomes[horizon].change ?? Number.NaN,
          baseline,
          benchmark: benchmark.get(o.session) ?? null,
        },
      ];
    });
  const pointsByGroup = new Map<V2GroupId, ResearchPoint[]>([
    ...TERCILE_GROUPS.map(
      (id) =>
        [
          id,
          points(measured.filter(TERCILE_MEMBERSHIP[id]), (o) => dateMeans.get(o.session)),
        ] as const,
    ),
    ...MATCHED_GROUPS.map(
      (id) =>
        [
          id,
          points(measured.filter(GROUP_MEMBERSHIP[id]), (o) =>
            tercileMeans.get(`${o.session}|${o.tercile}`),
          ),
        ] as const,
    ),
  ]);
  const ids = [...pointsByGroup.keys()];
  const each = <T>(build: (points: ResearchPoint[]) => T) =>
    Object.fromEntries(ids.map((id) => [id, build(pointsByGroup.get(id) ?? [])])) as Record<
      V2GroupId,
      T
    >;
  const sortedGroups = (group: ResearchPoint[], key: (p: ResearchPoint) => string) =>
    Object.fromEntries(
      [...groupBy(group, key)]
        .sort(([a], [b]) => compareTickers(a, b))
        .map(([name, members]) => [name, againstBaseline(members)]),
    );
  return {
    horizon,
    outcomes,
    withoutBaseline,
    groups: each(againstBaseline),
    byYear: each((group) => sortedGroups(group, (p) => p.session.slice(0, 4))),
    byAsset: each((group) => ({
      concentration: concentration(group),
      assets: sortedGroups(group, (p) => p.ticker),
    })),
  };
}

/** For each v1 group, the share of its observations (any outcome status) in each tercile. */
export function composition(
  observations: readonly V2Observation[],
): Record<MatchedGroupId, { observations: number; terciles: [number, number, number] | null }> {
  return Object.fromEntries(
    MATCHED_GROUPS.map((id) => {
      const members = observations.filter(GROUP_MEMBERSHIP[id]);
      const share = (t: 1 | 2 | 3) =>
        members.filter((o) => o.tercile === t).length / members.length;
      return [
        id,
        {
          observations: members.length,
          terciles: members.length === 0 ? null : ([share(1), share(2), share(3)] as const),
        },
      ];
    }),
  ) as Record<MatchedGroupId, { observations: number; terciles: [number, number, number] | null }>;
}

export interface StudyResultsV2 extends ReturnType<typeof studyBase> {
  schemaVersion: '2';
  specificationId: string;
  studyId: string;
  evidenceType: string;
  specification: typeof RESEARCH_SPECIFICATION_V2;
  populations: Record<
    Population,
    {
      membersPerDate: { min: number; max: number };
      composition: ReturnType<typeof composition>;
      horizons: V2HorizonResults[];
    }
  >;
  /** Per evaluation date: each EVALUATED member's ATR/close, the measure terciles come from. */
  volatility: Array<{ session: string; members: Record<string, number> }>;
}

/** The whole v2 study on one parsed export. Pure: the same export always gives the same results. */
export function runStudyV2(file: TradingViewOhlcvExport, exportSha256: string): StudyResultsV2 {
  const study = prepareStudy(file);
  const volatility = new Map(
    study.replay.map((date, k) => [date.session, study.volatility[k] ?? new Map()] as const),
  );
  const population = (name: Population) => {
    const observations = populationObservations(study.observations, volatility, name);
    const perDate = [...groupBy(observations, (o) => o.session).values()].map((day) => day.length);
    return {
      membersPerDate: { min: Math.min(...perDate), max: Math.max(...perDate) },
      composition: composition(observations),
      horizons: RESEARCH_HORIZONS.map((horizon) =>
        v2HorizonResults(observations, horizon, study.benchmark(horizon)),
      ),
    };
  };
  return {
    schemaVersion: '2',
    specificationId: RESEARCH_SPECIFICATION_V2_ID,
    studyId: SPEC.studyId,
    evidenceType: SPEC.evidenceType,
    specification: SPEC,
    ...studyBase(file, exportSha256, study),
    populations: { all: population('all'), stocks: population('stocks') },
    volatility: study.replay.map((date, k) => ({
      session: date.session,
      members: Object.fromEntries(study.volatility[k] ?? []),
    })),
  };
}

/** Aggregates only: no ticker, price or per-asset figure. */
export function researchSummaryV2(results: StudyResultsV2) {
  const { exclusions, ...coverage } = results.coverage;
  return {
    specificationId: results.specificationId,
    studyId: results.studyId,
    basedOn: results.specification.basedOn,
    evaluationDates: results.evaluationDates,
    parity: { ...results.parity, mismatches: results.parity.mismatches.length },
    coverage: { ...coverage, membersWithExclusions: Object.keys(exclusions).length },
    populations: Object.fromEntries(
      Object.entries(results.populations).map(
        ([name, { membersPerDate, composition: mix, horizons }]) => [
          name,
          {
            membersPerDate,
            composition: mix,
            horizons: horizons.map(({ horizon, outcomes, withoutBaseline, groups }) => ({
              horizon,
              outcomes,
              withoutBaseline,
              groups,
            })),
          },
        ],
      ),
    ),
  };
}

export async function runScannerResearchV2(options: {
  file: string;
  outputDir: string;
  repositoryCommit: string;
  now?: () => number;
}) {
  const { file, exportSha256 } = await loadFrozenExport(options.file);
  const results = runStudyV2(file, exportSha256);
  return {
    ...(await writeStudy(
      results,
      RESEARCH_SPECIFICATION_V2_ID,
      options,
      renderScannerResearchV2Report,
    )),
    results,
  };
}
