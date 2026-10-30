import { esc, pct, pp, REPORT_STYLES, share, table, wrap, type Cell } from './reportStyles';
import type { GroupId, GroupStats, HorizonResults, StudyResults } from './scannerResearch';
import type {
  BaselineStats,
  StudyResultsV2,
  V2GroupId,
  V2HorizonResults,
} from './scannerResearchV2';

/**
 * The private HTML view of a retrospective scanner study: coverage and method
 * first, then every specified horizon and group, weak or negative results
 * included. Static markup; nothing loads from the network.
 */

const GROUP_LABELS: Record<GroupId, string> = {
  universe: 'Full scored universe',
  'long-setup': 'Long setup, every asset-date',
  'long-setup-transition': 'Long setup, new transitions only',
  'risk-warning': 'Risk warning, every asset-date',
  'risk-warning-transition': 'Risk warning, new transitions only',
  top5: 'Top 5 by rank',
  top10: 'Top 10 by rank',
  'rank-quintile-1': 'Rank quintile 1 (highest scores)',
  'rank-quintile-2': 'Rank quintile 2',
  'rank-quintile-3': 'Rank quintile 3',
  'rank-quintile-4': 'Rank quintile 4',
  'rank-quintile-5': 'Rank quintile 5 (lowest scores)',
  'benchmark-spy': 'SPY benchmark, one per date',
};

const LIMITATIONS = [
  'Retrospective historical research on the provider history as it was retrieved on 2026-10-29. It is not prospective evidence: the scanner did not record these readings at the time.',
  'No historical provider snapshots exist. Every past bar is today’s version of that bar, after any later corrections; what a provider would have served on each date is unknown.',
  'Prices are split-adjusted only. The model’s inputs (RSI, MACD histogram / close, ATR / close) and OPEN-to-OPEN ratios do not change under a uniform split factor, but adjusted prices are rounded after adjustment, and on a split date a live provider could have served unadjusted bars that us-equity-daily-v1 would have rejected.',
  'No dividend adjustment: changes are price-only and understate total return around ex-dividend dates, for the benchmark too.',
  'The universe is today’s configured list (selected in 2026 by ticker digest). Instruments delisted, renamed or not yet listed are absent, so survivorship and selection effects are not removed.',
  'Before 2026 the session calendar is the sessions present in the bars, not a published exchange calendar. Early closes before 2026 are unknown; they move the decision timestamp, never which bars the scanner sees.',
  'One provider, one retrieval, one roughly three-year period. Results may depend on that market period; nothing here says how the scanner behaves in another one.',
  'Observations overlap: consecutive dates share most of each horizon, standing setups repeat daily and same-date assets share market moves. Counts are not independent trials; no significance, p-value or confidence interval is reported.',
  'OPEN prices are reference prices, not fills: no spread, slippage, fees, liquidity or position sizing is modelled. Nothing here is a portfolio return, trade win rate or drawdown.',
  'A decline after a risk warning is not profit: no short position is assumed or measured.',
];

const CANNOT_ESTABLISH = [
  'Whether trading on the scanner would have been profitable after costs.',
  'Whether any difference is more than chance, given the dependent observations.',
  'Whether the scanner would behave the same on future data, on other instruments or in other periods.',
  'Whether point-in-time provider data would have produced the same scores.',
];

/** What a report cell holds; null renders as a dash. */
const STAT_HEADERS = [
  'Observations',
  'Assets',
  'Dates',
  'Mean',
  'Median',
  'Positive',
  'Same-date universe mean',
  'Mean Δ vs universe',
  'Median Δ vs universe',
  'Above universe',
  'Mean Δ vs SPY',
];

function statCells(stats: GroupStats): Cell[] {
  return [
    stats.observations,
    stats.distinctAssets,
    stats.distinctDates,
    pct(stats.mean),
    pct(stats.median),
    share(stats.positiveFraction),
    pct(stats.sameDateUniverseMean),
    pp(stats.meanDifferenceVsUniverse),
    pp(stats.medianDifferenceVsUniverse),
    share(stats.fractionAboveUniverse),
    pp(stats.meanDifferenceVsBenchmark),
  ];
}

