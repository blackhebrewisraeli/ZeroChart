// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  analyzeOpportunityCampaign,
  movingBlockBootstrap,
  mulberry32,
  OPPORTUNITY_BOOTSTRAP,
  type OpportunityIntegrity,
} from './opportunityAnalysis';
import type { OpportunityOutcomeRecord } from './opportunityOutcomes';

const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 30, 0, 30);
const GATE = {
  minimumCalendarSlots: 180,
  minimumMaturedPrimaryOutcomes: 40,
  minimumDistinctAssets: 6,
  minimumDistinctOpportunityMonths: 4,
  maximumSingleAssetShare: 0.3,
  minimumCompletedSlotFraction: 0.95,
} as const;
const INTEGRITY: OpportunityIntegrity = {
  calendarSlots: 180,
  completedSlots: 180,
  reproducedSlots: 180,
  conflicts: 0,
};
const ASSETS = ['ADA', 'BCH', 'BNB', 'BTC', 'DOGE', 'ETH', 'LINK', 'SOL'].map(
  (base) => `${base}-USD`,
);

interface Spec {
  ticker: string;
  day: number;
  net: number;
  btc: number;
  equalWeight: number | null;
  horizon: number;
  status: 'AVAILABLE' | 'MISSING';
}

/** Only the fields the analysis reads; net/btc/equalWeight are in percent. */
function record(spec: Spec): OpportunityOutcomeRecord {
  const slot = new Date(START + spec.day * DAY).toISOString();
  const available = spec.status === 'AVAILABLE';
  return {
    slot,
    opportunityId: `${slot}|${spec.ticker}`,
    ticker: spec.ticker,
    horizonDays: spec.horizon,
    entryZone: { status: spec.day % 2 === 0 ? 'ENTERED' : 'NOT_ENTERED' },
    outcome: {
      status: spec.status,
      netChangePct: available ? spec.net : null,
      maxFavorableExcursionPct: available ? spec.net + 3 : null,
      maxAdverseExcursionPct: available ? -2 : null,
      invalidationTouchedAt: null,
    },
    btc: { status: 'AVAILABLE', grossChangePct: spec.btc },
    equalWeight: { meanGrossChangePct: spec.equalWeight },
  } as unknown as OpportunityOutcomeRecord;
}

/** 40 primary outcomes: 8 assets × 5, every 4 days across 7 months, +2% net vs +1% BTC, +0.5% EW. */
function base(changes: (index: number) => Partial<Spec> = () => ({}), count = 40) {
  return Array.from({ length: count }, (_, index) =>
    record({
      ticker: ASSETS[index % 8]!,
      day: index * 4,
      net: 2,
      btc: 1,
      equalWeight: 0.5,
      horizon: 20,
      status: 'AVAILABLE',
      ...changes(index),
    }),
  );
}

function analyze(records: OpportunityOutcomeRecord[], integrity = INTEGRITY) {
  return analyzeOpportunityCampaign({ records, integrity, gate: GATE, primaryHorizonDays: 20 });
}

