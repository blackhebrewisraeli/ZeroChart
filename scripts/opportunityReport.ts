import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  analyzeOpportunityCampaign,
  OPPORTUNITY_BOOTSTRAP,
  type OpportunityAnalysis,
  type OpportunityInsufficientReason,
} from './opportunityAnalysis';
import { loadOpportunityCampaign, opportunityCampaignStatus } from './opportunityCampaign';
import { loadOpportunityOutcomes } from './opportunityOutcomes';
import {
  loadOpportunitySpecification,
  type OpportunityRuntimeConfig,
} from './opportunitySpecification';
import { esc, pct, pp, REPORT_STYLES, share, table } from './reportStyles';

/** docs/opportunity-radar.v1.json `checkpoints.operational`. */
const OPERATIONAL_CHECKPOINT_SLOTS = 90;

export type OpportunityPhase =
  'NOT_STARTED' | 'COLLECTING' | 'OPERATIONAL_REVIEW' | 'DECISION_GATE_ELIGIBLE';

type CampaignStatus = Awaited<ReturnType<typeof opportunityCampaignStatus>>;

/** Operational health only: every field is a count, a status or campaign identity. */
export interface OpportunityOperationalReport {
  mode: 'OPERATIONAL';
  generatedAt: string;
  campaign: {
    campaignId: string;
    specificationId: string;
    implementationCommit: string;
    startSlot: string;
    endSlot: string;
    universeSize: number;
  };
  phase: OpportunityPhase;
  slots: CampaignStatus['slots'];
  failedAttempts: number;
  reproduction: CampaignStatus['reproduction'];
  outcomes: {
    records: number;
    available: number;
    missing: number;
    invalid: number;
    conflicts: number;
  };
  gate: {
    eligible: boolean;
    /** Sample and integrity reasons only; the signal result is never part of this view. */
    insufficientReasons: OpportunityInsufficientReason[];
    values: OpportunityAnalysis['gate'];
    requirements: OpportunityRuntimeConfig['decisionGate'];
  };
}

export interface OpportunityFinalReport extends Omit<OpportunityOperationalReport, 'mode'> {
  mode: 'FINAL';
  decision: { status: 'FAIL' | 'PASS_FOR_OWNER_REVIEW'; reasons: string[] };
  performance: NonNullable<OpportunityAnalysis['performance']>;
  bootstrap: typeof OPPORTUNITY_BOOTSTRAP;
  limitations: string[];
}

export type OpportunityReport = OpportunityOperationalReport | OpportunityFinalReport;

/** `--final` before the frozen sample and integrity gate is met. */
export class OpportunityReportRefusal extends Error {
  readonly code = 'FINAL_REPORT_REFUSED' as const;

  constructor(
    readonly phase: OpportunityPhase,
    readonly reasons: readonly OpportunityInsufficientReason[],
  ) {
    super(`The final report is refused until the decision gate is met: ${reasons.join(', ')}`);
    this.name = 'OpportunityReportRefusal';
  }
}

function nested(value: unknown, ...keys: string[]): string {
  let current = value;
  for (const key of keys) current = (current as Record<string, unknown> | undefined)?.[key];
  if (typeof current !== 'string') throw new Error(`Specification text missing: ${keys.join('.')}`);
  return current;
}

/**
 * The report model. Without `final` it is operational health only. With
 * `final` it refuses unless the frozen sample and integrity gate is met, and
 * then carries every primary and secondary result, favorable or not.
 */
