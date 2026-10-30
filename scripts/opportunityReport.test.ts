// @vitest-environment node

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initializeOpportunityCampaign, opportunitySlotDirectory } from './opportunityCampaign';
import {
  buildOpportunityReport,
  OpportunityReportRefusal,
  opportunityReportSummary,
  renderOpportunityReport,
} from './opportunityReport';

const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 30, 0, 30);
const SPECIFICATION_ID = '0eddcc4f81ba47d74168392bb50af64050d3a9db2ab56da914c3814087d64483';
/** After slot 180's 06:00 deadline: 180 calendar slots have elapsed, none pending. */
const AFTER_180_SLOTS = START + 179 * DAY + 6 * 60 * 60_000;
const ASSETS = ['ADA', 'BCH', 'BNB', 'BTC', 'DOGE', 'ETH', 'LINK', 'SOL'].map(
  (base) => `${base}-USD`,
);

interface Seed {
  completed: number;
  reproduced: number;
  outcomes: number;
  net?: number;
  btc?: number;
  conflicts?: number;
}

/** Writes evidence directly: slot files, MATCH receipts and 20-day records every 4 days. */
async function seed(options: Seed) {
  const store = await mkdtemp(join(tmpdir(), 'zerochart-report-'));
  const campaignId = 'report';
  await initializeOpportunityCampaign({
    campaignId,
    store,
    startSlot: START,
    endSlot: START + 199 * DAY,
    implementationCommit: 'a'.repeat(40),
    now: START - DAY,
  });
  const directory = join(store, 'campaigns', campaignId);
  for (let index = 0; index < options.completed; index += 1) {
    const slot = new Date(START + index * DAY).toISOString();
    const slotDirectory = opportunitySlotDirectory(directory, slot);
    const bytes = JSON.stringify({ slot });
    await mkdir(join(slotDirectory, 'reproductions'), { recursive: true });
    await writeFile(join(slotDirectory, 'slot.json'), bytes);
    if (index < options.reproduced) {
      await writeFile(
        join(slotDirectory, 'reproductions', 'receipt.json'),
        JSON.stringify({
          slotSha256: createHash('sha256').update(bytes).digest('hex'),
          reproducedAt: slot,
          status: 'MATCH',
        }),
      );
    }
  }
  for (let index = 0; index < options.outcomes; index += 1) {
    const slot = new Date(START + index * 4 * DAY).toISOString();
    const ticker = ASSETS[index % ASSETS.length]!;
    const outcomeDirectory = join(
      directory,
      'outcomes',
      SPECIFICATION_ID,
      slot.replaceAll(':', '-'),
    );
    await mkdir(join(outcomeDirectory, 'conflicts'), { recursive: true });
    await writeFile(
      join(outcomeDirectory, `${ticker}-20d.json`),
      JSON.stringify({
        slot,
        opportunityId: `${slot}|${ticker}`,
        ticker,
        horizonDays: 20,
        referenceOpenTime: new Date(START + (index * 4 + 1) * DAY - 30 * 60_000).toISOString(),
        entryZone: { status: 'ENTERED' },
        outcome: {
          status: 'AVAILABLE',
          netChangePct: options.net ?? 7.77,
          maxFavorableExcursionPct: 12.34,
          maxAdverseExcursionPct: -5.43,
          invalidationTouchedAt: null,
        },
        btc: { status: 'AVAILABLE', grossChangePct: options.btc ?? 3.33 },
        equalWeight: { meanGrossChangePct: 2.22 },
      }),
    );
    if (index === 0 && options.conflicts) {
      await writeFile(
        join(outcomeDirectory, 'conflicts', 'detection.json'),
        JSON.stringify({ records: options.conflicts }),
      );
    }
  }
  const build = (final: boolean, now = AFTER_180_SLOTS) =>
    buildOpportunityReport({ campaignId, store, final, now: () => now });
  return { build };
}

/** Values and labels that may appear only in a final report. */
const PERFORMANCE_MARKERS = [
  '7.77',
  '3.33',
  '2.22',
  '12.34',
  '5.43',
  '-USD',
  'PASS_FOR_OWNER_REVIEW',
  'PASS FOR OWNER REVIEW',
  'primary-results',
  'Mean net',
  'Excess',
  'favorable',
  'adverse',
  'Invalidation touched',
];

function expectNoPerformance(text: string) {
  for (const marker of PERFORMANCE_MARKERS) expect(text).not.toContain(marker);
}