describe('Opportunity Radar decision gate', () => {
  it('passes the base sample for owner review with every primary measure', () => {
    const result = analyze(base());

    expect(result).toMatchObject({
      status: 'PASS_FOR_OWNER_REVIEW',
      reasons: [],
      gate: {
        calendarSlots: 180,
        maturedPrimaryOutcomes: 40,
        distinctAssets: 8,
        distinctOpportunityMonths: 7,
        maximumSingleAssetShare: 0.125,
        completedSlotFraction: 1,
        allCompletedSlotsReproduced: true,
        conflicts: 0,
      },
      performance: {
        primary: {
          horizonDays: 20,
          available: 40,
          meanNetChangePct: 2,
          medianNetChangePct: 2,
          meanExcessVsBtcPp: 1,
          meanExcessVsEqualWeightPp: 1.5,
          fractionPositive: 1,
          bootstrapExcessVsBtc: { lower: 1, upper: 1, observations: 40, calendarDays: 157 },
        },
        entryZoneEnteredFraction: 1,
      },
    });
  });

  it.each([
    [
      'calendar slots',
      [() => analyze(base(), { ...INTEGRITY, calendarSlots: 179 }), INTEGRITY],
      'CALENDAR_SLOTS_BELOW_MINIMUM',
    ],
    [
      'matured primary outcomes',
      [() => analyze(base(undefined, 39))],
      'MATURED_PRIMARY_OUTCOMES_BELOW_MINIMUM',
    ],
    [
      'available (not merely matured) primary outcomes',
      [() => analyze(base((i) => (i === 0 ? { status: 'MISSING' } : {})))],
      'MATURED_PRIMARY_OUTCOMES_BELOW_MINIMUM',
    ],
    [
      'distinct assets (5 of 6)',
      [() => analyze(base((i) => ({ ticker: ASSETS[i % 5]! })))],
      'DISTINCT_ASSETS_BELOW_MINIMUM',
    ],
    [
      'distinct months (Oct–Dec only)',
      [() => analyze(base((i) => ({ day: Math.floor(i * 1.5) })))],
      'DISTINCT_MONTHS_BELOW_MINIMUM',
    ],
    [
      'single-asset share (13 of 40)',
      [
        () =>
          analyze(
            base((i) => ({
              ticker: i < 13 ? 'ETH-USD' : ASSETS.filter((a) => a !== 'ETH-USD')[i % 7]!,
            })),
          ),
      ],
      'SINGLE_ASSET_SHARE_ABOVE_MAXIMUM',
    ],
    [
      'completed slots (170 of 180)',
      [() => analyze(base(), { ...INTEGRITY, completedSlots: 170, reproducedSlots: 170 })],
      'COMPLETED_SLOTS_BELOW_MINIMUM',
    ],
    [
      'reproduced slots (179 of 180)',
      [() => analyze(base(), { ...INTEGRITY, reproducedSlots: 179 })],
      'COMPLETED_SLOTS_NOT_ALL_REPRODUCED',
    ],
    [
      'evidence conflicts (1)',
      [() => analyze(base(), { ...INTEGRITY, conflicts: 1 })],
      'EVIDENCE_CONFLICTS',
    ],
  ] as const)(
    'is INSUFFICIENT just below the %s minimum, with no performance',
    (_label, [run], reason) => {
      const result = run();
      expect(result).toMatchObject({
        status: 'INSUFFICIENT',
        reasons: [reason],
        performance: null,
      });
    },
  );

  it.each([
    ['exactly 180 calendar slots', () => analyze(base())],
    ['exactly 40 primary outcomes', () => analyze(base(undefined, 40))],
    ['exactly 6 assets', () => analyze(base((i) => ({ ticker: ASSETS[i % 6]! })))],
    ['exactly 4 months (Oct–Jan)', () => analyze(base((i) => ({ day: i * 2 })))],
    [
      'a single-asset share of exactly 30% (12 of 40)',
      () =>
        analyze(
          base((i) => ({
            ticker: i < 12 ? 'ETH-USD' : ASSETS.filter((a) => a !== 'ETH-USD')[i % 7]!,
          })),
        ),
    ],
    [
      'exactly 95% completed slots (171 of 180)',
      () => analyze(base(), { ...INTEGRITY, completedSlots: 171, reproducedSlots: 171 }),
    ],
  ])('accepts the sample gate at %s', (_label, run) => {
    expect(run()).toMatchObject({ status: 'PASS_FOR_OWNER_REVIEW', reasons: [] });
  });

  it.each([
    [
      'a mean net change of exactly zero',
      (i: number) => ({ net: i < 30 ? 1 : -3, btc: i < 30 ? 0 : -4, equalWeight: i < 30 ? 0 : -4 }),
      ['MEAN_NET_NOT_POSITIVE'],
    ],
    [
      'a median net change of exactly zero',
      (i: number) => ({ net: i < 21 ? 0 : 1, btc: i < 21 ? -1 : 0, equalWeight: i < 21 ? -1 : 0 }),
      ['MEDIAN_NET_NOT_POSITIVE'],
    ],
    [
      'a mean excess versus BTC of exactly zero',
      () => ({ btc: 2 }),
      ['MEAN_EXCESS_VS_BTC_NOT_POSITIVE', 'BOOTSTRAP_LOWER_BOUND_NOT_POSITIVE'],
    ],
    [
      'a mean excess versus the equal-weight universe of exactly zero',
      () => ({ equalWeight: 2 }),
      ['MEAN_EXCESS_VS_EQUAL_WEIGHT_NOT_POSITIVE'],
    ],
    [
      'a positive mean BTC excess carried by one outlier',
      (i: number) => ({ btc: i === 39 ? -98 : 3 }),
      ['BOOTSTRAP_LOWER_BOUND_NOT_POSITIVE'],
    ],
  ])('FAILS on %s and still reports every result', (_label, changes, reasons) => {
    const result = analyze(base(changes));
    expect(result).toMatchObject({ status: 'FAIL', reasons });
    expect(result.performance?.primary.available).toBe(40);
  });

  it('measures excess against the benchmark gross change, net of costs only for the Opportunity', () => {
    // Net already carries the 30 bps deduction; the benchmark change is gross.
    const result = analyze(base(() => ({ net: 1.7, btc: 2, equalWeight: 1.7 })));
    expect(result.performance?.primary.meanExcessVsBtcPp).toBeCloseTo(-0.3, 10);
    expect(result.reasons).toContain('MEAN_EXCESS_VS_BTC_NOT_POSITIVE');
  });

  it('never lets a secondary horizon change the primary decision', () => {
    const secondary = [5, 10, 30].flatMap((horizon) =>
      base(() => ({ horizon, net: -50, btc: 10, equalWeight: 10 })),
    );
    const withSecondary = analyze([...base(), ...secondary]);
    const primaryOnly = analyze(base());

    expect(withSecondary.status).toBe(primaryOnly.status);
    expect(withSecondary.reasons).toEqual(primaryOnly.reasons);
    expect(withSecondary.gate).toEqual(primaryOnly.gate);
    expect(withSecondary.performance?.primary).toEqual(primaryOnly.performance?.primary);
    expect(
      withSecondary.performance?.horizons.map((item) => [item.horizonDays, item.meanNetChangePct]),
    ).toEqual([
      [5, -50],
      [10, -50],
      [20, 2],
      [30, -50],
    ]);
  });
});