export async function buildOpportunityReport(options: {
  campaignId: string;
  store: string;
  final?: boolean;
  now?: () => number;
  specificationPath?: string;
}): Promise<OpportunityReport> {
  const now = options.now ?? Date.now;
  const { directory, manifest, runtime } = await loadOpportunityCampaign(
    options.store,
    options.campaignId,
    options.specificationPath,
  );
  const status = await opportunityCampaignStatus({ ...options, now });
  const { records, conflicts } = await loadOpportunityOutcomes(directory, manifest.specificationId);
  const calendarSlots = status.slots.due - status.slots.pending;
  const analysis = analyzeOpportunityCampaign({
    records,
    integrity: {
      calendarSlots,
      completedSlots: status.slots.completed,
      reproducedSlots: status.reproduction.match,
      conflicts,
    },
    gate: runtime.decisionGate,
    primaryHorizonDays: runtime.opportunity.primaryHorizonDays,
  });
  const eligible = analysis.status !== 'INSUFFICIENT';
  const phase: OpportunityPhase =
    status.slots.due === 0
      ? 'NOT_STARTED'
      : eligible
        ? 'DECISION_GATE_ELIGIBLE'
        : calendarSlots >= OPERATIONAL_CHECKPOINT_SLOTS
          ? 'OPERATIONAL_REVIEW'
          : 'COLLECTING';
  const count = (value: string) =>
    records.filter((record) => record.outcome.status === value).length;
  const operational: OpportunityOperationalReport = {
    mode: 'OPERATIONAL',
    generatedAt: status.asOf,
    campaign: {
      campaignId: manifest.campaignId,
      specificationId: manifest.specificationId,
      implementationCommit: manifest.implementationCommit,
      startSlot: manifest.startSlot,
      endSlot: manifest.endSlot,
      universeSize: manifest.universe.length,
    },
    phase,
    slots: status.slots,
    failedAttempts: status.failedAttempts,
    reproduction: status.reproduction,
    outcomes: {
      records: records.length,
      available: count('AVAILABLE'),
      missing: count('MISSING'),
      invalid: count('INVALID'),
      conflicts,
    },
    gate: {
      eligible,
      insufficientReasons: eligible ? [] : (analysis.reasons as OpportunityInsufficientReason[]),
      values: analysis.gate,
      requirements: runtime.decisionGate,
    },
  };
  if (!options.final) return operational;
  if (!eligible || analysis.performance === null) {
    throw new OpportunityReportRefusal(phase, operational.gate.insufficientReasons);
  }

  const { specification } = await loadOpportunitySpecification(options.specificationPath);
  return {
    ...operational,
    mode: 'FINAL',
    decision: {
      status: analysis.status as OpportunityFinalReport['decision']['status'],
      reasons: analysis.reasons,
    },
    performance: analysis.performance,
    bootstrap: OPPORTUNITY_BOOTSTRAP,
    limitations: [
      nested(specification, 'interpretation'),
      nested(specification, 'analysis', 'dependence'),
      nested(specification, 'analysis', 'uncertainty'),
      nested(specification, 'outcomes', 'costModel', 'note'),
      nested(specification, 'checkpoints', 'decisionGate', 'result'),
      'Excess is the Opportunity net change minus the benchmark gross change over identical timestamps: only the Opportunity bears the frozen 30 bps.',
      `The bootstrap draws ${OPPORTUNITY_BOOTSTRAP.blockDays}-day blocks over the calendar from the first to the last Opportunity date (${OPPORTUNITY_BOOTSTRAP.prng}, seed ${OPPORTUNITY_BOOTSTRAP.seed}); days near either end are drawn less often.`,
    ],
  };
}

/** What the CLI prints: counts and phase statuses only, never results or paths to evidence. */
export function opportunityReportSummary(report: OpportunityReport) {
  return {
    mode: report.mode,
    phase: report.phase,
    campaignId: report.campaign.campaignId,
    asOf: report.generatedAt,
    slots: report.slots,
    failedAttempts: report.failedAttempts,
    reproduction: report.reproduction,
    outcomes: report.outcomes,
    decisionGateEligible: report.gate.eligible,
    ...(report.mode === 'FINAL' ? { decision: report.decision.status } : {}),
  };
}

const PHASE_TEXT: Record<OpportunityPhase, string> = {
  NOT_STARTED: 'No slot is due yet.',
  COLLECTING: `Collecting daily slots. The operational checkpoint comes after ${OPERATIONAL_CHECKPOINT_SLOTS} calendar slots.`,
  OPERATIONAL_REVIEW:
    'Review collection and reproduction health only. No performance decision is made here.',
  DECISION_GATE_ELIGIBLE:
    'The frozen sample and integrity gate is met. Results appear only in the final report, generated with --final.',
};

const badge = (label: string, tone: 'good' | 'warn' | 'bad' | 'info') =>
  `<span class="badge ${tone}">${esc(label.replaceAll('_', ' '))}</span>`;

