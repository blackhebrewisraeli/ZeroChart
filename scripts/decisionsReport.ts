import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  DAILY_TIMEFRAME,
  evaluateInput,
  normalizeEvaluationInput,
  type DecisionSnapshot,
  type EvaluationCandle,
  type EvaluationRun,
} from '@/lib/evaluationLab';
import { hashEvaluationConfig, hashEvaluationInput } from './evaluationStore';
import { configFor } from './evaluate-canonical';
import { loadCampaignEvidence, type CampaignAttempt } from './observationCampaign';
import {
  OUTCOME_SPECIFICATION,
  OUTCOME_SPECIFICATION_ID,
  loadCampaignOutcomes,
  measureOutcome,
  summarizeOutcomes,
  type OutcomeRecord,
} from './outcomeMeasurement';

export type EvidenceKind =
  | 'RECORDED_OBSERVATION'
  | 'OFFLINE_REPRODUCTION'
  | 'SYNTHETIC_DEMONSTRATION'
  | 'MISSING_OR_FAILED_DATA'
  | 'MISSING_REPRODUCTION';

interface ReportDecision extends DecisionSnapshot {
  slot: string;
  observedAt: string;
  freshnessMs: number | null;
  explanation: string;
  outcome: OutcomeRecord | null;
}

interface ReportObservation {
  slot: string;
  observedAt: string;
  attemptNumber: number;
  evidence: EvidenceKind;
  reproduction: {
    status: 'MATCH' | 'MISMATCH' | 'MISSING';
    reproducedAt: string | null;
    networkBlocked: boolean | null;
  };
  decisions: ReportDecision[];
}

export interface DecisionsReportModel {
  schemaVersion: '1';
  generatedAt: string;
  privacyNotice: string;
  campaign: {
    id: string;
    evidenceType: 'prospective-live' | 'synthetic-demonstration';
    repositoryCommit: string;
    strategyVersion: string;
    modelVersion: string;
    configurationId: string;
    candleValidationPolicyVersion: string;
    riskProfile: string;
    universe: readonly string[];
    source: string;
    timeframe: string;
    schedule: Record<string, unknown>;
    latestObservationTime: string | null;
    counts: {
      expected: number;
      completed: number;
      failed: number;
      missed: number;
      pending: number;
      retryAttempts: number;
    };
  };
  observations: ReportObservation[];
  failedAttempts: CampaignAttempt[];
  outcomes: {
    specificationId: string;
    frozenAt: string;
    summary: ReturnType<typeof summarizeOutcomes>;
  };
  errors: string[];
  limitations: string[];
}

function explain(decision: DecisionSnapshot): string {
  if (decision.selectionStatus === 'SELECTED') {
    return `Eligible and selected within the recorded holdings limit. The ${decision.allocatedAmount.toLocaleString('en-US', { maximumFractionDigits: 2 })} allocation is a proposal, not an order or fill.`;
  }
  if (decision.selectionStatus === 'QUALIFIED_NOT_SELECTED') {
    return 'Eligible under the recorded rules, but not selected because higher-ranked eligible assets filled the holdings limit.';
  }
  const reasons = decision.rejectionReasons.map((reason) => reason.detail).join(' ');
  return reasons || 'Not eligible under the recorded configuration.';
}

function reportDecision(
  decision: DecisionSnapshot,
  slot: string,
  observedAt: string,
  outcome: OutcomeRecord | null = null,
): ReportDecision {
  return {
    ...decision,
    inputSnapshot: [],
    slot,
    observedAt,
    freshnessMs: decision.dataAsOf === null ? null : decision.evaluationTime - decision.dataAsOf,
    explanation: explain(decision),
    outcome,
  };
}