describe('moving-block bootstrap', () => {
  /** 40 varied excess values every 4 days; pinned so any change to the method is visible. */
  const VARIED = Array.from({ length: 40 }, (_, index) => ({
    date: new Date(START + index * 4 * DAY).toISOString().slice(0, 10),
    id: `opportunity-${index}`,
    value: ((index * 7) % 13) - 5,
  }));

  it('uses the frozen seed, block length and resample count', () => {
    expect(OPPORTUNITY_BOOTSTRAP).toEqual({
      confidence: 0.9,
      blockDays: 20,
      resamples: 10_000,
      seed: 20261029,
      prng: 'mulberry32',
    });
    const random = mulberry32(20261029);
    expect([random(), random(), random()]).toEqual([
      0.850172859383747, 0.4661599525716156, 0.16925749415531754,
    ]);
  });

  it('is deterministic and independent of input order', () => {
    const first = movingBlockBootstrap(VARIED);
    expect(first).toEqual({
      lower: 0.3333333333333333,
      upper: 1.8717948717948718,
      observations: 40,
      calendarDays: 157,
      emptyResamples: 0,
    });
    expect(movingBlockBootstrap([...VARIED].reverse())).toEqual(first);
    expect(movingBlockBootstrap(VARIED, { ...OPPORTUNITY_BOOTSTRAP, seed: 1 }).lower).toBe(
      0.3076923076923077,
    );
  });

  it('gives an identical analysis for shuffled outcome records', () => {
    const records = base((i) => ({ btc: i === 39 ? -98 : 3 }));
    const shuffled = [...records].sort((a, b) => b.ticker.localeCompare(a.ticker));
    expect(analyze(shuffled)).toEqual(analyze(records));
  });
});
