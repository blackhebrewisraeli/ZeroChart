import { REPORT_STYLES } from './decisionsReport';
import type { GroupId, GroupStats, HorizonResults, StudyResults } from './scannerResearch';

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

function esc(value: unknown): string {
  return String(value ?? '—')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function signed(value: number | null, digits: number, unit: string): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}${unit}`;
}

const pct = (value: number | null) => signed(value, 2, '%');
const pp = (value: number | null) => signed(value, 2, ' pp');
const share = (value: number | null) =>
  value === null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(1)}%`;

function table(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const head = headers.map((header) => `<th>${esc(header)}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`)
    .join('');
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

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

function statCells(stats: GroupStats): unknown[] {
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

function definitionList(entries: readonly (readonly [string, unknown])[]): string {
  return `<dl class="meta">${entries
    .map(([term, value]) => `<div><dt>${esc(term)}</dt><dd>${esc(value)}</dd></div>`)
    .join('')}</dl>`;
}

function coverageSection(results: StudyResults): string {
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
  const outcomes = results.horizons.map(({ horizon, outcomes: counts }) => [
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
  ].sort();
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

export function renderScannerResearchReport(
  results: StudyResults,
  meta: { generatedAt: string; repositoryCommit: string; resultHash: string },
): string {
  const list = (items: readonly string[]) =>
    `<ul>${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>ZeroChart · Scanner study</title>
<style>
${REPORT_STYLES}
h3{font-size:14px;margin:18px 0 8px}table{min-width:900px}td{white-space:nowrap}.meta dd{white-space:normal}ul{margin:0;padding-left:20px}li{margin:4px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}
</style></head><body><main class="shell">
<div class="top"><div><div class="eyebrow">Private local research viewer · retrospective historical research, not prospective evidence</div><h1>Scanner signal study</h1><p class="muted">${esc(results.studyId)} · specification ${esc(results.specificationId.slice(0, 12))}</p></div>
<div class="privacy">Private research data derived from the owner's TradingView export. Keep this report local; share only aggregate figures, after review.</div></div>
${coverageSection(results)}
${results.horizons.map(horizonSection).join('\n')}
<section class="panel"><h2>Limitations</h2>${list(LIMITATIONS)}<h3>What this study cannot establish</h3>${list(CANNOT_ESTABLISH)}</section>
<section class="panel"><h2>Frozen specification</h2><details><summary>docs/scanner-research.v1.json</summary><pre>${esc(JSON.stringify(results.specification, null, 2))}</pre></details></section>
<footer>Standalone local export · No network, scripts, fonts or API calls · Result ${esc(meta.resultHash)} · Commit ${esc(meta.repositoryCommit)} · Generated ${esc(meta.generatedAt)}</footer>
</main></body></html>`;
}