function metaList(entries: ReadonlyArray<readonly [string, string | number]>): string {
  return `<dl class="meta">${entries
    .map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`)
    .join('')}</dl>`;
}

function gateTable(gate: OpportunityOperationalReport['gate']): string {
  const { values, requirements } = gate;
  const met = (ok: boolean) => (ok ? 'Met' : 'Not met');
  return table(
    ['Condition', 'Current', 'Required', 'Status'],
    [
      [
        'Calendar slots',
        values.calendarSlots,
        `≥ ${requirements.minimumCalendarSlots}`,
        met(values.calendarSlots >= requirements.minimumCalendarSlots),
      ],
      [
        'Matured primary outcomes',
        values.maturedPrimaryOutcomes,
        `≥ ${requirements.minimumMaturedPrimaryOutcomes}`,
        met(values.maturedPrimaryOutcomes >= requirements.minimumMaturedPrimaryOutcomes),
      ],
      [
        'Distinct assets',
        values.distinctAssets,
        `≥ ${requirements.minimumDistinctAssets}`,
        met(values.distinctAssets >= requirements.minimumDistinctAssets),
      ],
      [
        'Distinct Opportunity months',
        values.distinctOpportunityMonths,
        `≥ ${requirements.minimumDistinctOpportunityMonths}`,
        met(values.distinctOpportunityMonths >= requirements.minimumDistinctOpportunityMonths),
      ],
      [
        'Largest single-asset share',
        share(values.maximumSingleAssetShare),
        `≤ ${share(requirements.maximumSingleAssetShare)}`,
        met(!gate.insufficientReasons.includes('SINGLE_ASSET_SHARE_ABOVE_MAXIMUM')),
      ],
      [
        'Completed slots',
        share(values.completedSlotFraction),
        `≥ ${share(requirements.minimumCompletedSlotFraction)}`,
        met(!gate.insufficientReasons.includes('COMPLETED_SLOTS_BELOW_MINIMUM')),
      ],
      [
        'Completed slots reproduced offline',
        values.allCompletedSlotsReproduced ? 'All' : 'Not all',
        'All',
        met(values.allCompletedSlotsReproduced),
      ],
      ['Immutable-evidence conflicts', values.conflicts, '0', met(values.conflicts === 0)],
    ],
  );
}

function finalSections(report: OpportunityFinalReport): string {
  const { primary, horizons, entryZoneEnteredFraction } = report.performance;
  const interval = primary.bootstrapExcessVsBtc;
  const decision = report.decision;
  return `<section class="panel" id="decision"><h2>Decision</h2><p>${badge(decision.status, decision.status === 'PASS_FOR_OWNER_REVIEW' ? 'good' : 'bad')}</p>
<p class="muted">${esc(decision.reasons.length === 0 ? 'Every frozen primary condition held. Passing authorizes an owner review only; nothing trades.' : `Failed conditions: ${decision.reasons.join(', ')}`)}</p></section>
<section class="panel" id="primary-results"><h2>Primary result: ${esc(primary.horizonDays)}-day OPEN to OPEN</h2>${table(
    ['Measure', 'Value'],
    [
      ['Opportunities measured / matured', `${primary.available} / ${primary.matured}`],
      ['Mean net change', pct(primary.meanNetChangePct)],
      ['Median net change', pct(primary.medianNetChangePct)],
      ['Mean excess vs BTC', pp(primary.meanExcessVsBtcPp)],
      ['Mean excess vs equal-weight eligible universe', pp(primary.meanExcessVsEqualWeightPp)],
      [
        `${report.bootstrap.confidence * 100}% moving-block bootstrap, mean excess vs BTC`,
        `${pp(interval.lower)} to ${pp(interval.upper)} (${interval.observations} Opportunities over ${interval.calendarDays} days; ${interval.emptyResamples} empty resamples)`,
      ],
    ],
  )}</section>
<section class="panel" id="horizons"><h2>Every frozen horizon</h2>${table(
    [
      'Horizon',
      'Matured',
      'Available',
      'Mean net',
      'Median net',
      'Excess vs BTC',
      'Excess vs EW',
      'Positive',
      'Above BTC',
      'Above EW',
      'Mean favorable',
      'Mean adverse',
      'Invalidation touched',
      'Median days to touch',
    ],
    horizons.map((item) => [
      `${item.horizonDays} days${item.horizonDays === primary.horizonDays ? ' (primary)' : ''}`,
      item.matured,
      item.available,
      pct(item.meanNetChangePct),
      pct(item.medianNetChangePct),
      pp(item.meanExcessVsBtcPp),
      pp(item.meanExcessVsEqualWeightPp),
      share(item.fractionPositive),
      share(item.fractionAboveBtc),
      share(item.fractionAboveEqualWeight),
      pct(item.meanMaxFavorableExcursionPct),
      pct(item.meanMaxAdverseExcursionPct),
      share(item.invalidationTouchedFraction),
      item.medianDaysToInvalidation,
    ]),
  )}