function definitionList(entries: readonly (readonly [string, Cell])[]): string {
  return `<dl class="meta">${entries
    .map(([term, value]) => `<div><dt>${esc(term)}</dt><dd>${esc(value)}</dd></div>`)
    .join('')}</dl>`;
}

/** What the coverage section reads; every study version's results carry it. */
type CoverageInput = Pick<
  StudyResults,
  'studyId' | 'evidenceType' | 'specificationId' | 'export' | 'coverage' | 'parity'
> &
  Pick<StudyResults, 'calendar' | 'evaluationDates'> & {
    specification: {
      frozenAt: string;
      frozenBefore: string;
      data: { export: string };
      universe: { selectionRule: string };
      scanner: {
        scannerVersion: string;
        modelVersion: string;
        candlePolicyVersion: string;
        historyWindowSessions: number;
      };
      decision: { time: string };
      referencePrice: string;
      endpointPrice: string;
      horizonsSessions: readonly number[];
      benchmark: string;
    };
  };

function coverageSection(
  results: CoverageInput,
  horizons: readonly Pick<HorizonResults, 'horizon' | 'outcomes'>[],
): string {
  const { specification: spec, coverage, parity } = results;
  const method = definitionList([
    ['Study', `${results.studyId} · ${results.evidenceType}`],
    ['Specification ID', results.specificationId],
    ['Frozen', `${spec.frozenAt} · ${spec.frozenBefore}`],
    ['Export', `${spec.data.export} · sha256 ${results.export.sha256}`],
    [
      'Retrieval',
      `${results.export.retrieval.startedAt} → ${results.export.retrieval.completedAt}`,
    ],
    [
      'Universe',
      `${coverage.members} members: ${coverage.types.stock} stocks, ${coverage.types.etf} ETFs`,
    ],
    ['Selection rule', spec.universe.selectionRule],
    [
      'Calendar',
      `${results.calendar.observedSessions} observed sessions, ${results.calendar.first} → ${results.calendar.last}`,
    ],
    [
      'Evaluation dates',
      `${results.evaluationDates.count}: ${results.evaluationDates.first} → ${results.evaluationDates.last}`,
    ],
    [
      'Scanner',
      `${spec.scanner.scannerVersion} · model ${spec.scanner.modelVersion} · ${spec.scanner.candlePolicyVersion} · ${spec.scanner.historyWindowSessions}-session window`,
    ],
    ['Decision', spec.decision.time],
    ['Reference price', spec.referencePrice],
    [
      'Endpoint price',
      `${spec.endpointPrice}; horizons ${spec.horizonsSessions.join(', ')} sessions`,
    ],
    ['Benchmark', spec.benchmark],
    [
      'Scanner parity',
      `${parity.status}: replay equals importInputs + evaluateScan on ${parity.datesCompared} dates (${parity.first ?? '—'} → ${parity.last ?? '—'}), ${parity.mismatches.length} differences`,
    ],
  ]);
  const statuses = Object.entries(coverage.byStatus).filter(([, count]) => count > 0);
  const exclusions = Object.entries(coverage.exclusions).map(([ticker, counts]) => [
    ticker,
    Object.entries(counts)
      .map(([status, count]) => `${status} on ${count} dates`)
      .join(', '),
  ]);
  const signals = (['long', 'risk'] as const).map((kind) => {
    const counts = coverage.signals[kind];
    return [
      kind === 'long' ? 'Long setup' : 'Risk warning',
      counts.observations,
      counts.transitions,
      counts.onsetUnknown,
      counts.standing,
    ];
  });
  const outcomes = horizons.map(({ horizon, outcomes: counts }) => [
    `${horizon} session${horizon === 1 ? '' : 's'}`,
    counts.AVAILABLE,
    counts.PENDING,
    counts.MISSING,
    counts.INVALID,
  ]);
  return `<section class="panel"><h2>Coverage and methodology</h2>${method}</section>
<section class="panel"><h2>Coverage</h2>
<p class="muted">${esc(coverage.assetDates)} asset-dates. All ${esc(coverage.members)} members were evaluated on ${esc(coverage.fullyEvaluatedDates)} of ${esc(results.evaluationDates.count)} dates; the fewest on one date was ${esc(coverage.minEvaluatedPerDate)}.</p>
${table(['Scanner status', 'Asset-dates'], statuses)}
<h3>Members not evaluated on some dates</h3>
${exclusions.length > 0 ? table(['Member', 'Statuses'], exclusions) : '<p class="muted">None.</p>'}
<h3>Setup observations versus new transitions</h3>
${table(['Condition', 'Asset-date observations', 'New transitions', 'Onset unknown', 'Standing (repeated)'], signals)}
<h3>Outcome availability for evaluated asset-dates</h3>
${table(['Horizon', 'Available', 'Pending', 'Missing', 'Invalid'], outcomes)}
</section>`;
}