function reproductionFor(
  reproductions: Array<Record<string, unknown>>,
  slot: string,
): ReportObservation['reproduction'] {
  const matches = reproductions
    .filter((item) => item['slot'] === slot)
    .sort((a, b) => String(a['reproducedAt']).localeCompare(String(b['reproducedAt'])));
  const latest = matches.at(-1);
  if (!latest) return { status: 'MISSING', reproducedAt: null, networkBlocked: null };
  return {
    status: latest['status'] === 'MATCH' ? 'MATCH' : 'MISMATCH',
    reproducedAt: typeof latest['reproducedAt'] === 'string' ? latest['reproducedAt'] : null,
    networkBlocked: typeof latest['networkBlocked'] === 'boolean' ? latest['networkBlocked'] : null,
  };
}

function redactString(value: string): string {
  const workspace = process.cwd();
  return value
    .replaceAll(workspace, '[workspace]')
    .replace(/\/(?:Users|home)\/[^\s"']+/g, '[local path]')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '[local path]');
}

function redact<T>(value: T): T {
  if (typeof value === 'string') return redactString(value) as T;
  if (Array.isArray(value)) return value.map(redact) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, redact(entry)]),
    ) as T;
  }
  return value;
}

export async function buildCampaignReportModel(
  campaignId: string,
  store: string,
  now = new Date(),
): Promise<DecisionsReportModel> {
  try {
    const { report, observations } = await loadCampaignEvidence(campaignId, store, now);
    const outcomes = await loadCampaignOutcomes(campaignId, store);
    const outcomesByDecision = new Map(
      outcomes.map((outcome) => [`${outcome.slot}:${outcome.asset}`, outcome]),
    );
    const reproductions = report.reproductions as Array<Record<string, unknown>>;
    const mapped = observations
      .map((observation) => ({
        slot: observation.slot,
        observedAt: observation.observedAt,
        attemptNumber: observation.attemptNumber,
        evidence: 'RECORDED_OBSERVATION' as const,
        reproduction: reproductionFor(reproductions, observation.slot),
        decisions: observation.run.decisions.map((decision) =>
          reportDecision(
            decision,
            observation.slot,
            observation.observedAt,
            outcomesByDecision.get(`${observation.slot}:${decision.asset}`) ?? null,
          ),
        ),
      }))
      .sort((a, b) => a.slot.localeCompare(b.slot));
    return redact({
      schemaVersion: '1',
      generatedAt: now.toISOString(),
      privacyNotice:
        'Private research data. Keep this exported report local and share only after deliberate review.',
      campaign: {
        id: report.campaignId,
        evidenceType: report.evidenceType,
        repositoryCommit: report.repositoryCommit,
        strategyVersion: report.strategyVersion,
        modelVersion: report.modelVersion,
        configurationId: report.configurationId,
        candleValidationPolicyVersion: report.candleValidationPolicyVersion,
        riskProfile: report.riskProfile,
        universe: report.universe,
        source: report.freshness.source,
        timeframe: DAILY_TIMEFRAME,
        schedule: report.schedule,
        latestObservationTime: mapped.at(-1)?.observedAt ?? null,
        counts: report.slots,
      },
      observations: mapped,
      failedAttempts: report.attempts.filter((attempt) => attempt.status === 'FAILED'),
      outcomes: {
        specificationId: OUTCOME_SPECIFICATION_ID,
        frozenAt: OUTCOME_SPECIFICATION.frozenAt,
        summary: summarizeOutcomes(outcomes),
      },
      errors: [],
      limitations: [
        'Recorded observations show operational and decision evidence, not investment performance.',
        'A loaded record is not a successful reproduction. Only a recorded MATCH is labeled successful.',
        'No return, win-rate, drawdown, profitability, or executed-order claims are included.',
        'Proposed allocations are research proposals. Planned ATR sizing stops are not executed orders.',
        'Forward price changes are signal research from reference OPEN prices, not simulated fills or executable trading performance.',
        'Repeated daily observations and overlapping horizons are correlated; sample counts are not independent trials.',
        'BTC differences are percentage-point relative performance, not risk-adjusted alpha.',
      ],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return redact({
      schemaVersion: '1',
      generatedAt: now.toISOString(),
      privacyNotice:
        'Private research data. Keep this exported report local and share only after deliberate review.',
      campaign: {
        id: campaignId,
        evidenceType: 'prospective-live',
        repositoryCommit: 'unavailable',
        strategyVersion: 'unavailable',
        modelVersion: 'unavailable',
        configurationId: 'unavailable',
        candleValidationPolicyVersion: 'unavailable',
        riskProfile: 'unavailable',
        universe: [],
        source: 'unavailable',
        timeframe: DAILY_TIMEFRAME,
        schedule: {},
        latestObservationTime: null,
        counts: { expected: 0, completed: 0, failed: 0, missed: 0, pending: 0, retryAttempts: 0 },
      },
      observations: [],
      failedAttempts: [],
      outcomes: {
        specificationId: OUTCOME_SPECIFICATION_ID,
        frozenAt: OUTCOME_SPECIFICATION.frozenAt,
        summary: summarizeOutcomes([]),
      },
      errors: [`Campaign artifacts failed integrity validation: ${detail}`],
      limitations: ['No decision evidence is displayed until the artifact error is corrected.'],
    });
  }
}

function demoCandles(evaluationTime: number, mode: 'strong' | 'weak'): EvaluationCandle[] {
  const count = 45;
  const day = 24 * 60 * 60 * 1000;
  const evaluationDay = Math.floor(evaluationTime / day) * day;
  const pivot = Math.floor(count * 0.72);
  return Array.from({ length: count }, (_, index) => {
    const timestamp = evaluationDay - (count - index) * day;
    const close =
      mode === 'strong'
        ? index < pivot
          ? 155 - index * 1.25
          : 115 + (index - pivot) * 1.4
        : 100 + Math.sin(index / 2) * 2;
    return { timestamp, closeTime: timestamp + day - 1, high: close + 1, low: close - 1, close };
  });
}

function syntheticRun(now: Date): EvaluationRun {
  const evaluationTime = now.getTime();
  const universe = ['CEDAR', 'EMBER', 'LANTERN'];
  const base = configFor('moderate', universe);
  const unhashed = {
    ...base,
    eligibility: { ...base.eligibility, minimumScore: 0 },
    allocation: { ...base.allocation, maxHoldings: 1 },
    configurationId: '',
  };
  const configuration = {
    ...unhashed,
    configurationId: hashEvaluationConfig(unhashed),
  };
  const input = normalizeEvaluationInput({
    evaluationTime,
    assets: [
      {
        ticker: 'CEDAR',
        source: 'synthetic-fixture',
        timeframe: DAILY_TIMEFRAME,
        candles: demoCandles(evaluationTime, 'strong'),
      },
      {
        ticker: 'EMBER',
        source: 'synthetic-fixture',
        timeframe: DAILY_TIMEFRAME,
        candles: demoCandles(evaluationTime, 'weak'),
      },
      {
        ticker: 'LANTERN',
        source: 'synthetic-fixture',
        timeframe: DAILY_TIMEFRAME,
        candles: [],
        error: 'Synthetic missing-data example.',
      },
    ],
  });
  return evaluateInput(input, configuration, hashEvaluationInput(input));
}

export function buildSyntheticReportModel(
  now = new Date('2026-10-25T12:00:00.000Z'),
): DecisionsReportModel {
  const observationTime = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);
  const run = syntheticRun(observationTime);
  const slot = new Date(run.evaluationTime).toISOString();
  const reference =
    Math.floor(run.evaluationTime / (24 * 60 * 60 * 1000)) * (24 * 60 * 60 * 1000) +
    24 * 60 * 60 * 1000;
  const researchCandles = Array.from({ length: 31 }, (_, index) => ({
    openTime: reference + index * 24 * 60 * 60 * 1000,
    closeTime: reference + (index + 1) * 24 * 60 * 60 * 1000 - 1,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100 + index,
  }));
  const syntheticOutcomes = run.decisions.flatMap((decision) =>
    decision.score === null
      ? []
      : [
          measureOutcome({
            campaignId: 'synthetic-decisions-demo',
            slot,
            runKey: run.runKey,
            observedAt: slot,
            decision,
            assetCandles: researchCandles,
            benchmarkCandles: researchCandles.map((candle, index) => ({
              ...candle,
              open: 100 + index / 2,
              high: 101 + index / 2,
              low: 99 + index / 2,
              close: 100 + index / 2,
            })),
            now,
            fetchedAt: now,
            synthetic: true,
          }),
        ],
  );
  return {
    schemaVersion: '1',
    generatedAt: now.toISOString(),
    privacyNotice:
      'Synthetic demonstration only. It contains invented assets and candles, not market history or prospective evidence.',
    campaign: {
      id: 'synthetic-decisions-demo',
      evidenceType: 'synthetic-demonstration',
      repositoryCommit: 'synthetic-not-applicable',
      strategyVersion: run.configuration.strategyVersion,
      modelVersion: run.configuration.modelVersion,
      configurationId: run.configuration.configurationId,
      candleValidationPolicyVersion:
        run.configuration.candleValidation?.policyVersion ?? 'legacy-unversioned',
      riskProfile: run.configuration.riskProfile,
      universe: run.configuration.universe,
      source: 'synthetic-fixture',
      timeframe: DAILY_TIMEFRAME,
      schedule: { cadence: 'one synthetic slot', timezone: 'UTC' },
      latestObservationTime: slot,
      counts: { expected: 1, completed: 1, failed: 0, missed: 0, pending: 0, retryAttempts: 0 },
    },
    observations: [
      {
        slot,
        observedAt: slot,
        attemptNumber: 1,
        evidence: 'SYNTHETIC_DEMONSTRATION',
        reproduction: { status: 'MISSING', reproducedAt: null, networkBlocked: null },
        decisions: run.decisions.map((decision) =>
          reportDecision(
            decision,
            slot,
            slot,
            syntheticOutcomes.find((outcome) => outcome.asset === decision.asset) ?? null,
          ),
        ),
      },
    ],
    failedAttempts: [],
    outcomes: {
      specificationId: OUTCOME_SPECIFICATION_ID,
      frozenAt: OUTCOME_SPECIFICATION.frozenAt,
      summary: summarizeOutcomes(syntheticOutcomes),
    },
    errors: [],
    limitations: [
      'All values in this demonstration are synthetic and must not be described as prospective evidence.',
      'The missing reproduction label is intentional: loading or generating a record is not reproduction.',
      'No performance or executed-trade evidence is shown.',
    ],
  };
}

function jsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

/** The private reports' shared dark stylesheet: standalone, no external fonts or assets. */
export const REPORT_STYLES = `:root{color-scheme:dark;--bg:#09090b;--panel:#18181b;--soft:#27272a;--border:#3f3f46;--text:#fafafa;--muted:#a1a1aa;--green:#34d399;--amber:#fbbf24;--red:#fb7185;--blue:#60a5fa}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button,input,select{font:inherit}a{color:inherit}.shell{max-width:1400px;margin:auto;padding:28px}.eyebrow{color:var(--muted);text-transform:uppercase;letter-spacing:.12em;font-size:11px}.top{display:flex;justify-content:space-between;gap:24px;align-items:flex-start}.privacy{max-width:460px;border:1px solid #854d0e;background:#42200655;color:#fde68a;padding:12px 14px;border-radius:10px}h1{font-size:30px;line-height:1.15;margin:5px 0 8px}h2{font-size:18px;margin:0 0 14px}p{margin:0}.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin:24px 0}.metric,.panel{border:1px solid var(--border);background:var(--panel);border-radius:12px}.metric{padding:14px}.metric strong{display:block;font-size:23px;margin-top:4px}.panel{padding:18px;margin:14px 0}.meta{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.meta dt{color:var(--muted);font-size:12px}.meta dd{margin:3px 0;overflow-wrap:anywhere}.filters{display:grid;grid-template-columns:2fr repeat(3,1fr);gap:10px;margin-bottom:14px}input,select{width:100%;color:var(--text);background:#09090b;border:1px solid var(--border);border-radius:8px;padding:10px}input:focus,select:focus,button:focus-visible,summary:focus-visible{outline:2px solid var(--blue);outline-offset:2px}.table-wrap{overflow:auto;border:1px solid var(--border);border-radius:10px}table{border-collapse:collapse;width:100%;min-width:1050px}th,td{padding:11px 12px;text-align:left;border-bottom:1px solid var(--soft);vertical-align:top}th{position:sticky;top:0;background:#202023;color:#d4d4d8;font-size:12px}tr:last-child td{border-bottom:0}.badge{display:inline-flex;border:1px solid var(--border);border-radius:999px;padding:2px 8px;font-size:11px;font-weight:700;white-space:nowrap}.good{color:var(--green);border-color:#065f46}.warn{color:var(--amber);border-color:#854d0e}.bad{color:var(--red);border-color:#881337}.info{color:var(--blue);border-color:#1e3a8a}.score{font-size:18px;font-weight:700}.components{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:8px;font-size:11px;color:var(--muted)}details{margin-top:8px}summary{cursor:pointer;color:#d4d4d8}.error{border-color:#9f1239;background:#4c051955;color:#fecdd3}.evidence{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.empty{padding:28px;text-align:center;color:var(--muted)}footer{padding:22px 0;color:var(--muted);font-size:12px}@media(max-width:850px){.shell{padding:16px}.top{display:block}.privacy{margin-top:16px}.grid{grid-template-columns:repeat(2,1fr)}.meta,.filters{grid-template-columns:1fr}.panel{padding:14px}h1{font-size:25px}}`;

export function renderDecisionsReport(model: DecisionsReportModel): string {
  const data = jsonForHtml(model);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>ZeroChart · Decisions &amp; Evidence</title>
<style>
${REPORT_STYLES}
</style></head><body><main class="shell"><div class="top"><div><div class="eyebrow">Private local research viewer</div><h1>Decisions &amp; Evidence</h1><p class="muted" id="subtitle"></p></div><div class="privacy" id="privacy"></div></div><section class="grid" id="metrics"></section><section class="panel"><h2>Campaign overview</h2><dl class="meta" id="meta"></dl></section><section class="panel" id="errors-panel" hidden><h2>Artifact errors</h2><div id="errors"></div></section><section class="panel"><h2>Forward outcome research</h2><p class="muted">Fixed 1/7/30 calendar-day OPEN-to-OPEN measurements. These are reference prices, not fills.</p><dl class="meta" id="outcome-summary"></dl></section><section class="panel"><h2>Evidence boundary</h2><div class="evidence" id="evidence-legend"></div><div id="limitations"></div></section><section class="panel"><h2>Decision inspection</h2><div class="filters"><label><span class="eyebrow">Asset</span><input id="asset" type="search" placeholder="Filter asset"></label><label><span class="eyebrow">Slot</span><select id="slot"><option value="">All slots</option></select></label><label><span class="eyebrow">Eligibility</span><select id="eligibility"><option value="">All</option><option value="ELIGIBLE">Eligible</option><option value="NOT_ELIGIBLE">Not eligible</option></select></label><label><span class="eyebrow">Selection</span><select id="selection"><option value="">All</option><option>SELECTED</option><option>QUALIFIED_NOT_SELECTED</option><option>NOT_ELIGIBLE</option></select></label></div><div class="table-wrap"><table><thead><tr><th>Observation</th><th>Asset &amp; source</th><th>Score</th><th>Eligibility</th><th>Selection</th><th>1 / 7 / 30 day outcomes</th><th>Explanation</th></tr></thead><tbody id="rows"></tbody></table><div class="empty" id="empty" hidden>No decisions match these filters.</div></div></section><section class="panel"><h2>Failed attempts</h2><div id="failures"></div></section><footer>Standalone local export · No network, analytics, external scripts, fonts, or API calls · Generated <span id="generated"></span></footer></main>
<script id="report-data" type="application/json">${data}</script><script>
(()=>{'use strict';const d=JSON.parse(document.getElementById('report-data').textContent);const $=id=>document.getElementById(id);const txt=(tag,value,cls)=>{const e=document.createElement(tag);e.textContent=value??'—';if(cls)e.className=cls;return e};const fmt=v=>v?new Date(v).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):'Not recorded';const pct=v=>v===null?'—':(v>=0?'+':'')+v.toFixed(2)+'%';const badge=(value,cls='')=>txt('span',String(value).replaceAll('_',' '),'badge '+cls);$('privacy').textContent=d.privacyNotice;$('subtitle').textContent=d.campaign.id+' · '+d.campaign.evidenceType.replaceAll('-',' ');$('generated').textContent=fmt(d.generatedAt);const metrics=[['Expected',d.campaign.counts.expected],['Completed',d.campaign.counts.completed],['Failed',d.campaign.counts.failed],['Missed',d.campaign.counts.missed],['Pending',d.campaign.counts.pending],['Retries',d.campaign.counts.retryAttempts]];for(const [k,v] of metrics){const x=txt('div','', 'metric');x.append(txt('span',k,'muted'),txt('strong',v));$('metrics').append(x)}const meta=[['Evidence type',d.campaign.evidenceType],['Model / strategy',d.campaign.modelVersion+' / '+d.campaign.strategyVersion],['Configuration',d.campaign.configurationId],['Candle policy',d.campaign.candleValidationPolicyVersion],['Repository',d.campaign.repositoryCommit],['Universe',d.campaign.universe.join(', ')||'Unavailable'],['Risk profile',d.campaign.riskProfile],['Source / timeframe',d.campaign.source+' / '+d.campaign.timeframe],['Schedule',JSON.stringify(d.campaign.schedule)],['Latest observation',fmt(d.campaign.latestObservationTime)],['Report generated',fmt(d.generatedAt)]];for(const [k,v] of meta){const wrap=document.createElement('div');wrap.append(txt('dt',k),txt('dd',v));$('meta').append(wrap)}const summary=[['Specification',d.outcomes.specificationId],['Frozen',fmt(d.outcomes.frozenAt)],['Unique assets',d.outcomes.summary.uniqueAssets],['Observation dates',d.outcomes.summary.observationDates],['Date range',d.outcomes.summary.dateRange?d.outcomes.summary.dateRange.start+' — '+d.outcomes.summary.dateRange.end:'No outcomes collected'],...d.outcomes.summary.byHorizon.map(h=>[h.horizonDays+'d summary','n='+h.sampleSize+' · mean '+pct(h.mean)+' · median '+pct(h.median)+' · positive '+(h.positiveFraction===null?'—':(h.positiveFraction*100).toFixed(1)+'%')])];for(const [k,v] of summary){const wrap=document.createElement('div');wrap.append(txt('dt',k),txt('dd',v));$('outcome-summary').append(wrap)}if(d.errors.length){$('errors-panel').hidden=false;for(const e of d.errors)$('errors').append(txt('p',e,'error panel'))}const legend=[['Recorded observation','info'],['Offline reproduction MATCH','good'],['Synthetic demonstration','warn'],['Missing / failed data','bad'],['Missing reproduction','warn']];for(const [v,c] of legend)$('evidence-legend').append(badge(v,c));const ul=document.createElement('ul');for(const l of d.limitations)ul.append(txt('li',l));$('limitations').append(ul);const decisions=d.observations.flatMap(o=>o.decisions.map(x=>({...x,evidence:o.evidence,reproduction:o.reproduction})));for(const s of [...new Set(decisions.map(x=>x.slot))])$('slot').append(txt('option',fmt(s))).lastChild.value=s;function render(){const body=$('rows');body.replaceChildren();const asset=$('asset').value.trim().toLowerCase(),slot=$('slot').value,elig=$('eligibility').value,sel=$('selection').value;const filtered=decisions.filter(x=>(!asset||x.asset.toLowerCase().includes(asset))&&(!slot||x.slot===slot)&&(!elig||(elig==='ELIGIBLE'?x.status==='ELIGIBLE':x.status!=='ELIGIBLE'))&&(!sel||x.selectionStatus===sel));for(const x of filtered){const tr=document.createElement('tr');const obs=document.createElement('td');obs.append(txt('div',fmt(x.slot)),txt('div','Observed '+fmt(x.observedAt),'muted'),txt('div','Scheduled '+fmt(x.slot),'muted'),txt('div','Candle as-of '+fmt(x.dataAsOf),'muted'));const ev=document.createElement('div');ev.className='evidence';ev.append(badge(x.evidence,x.evidence==='SYNTHETIC_DEMONSTRATION'?'warn':'info'),badge('Reproduction '+x.reproduction.status,x.reproduction.status==='MATCH'?'good':x.reproduction.status==='MISMATCH'?'bad':'warn'));obs.append(ev);const assetCell=document.createElement('td');assetCell.append(txt('strong',x.asset),txt('div',x.source+' · '+x.timeframe,'muted'),txt('div',x.configurationId,'muted'));const score=document.createElement('td');score.append(txt('div',x.score===null?'—':x.score,'score'));if(x.scoreComponents){const c=document.createElement('div');c.className='components';for(const [k,v] of Object.entries(x.scoreComponents))c.append(txt('span',k.replace('Score','')+': '+v));score.append(c)}const eligible=document.createElement('td');eligible.append(badge(x.status,x.status==='ELIGIBLE'?'good':'bad'));if(x.rejectionReasons.length){const det=document.createElement('details');det.append(txt('summary',x.rejectionReasons.length+' structured reason(s)'));for(const r of x.rejectionReasons)det.append(txt('div',r.code+': '+r.detail,'muted'));eligible.append(det)}const selection=document.createElement('td');selection.append(badge(x.selectionStatus,x.selectionStatus==='SELECTED'?'good':x.selectionStatus==='QUALIFIED_NOT_SELECTED'?'warn':'bad'));const outcomes=document.createElement('td');if(!x.outcome){outcomes.append(badge(x.score===null?'EXCLUDED_DATA_FAILURE':'NOT_COLLECTED','warn'))}else{outcomes.append(badge(x.outcome.analysisRegistration,x.outcome.analysisRegistration==='PREREGISTERED'?'good':'warn'));for(const h of x.outcome.horizons){const line=document.createElement('div');line.append(badge(h.horizonDays+'d '+h.status,h.status==='AVAILABLE'?'good':h.status==='PENDING'?'info':h.status==='MISSING'?'warn':'bad'),txt('span',h.status==='AVAILABLE'?' asset '+pct(h.assetChangePct)+' · BTC '+pct(h.benchmarkChangePct)+' · Δ '+pct(h.differencePercentagePoints):'', 'muted'));outcomes.append(line)}}tr.append(obs,assetCell,score,eligible,selection,outcomes,txt('td',x.explanation));body.append(tr)}$('empty').hidden=filtered.length!==0}for(const id of ['asset','slot','eligibility','selection'])$(id).addEventListener(id==='asset'?'input':'change',render);render();if(!d.failedAttempts.length)$('failures').append(txt('p','No failed attempts recorded.','muted'));else for(const a of d.failedAttempts){const box=document.createElement('details');box.append(txt('summary',fmt(a.slot)+' · attempt '+a.attemptNumber+' · FAILED'));for(const f of a.failures)box.append(txt('p',f.asset+' · '+f.code+': '+f.detail,'muted'));$('failures').append(box)}})();
</script></body></html>`;
}

export async function writeDecisionsReport(
  model: DecisionsReportModel,
  outputPath: string,
): Promise<string> {
  const target = resolve(outputPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, renderDecisionsReport(model), { encoding: 'utf8', flag: 'w' });
  return target;
}