<p class="muted">Entry zone reached on one of the first three opens: ${esc(share(entryZoneEnteredFraction))} of primary Opportunities. Every Opportunity is measured from the next open whether or not it entered.</p></section>
<section class="panel" id="limitations"><h2>Limitations</h2><ul>${report.limitations.map((item) => `<li>${esc(item)}</li>`).join('')}</ul></section>`;
}

/** A standalone page with no scripts, fonts or network access. */
export function renderOpportunityReport(report: OpportunityReport): string {
  const { campaign, slots, reproduction, outcomes } = report;
  const metrics = [
    ['Scheduled', slots.scheduled],
    ['Due', slots.due],
    ['Completed', slots.completed],
    ['Pending', slots.pending],
    ['Missed', slots.missed],
    ['Failed attempts', report.failedAttempts],
  ] as const;
  const withheld = `<section class="panel" id="performance-withheld"><h2>Results withheld</h2><p class="muted">${esc(
    report.gate.eligible
      ? 'The decision gate is met. Generate the final report with --final to see every frozen result.'
      : 'Until the frozen decision gate is met, this report shows operational health only.',
  )}</p></section>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>ZeroChart · Opportunity Radar</title>
<style>
${REPORT_STYLES}
table{min-width:0}td{overflow-wrap:anywhere}#horizons table{min-width:1200px}#horizons td{white-space:nowrap}ul{margin:0;padding-left:20px}li{margin:6px 0}
</style></head><body><main class="shell">
<div class="top"><div><div class="eyebrow">Private local research viewer · ${esc(report.mode === 'FINAL' ? 'final report' : 'operational report')}</div><h1>Opportunity Radar v1</h1><p class="muted">${esc(campaign.campaignId)} · specification ${esc(campaign.specificationId.slice(0, 12))} · as of ${esc(report.generatedAt)}</p></div>
<div class="privacy">Private campaign evidence. Keep this report local and share only after deliberate review.</div></div>
<section class="grid">${metrics.map(([label, value]) => `<div class="metric"><span class="muted">${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('')}</section>
<section class="panel"><h2>Phase</h2><p>${badge(report.phase, report.phase === 'DECISION_GATE_ELIGIBLE' ? 'good' : 'info')}</p><p class="muted">${esc(report.mode === 'FINAL' ? 'The frozen sample and integrity gate is met. Every frozen result follows, favorable or not.' : PHASE_TEXT[report.phase])}</p></section>
<section class="panel"><h2>Decision gate progress</h2>${gateTable(report.gate)}</section>
<section class="panel"><h2>Evidence health</h2>${metaList([
    ['Reproduced offline (MATCH)', reproduction.match],
    ['Reproduction mismatches', reproduction.mismatch],
    ['Completed, not yet reproduced', reproduction.notReproduced],
    ['Outcome records', outcomes.records],
    [
      'Outcome records available / missing / invalid',
      `${outcomes.available} / ${outcomes.missing} / ${outcomes.invalid}`,
    ],
    ['Conflicting records detected', outcomes.conflicts],
  ])}</section>
<section class="panel"><h2>Campaign</h2>${metaList([
    ['Campaign', campaign.campaignId],
    ['Specification', campaign.specificationId],
    ['Implementation commit', campaign.implementationCommit],
    ['First slot', campaign.startSlot],
    ['Last slot', campaign.endSlot],
    ['Frozen universe', `${campaign.universeSize} Binance Spot USDT pairs`],
  ])}</section>
${report.mode === 'FINAL' ? finalSections(report) : withheld}
<footer>Standalone local export · No network, scripts, fonts or API calls · Generated ${esc(report.generatedAt)}</footer>
</main></body></html>
`;
}

export async function writeOpportunityReport(
  report: OpportunityReport,
  outputPath: string,
): Promise<string> {
  const target = resolve(outputPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, renderOpportunityReport(report), { encoding: 'utf8', mode: 0o600 });
  return target;
}