function horizonSection(horizon: HorizonResults): string {
  const ids = Object.keys(horizon.groups) as GroupId[];
  const groups = table(
    ['Group', ...STAT_HEADERS],
    ids.map((id) => [GROUP_LABELS[id], ...statCells(horizon.groups[id])]),
  );
  const byType = table(
    ['Group', 'Type', ...STAT_HEADERS],
    Object.entries(horizon.byType).flatMap(([id, types]) =>
      (['stock', 'etf'] as const).map((type) => [
        GROUP_LABELS[id as GroupId],
        type === 'stock' ? 'Stocks' : 'ETFs',
        ...statCells(types[type]),
      ]),
    ),
  );
  const years = [
    ...new Set(Object.values(horizon.byYear).flatMap((rows) => Object.keys(rows))),
  ].sort((a, b) => a.localeCompare(b));
  const byYear = table(
    ['Group', ...years.map((year) => `${year}: n · mean · Δ vs universe`)],
    ids.map((id) => [
      GROUP_LABELS[id],
      ...years.map((year) => {
        const stats = horizon.byYear[id][year];
        return stats
          ? `${stats.observations} · ${pct(stats.mean)} · ${pp(stats.meanDifferenceVsUniverse)}`
          : '—';
      }),
    ]),
  );
  const perAsset = Object.entries(horizon.byAsset)
    .filter(([id]) => id !== 'universe')
    .map(([id, { concentration, assets }]) => {
      const rows = Object.entries(assets)
        .sort(([, a], [, b]) => b.observations - a.observations)
        .map(([ticker, stats]) => [ticker, ...statCells(stats)]);
      return `<details><summary>${esc(GROUP_LABELS[id as GroupId])}: ${rows.length} assets; the largest is ${share(concentration.largestAssetShare)} of observations; ${esc(concentration.assetsForHalf)} assets make up half</summary>${table(['Asset', ...STAT_HEADERS], rows)}</details>`;
    })
    .join('');
  const label = `${horizon.horizon} session${horizon.horizon === 1 ? '' : 's'}`;
  return `<section class="panel"><h2>${esc(label)}: OPEN after the decision → OPEN ${esc(label)} later</h2>
<p class="muted">Risk-warning rows show what prices did after a warning. A decline is not profit; no short position is assumed.</p>
${groups}
<h3>Stocks and ETFs, each against its own same-date universe</h3>${byType}
<h3>By calendar year of the evaluation date</h3>${byYear}
<h3>Per asset: concentration</h3>${perAsset}
</section>`;
}

type ReportMeta = { generatedAt: string; repositoryCommit: string; resultHash: string };

const list = (items: readonly string[]) =>
  wrap('ul', items.map((item) => wrap('li', esc(item))).join(''));