describe('Opportunity Radar operational report', () => {
  it('shows operational health and gate progress only before the decision gate', async () => {
    const { build } = await seed({ completed: 100, reproduced: 100, outcomes: 12 });
    const report = await build(false, START + 99 * DAY + 6 * 60 * 60_000);

    expect(report).toMatchObject({
      mode: 'OPERATIONAL',
      phase: 'OPERATIONAL_REVIEW',
      slots: { scheduled: 200, due: 100, completed: 100, pending: 0, missed: 0 },
      reproduction: { match: 100, mismatch: 0, notReproduced: 0 },
      outcomes: { records: 12, available: 12, missing: 0, invalid: 0, conflicts: 0 },
      gate: {
        eligible: false,
        insufficientReasons: [
          'CALENDAR_SLOTS_BELOW_MINIMUM',
          'MATURED_PRIMARY_OUTCOMES_BELOW_MINIMUM',
          'DISTINCT_MONTHS_BELOW_MINIMUM',
        ],
      },
    });
    expect(report).not.toHaveProperty('performance');
    expectNoPerformance(renderOpportunityReport(report));
    expectNoPerformance(JSON.stringify(opportunityReportSummary(report)));
    expect(renderOpportunityReport(report)).not.toMatch(/<script/i);
  });

  it('never reveals the signal result in the operational view once the gate is met', async () => {
    const { build } = await seed({ completed: 180, reproduced: 180, outcomes: 40 });
    const report = await build(false);

    expect(report).toMatchObject({
      mode: 'OPERATIONAL',
      phase: 'DECISION_GATE_ELIGIBLE',
      gate: { eligible: true, insufficientReasons: [] },
    });
    const html = renderOpportunityReport(report);
    expectNoPerformance(html);
    expectNoPerformance(JSON.stringify(report));
    expect(html).toContain('Generate the final report with --final');
  });

  it.each([
    [
      'only 179 elapsed calendar slots',
      { completed: 179, reproduced: 179, outcomes: 40 },
      AFTER_180_SLOTS - DAY,
      'CALENDAR_SLOTS_BELOW_MINIMUM',
    ],
    [
      'an unreproduced slot',
      { completed: 180, reproduced: 179, outcomes: 40 },
      AFTER_180_SLOTS,
      'COMPLETED_SLOTS_NOT_ALL_REPRODUCED',
    ],
    [
      'a recorded outcome conflict',
      { completed: 180, reproduced: 180, outcomes: 40, conflicts: 1 },
      AFTER_180_SLOTS,
      'EVIDENCE_CONFLICTS',
    ],
  ] as const)('refuses the final report with %s', async (_label, options, now, reason) => {
    const { build } = await seed(options);
    const refusal = await build(true, now).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(OpportunityReportRefusal);
    expect((refusal as OpportunityReportRefusal).reasons).toContain(reason);
    expectNoPerformance(JSON.stringify(refusal));
  });
});

describe('Opportunity Radar final report', () => {
  it.each([
    ['a passing campaign', {}, 'PASS_FOR_OWNER_REVIEW', '+7.77%', '+4.44 pp'],
    ['a failing campaign', { net: -1.5, btc: 3.33 }, 'FAIL', '-1.50%', '-4.83 pp'],
  ] as const)(
    'reports every frozen result and limitation for %s',
    async (_label, overrides, status, net, excess) => {
      const { build } = await seed({ completed: 180, reproduced: 180, outcomes: 40, ...overrides });
      const report = await build(true);
      const html = renderOpportunityReport(report);

      expect(report).toMatchObject({ mode: 'FINAL', decision: { status } });
      expect(opportunityReportSummary(report)).toMatchObject({ decision: status });
      for (const section of [
        'id="decision"',
        'id="primary-results"',
        'id="horizons"',
        'id="limitations"',
      ]) {
        expect(html).toContain(section);
      }
      expect(html).toContain(net);
      expect(html).toContain(excess);
      expect(html).toContain('20 days (primary)');
      expect(html).toContain('moving-block bootstrap');
      expect(html).toContain('Not fills, an executable strategy');
      expect(html).toContain('Counts are not independent trials.');
      expect(html).toContain('never activates trading automatically');
      expect(html).toContain('only the Opportunity bears the frozen 30 bps');
      expect(html).not.toMatch(/<script/i);
    },
  );
});