/** The standalone page every study version renders into. */
function page(
  results: { studyId: string; specificationId: string; specification: unknown },
  options: { title: string; specFile: string; body: string; limitations: readonly string[] },
  meta: ReportMeta,
): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>ZeroChart · Scanner study</title>
<style>
${REPORT_STYLES}
h3{font-size:14px;margin:18px 0 8px}table{min-width:900px}td{white-space:nowrap}.meta dd{white-space:normal}ul{margin:0;padding-left:20px}li{margin:4px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}
</style></head><body><main class="shell">
<div class="top"><div><div class="eyebrow">Private local research viewer · retrospective historical research, not prospective evidence</div><h1>${esc(options.title)}</h1><p class="muted">${esc(results.studyId)} · specification ${esc(results.specificationId.slice(0, 12))}</p></div>
<div class="privacy">Private research data derived from the owner's TradingView export. Keep this report local; share only aggregate figures, after review.</div></div>
${options.body}
<section class="panel"><h2>Limitations</h2>${list(options.limitations)}<h3>What this study cannot establish</h3>${list(CANNOT_ESTABLISH)}</section>
<section class="panel"><h2>Frozen specification</h2><details><summary>${esc(options.specFile)}</summary><pre>${esc(JSON.stringify(results.specification, null, 2))}</pre></details></section>
<footer>Standalone local export · No network, scripts, fonts or API calls · Result ${esc(meta.resultHash)} · Commit ${esc(meta.repositoryCommit)} · Generated ${esc(meta.generatedAt)}</footer>
</main></body></html>`;
}

export function renderScannerResearchReport(results: StudyResults, meta: ReportMeta): string {
  const body = `${coverageSection(results, results.horizons)}
${results.horizons.map(horizonSection).join('\n')}`;
  return page(
    results,
    {
      title: 'Scanner signal study',
      specFile: 'docs/scanner-research.v1.json',
      body,
      limitations: LIMITATIONS,
    },
    meta,
  );
}

const V2_GROUP_LABELS: Record<V2GroupId, string> = {
  'volatility-tercile-1': 'Volatility tercile 1 (quietest), vs same-date population',
  'volatility-tercile-2': 'Volatility tercile 2, vs same-date population',
  'volatility-tercile-3': 'Volatility tercile 3 (most volatile), vs same-date population',
  universe: 'Full population, vs own tercile',
  'long-setup': 'Long setup, every asset-date, vs own tercile',
  'long-setup-transition': 'Long setup, new transitions, vs own tercile',
  'risk-warning': 'Risk warning, every asset-date, vs own tercile',
  'risk-warning-transition': 'Risk warning, new transitions, vs own tercile',
  top5: 'Top 5 by rank, vs own tercile',
  top10: 'Top 10 by rank, vs own tercile',
  'rank-quintile-1': 'Rank quintile 1 (highest scores), vs own tercile',
  'rank-quintile-2': 'Rank quintile 2, vs own tercile',
  'rank-quintile-3': 'Rank quintile 3, vs own tercile',
  'rank-quintile-4': 'Rank quintile 4, vs own tercile',
  'rank-quintile-5': 'Rank quintile 5 (lowest scores), vs own tercile',
};

const BASELINE_HEADERS = [
  'Observations',
  'Assets',
  'Dates',
  'Mean',
  'Median',
  'Positive',
  'Baseline mean',
  'Mean Δ vs baseline',
  'Median Δ vs baseline',
  'Above baseline',
  'Mean Δ vs SPY',
];

function baselineCells(stats: BaselineStats): Cell[] {
  return [
    stats.observations,
    stats.distinctAssets,
    stats.distinctDates,
    pct(stats.mean),
    pct(stats.median),
    share(stats.positiveFraction),
    pct(stats.baselineMean),
    pp(stats.meanDifferenceVsBaseline),
    pp(stats.medianDifferenceVsBaseline),
    share(stats.fractionAboveBaseline),
    pp(stats.meanDifferenceVsBenchmark),
  ];
}

const V2_LIMITATIONS = [
  ...LIMITATIONS,
  "v2 was specified after v1's results were seen and runs on the same data: it can explain v1's differences on this export, not confirm them independently.",
  'Volatility is one reading, ATR(14) / close on the evaluation date, split into three coarse groups; it is not beta, and members of one tercile still differ in volatility.',
  'ETFs alone are not analysed: twelve members leave four per tercile.',
];

function v2HorizonSection(horizon: V2HorizonResults): string {
  const ids = Object.keys(horizon.groups) as V2GroupId[];
  const label = `${horizon.horizon} session${horizon.horizon === 1 ? '' : 's'}`;
  const years = [
    ...new Set(Object.values(horizon.byYear).flatMap((rows) => Object.keys(rows))),
  ].sort((a, b) => a.localeCompare(b));
  const byYear = table(
    ['Group', ...years.map((year) => `${year}: n · mean · Δ vs baseline`)],
    ids.map((id) => [
      V2_GROUP_LABELS[id],
      ...years.map((year) => {
        const stats = horizon.byYear[id][year];
        return stats
          ? `${stats.observations} · ${pct(stats.mean)} · ${pp(stats.meanDifferenceVsBaseline)}`
          : '—';
      }),
    ]),
  );
  const perAsset = ids
    .filter((id) => id !== 'universe')
    .map((id) => {
      const { concentration, assets } = horizon.byAsset[id];
      const rows = Object.entries(assets)
        .sort(([, a], [, b]) => b.observations - a.observations)
        .map(([ticker, stats]) => [ticker, ...baselineCells(stats)]);
      return `<details><summary>${esc(V2_GROUP_LABELS[id])}: ${rows.length} assets; the largest is ${share(concentration.largestAssetShare)} of observations; ${esc(concentration.assetsForHalf)} assets make up half</summary>${table(['Asset', ...BASELINE_HEADERS], rows)}</details>`;
    })
    .join('');
  return `<h3>${esc(label)}: OPEN after the decision → OPEN ${esc(label)} later</h3>
<p class="muted">${esc(horizon.withoutBaseline)} measured observations had no same-date tercile baseline. Risk-warning rows show what prices did after a warning; a decline is not profit.</p>
${table(
  ['Group', ...BASELINE_HEADERS],
  ids.map((id) => [V2_GROUP_LABELS[id], ...baselineCells(horizon.groups[id])]),
)}
<h3>${esc(label)} by calendar year of the evaluation date</h3>${byYear}
<h3>${esc(label)} per asset: concentration</h3>${perAsset}`;
}

export function renderScannerResearchV2Report(results: StudyResultsV2, meta: ReportMeta): string {
  const spec = results.specification;
  const method = definitionList([
    ['Based on', `${spec.basedOn.studyId} · ${spec.basedOn.specificationId}`],
    ['Interpretation', spec.interpretation],
    ['Volatility', spec.volatility.measure],
    ['Terciles', `${spec.volatility.terciles}. ${spec.volatility.whyTerciles}`],
    ['Population: all', spec.populations.all],
    ['Population: stocks', spec.populations.stocks],
    ['Not analysed', spec.populations.excluded],
    ['Volatility-matched baseline', spec.comparisons.volatilityMatchedBaseline],
    ['Tercile rows', spec.comparisons.volatilityTercileBaseline],
    ['Rank groups', spec.signals.rankGroups],
    ['Not repeated', spec.comparisons.notRepeated],
  ]);
  const populations = (Object.keys(results.populations) as Array<keyof typeof results.populations>)
    .map((name) => {
      const population = results.populations[name];
      const mix = Object.entries(population.composition).map(([id, { observations, terciles }]) => [
        V2_GROUP_LABELS[id as V2GroupId].replace(', vs own tercile', ''),
        observations,
        share(terciles?.[0] ?? null),
        share(terciles?.[1] ?? null),
        share(terciles?.[2] ?? null),
      ]);
      return `<section class="panel"><h2>Population: ${esc(name === 'all' ? 'all members' : 'stocks only')}</h2>
<p class="muted">${esc(population.membersPerDate.min)}–${esc(population.membersPerDate.max)} evaluated members per date.</p>
<h3>Where each group sits by volatility (share of its asset-date observations)</h3>
${table(['Group', 'Observations', 'Tercile 1 (quietest)', 'Tercile 2', 'Tercile 3 (most volatile)'], mix)}
${population.horizons.map(v2HorizonSection).join('\n')}
</section>`;
    })
    .join('\n');
  const body = `${coverageSection(results, results.populations.all.horizons)}
<section class="panel"><h2>v2 method</h2>${method}</section>
${populations}`;
  return page(
    results,
    {
      title: 'Scanner signal study · v2, volatility-matched',
      specFile: 'docs/scanner-research.v2.json',
      body,
      limitations: V2_LIMITATIONS,
    },
    meta,
  );
}
