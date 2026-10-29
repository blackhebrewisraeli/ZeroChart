// @vitest-environment node

import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Candle } from '@/lib/binance';
import { initializeOpportunityCampaign, opportunitySlotDirectory } from './opportunityCampaign';
import {
  collectOpportunityOutcomes,
  measureOpportunityOutcome,
  type FetchOutcomeCandles,
  type OpportunityOutcome,
  type OpportunityOutcomeRecord,
} from './opportunityOutcomes';
import type { ResearchCandle } from './outcomeMeasurement';

const DAY = 86_400_000;
const OBSERVED = Date.UTC(2026, 9, 30, 0, 30);
/** The first UTC daily open strictly after OBSERVED. */
const REF = Date.UTC(2026, 9, 31);
const at = (day: number) => new Date(REF + day * DAY).toISOString();

const OPPORTUNITY = {
  id: `${new Date(OBSERVED).toISOString()}|ETH-USD`,
  ticker: 'ETH-USD',
  instrument: 'ETHUSDT',
  evaluationTime: OBSERVED,
  entryZone: { low: 98, high: 101 },
  invalidation: 92,
  validDailyOpens: 3,
  primaryHorizonDays: 20,
  secondaryHorizonDays: [5, 10, 30],
};

/** Day i opens at opens[i] and closes at the next open; wicks reach 1 beyond both. */
function daily(opens: readonly number[]): ResearchCandle[] {
  return opens.map((open, day) => {
    const close = opens[day + 1] ?? open;
    return {
      openTime: REF + day * DAY,
      closeTime: REF + day * DAY + DAY - 1,
      open,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      close,
    };
  });
}

/** 100 every day except the four endpoints: day 5 → 104, 10 → 95, 20 → 110, 30 → 99. */
function baseOpens(): number[] {
  const opens = Array.from({ length: 31 }, () => 100);
  Object.assign(opens, { 5: 104, 10: 95, 20: 110, 30: 99 });
  return opens;
}

function measure(candles: readonly ResearchCandle[], now = REF + 30 * DAY): OpportunityOutcome {
  return measureOpportunityOutcome({ opportunity: OPPORTUNITY, candles, now, roundTripBps: 30 });
}

function horizon(outcome: OpportunityOutcome, days: number) {
  return outcome.horizons.find((item) => item.horizonDays === days)!;
}

describe('Opportunity outcome measurement', () => {
  it.each([
    // days, endpoint, gross %, net %, MFE %, MAE %
    [5, 104, 4, 3.7, 5, -1],
    [10, 95, -5, -5.3, 5, -6],
    [20, 110, 10, 9.7, 11, -6],
    [30, 99, -1, -1.3, 11, -6],
  ] as const)(
    'measures the %i-day horizon OPEN to OPEN, net of 30 bps, with excursions',
    (days, endpoint, gross, net, favorable, adverse) => {
      // A candle opening before observedAt (same UTC day) is never the reference.
      const sameDay = { ...daily([50])[0]!, openTime: REF - DAY, closeTime: REF - 1 };
      const outcome = measure([sameDay, ...daily(baseOpens())]);
      const result = horizon(outcome, days);

      expect(outcome.referenceOpenTime).toBe(at(0));
      expect(result).toMatchObject({
        status: 'AVAILABLE',
        primary: days === 20,
        endpointOpenTime: at(days),
        referencePrice: 100,
        endpointPrice: endpoint,
        detail: null,
        invalidationTouchedAt: null,
      });
      expect(result.grossChangePct).toBeCloseTo(gross, 10);
      expect(result.netChangePct).toBeCloseTo(net, 10);
      expect(result.maxFavorableExcursionPct).toBeCloseTo(favorable, 10);
      expect(result.maxAdverseExcursionPct).toBeCloseTo(adverse, 10);
    },
  );

  it('keeps the primary intent-to-treat result when all three opens miss the entry zone', () => {
    const opens = baseOpens();
    Object.assign(opens, { 0: 103, 1: 97.9, 2: 101.01 });
    const outcome = measure(daily(opens));

    expect(outcome.entryZone).toEqual({ status: 'NOT_ENTERED', enteredAt: null, detail: null });
    const primary = horizon(outcome, 20);
    expect(primary).toMatchObject({ status: 'AVAILABLE', primary: true, referencePrice: 103 });
    expect(primary.grossChangePct).toBeCloseTo((110 / 103 - 1) * 100, 10);
  });

  it.each([
    ['the upper edge on the first open', { 0: 101 }, 0],
    ['the lower edge on the third open', { 0: 102, 1: 97, 2: 98 }, 2],
  ] as const)('counts an open at %s as entering the zone', (_label, changes, day) => {
    const opens = Object.assign(baseOpens(), changes);
    expect(measure(daily(opens)).entryZone).toEqual({
      status: 'ENTERED',
      enteredAt: at(day),
      detail: null,
    });
  });

  it.each([
    ['before the 5-day endpoint', REF + 5 * DAY - 1, []],
    ['exactly at the 5-day endpoint open', REF + 5 * DAY, [5]],
    ['at the 20-day endpoint open', REF + 20 * DAY, [5, 10, 20]],
    ['at the 30-day endpoint open', REF + 30 * DAY, [5, 10, 20, 30]],
  ] as const)('matures only horizons whose endpoint opened (%s)', (_label, now, available) => {
    const outcome = measure(daily(baseOpens()), now);
    expect(
      outcome.horizons.map((item) => [
        item.horizonDays,
        item.status,
        item.status === 'PENDING' ? item.grossChangePct : 'measured',
      ]),
    ).toEqual(
      [5, 10, 20, 30].map((days) =>
        (available as readonly number[]).includes(days)
          ? [days, 'AVAILABLE', 'measured']
          : [days, 'PENDING', null],
      ),
    );
  });

  it('reports the entry zone as pending until the third open unless an earlier open entered', () => {
    const outside = Object.assign(baseOpens(), { 0: 103, 1: 103 });
    expect(measure(daily(outside), REF + DAY).entryZone.status).toBe('PENDING');
    expect(measure(daily(baseOpens()), REF).entryZone).toMatchObject({
      status: 'ENTERED',
      enteredAt: at(0),
    });
  });

  it('never substitutes a nearby candle for a missing exact timestamp', () => {
    const candles = daily(baseOpens()).filter((candle) => candle.openTime !== REF + 5 * DAY);
    const outcome = measure(candles);

    for (const days of [5, 10, 20, 30]) {
      expect(horizon(outcome, days)).toMatchObject({
        status: 'MISSING',
        detail: `${at(5)}: no candle; none substituted`,
        endpointPrice: null,
        grossChangePct: null,
        netChangePct: null,
      });
    }
  });

  it('reports a missing reference candle for every horizon and the entry zone', () => {
    const outcome = measure(daily(baseOpens()).slice(1));
    expect(outcome.entryZone).toMatchObject({ status: 'MISSING', detail: `${at(0)}: no candle` });
    expect(outcome.horizons.map((item) => item.status)).toEqual([
      'MISSING',
      'MISSING',
      'MISSING',
      'MISSING',
    ]);
  });

  it('marks duplicate and malformed candles INVALID from the first bad timestamp on', () => {
    const duplicate = daily(baseOpens());
    duplicate.push({ ...duplicate[10]!, open: 96 });
    expect(measure(duplicate).horizons.map((item) => item.status)).toEqual([
      'AVAILABLE',
      'INVALID',
      'INVALID',
      'INVALID',
    ]);
    expect(horizon(measure(duplicate), 10).detail).toBe(`${at(10)}: DUPLICATE_TIMESTAMP`);

    const malformed = daily(baseOpens());
    malformed[2] = { ...malformed[2]!, high: 90, low: 110 };
    const outcome = measure(malformed);
    expect(outcome.horizons.every((item) => item.status === 'INVALID')).toBe(true);
    expect(horizon(outcome, 5).detail).toContain('HIGH_BELOW_LOW');
    // The first open already entered the zone, so the bad third candle is never consulted.
    expect(outcome.entryZone.status).toBe('ENTERED');
  });

  it('includes gapping endpoint opens in the excursions', () => {
    const gapUp = daily(baseOpens());
    // Day 4 closes flat at 100 (range 99–101); day 5 then opens at 104.
    gapUp[4] = { ...gapUp[4]!, close: 100, high: 101, low: 99 };
    expect(horizon(measure(gapUp), 5).maxFavorableExcursionPct).toBeCloseTo(4, 10);

    const gapDown = daily(Object.assign(baseOpens(), { 5: 90 }));
    gapDown[4] = { ...gapDown[4]!, close: 100, high: 101, low: 99 };
    const result = horizon(measure(gapDown), 5);
    expect(result.maxAdverseExcursionPct).toBeCloseTo(-10, 10);
    expect(result.netChangePct).toBeCloseTo(-10.3, 10);
  });

  it('reports the first candle touching invalidation inside each horizon only', () => {
    const candles = daily(baseOpens());
    candles[7] = { ...candles[7]!, low: 92 };
    candles[12] = { ...candles[12]!, low: 91 };
    const outcome = measure(candles);

    expect(outcome.horizons.map((item) => [item.horizonDays, item.invalidationTouchedAt])).toEqual([
      [5, null],
      [10, at(7)],
      [20, at(7)],
      [30, at(7)],
    ]);
  });
});

describe('Opportunity outcome collection', () => {
  const SPECIFICATION_ID = '0eddcc4f81ba47d74168392bb50af64050d3a9db2ab56da914c3814087d64483';
  const TICKERS = [
    'ADA',
    'AVAX',
    'BCH',
    'BNB',
    'BTC',
    'DOGE',
    'DOT',
    'ETH',
    'LINK',
    'LTC',
    'SOL',
    'XRP',
  ];
  const ELIGIBLE = TICKERS.filter((base) => base !== 'DOT' && base !== 'AVAX').map(
    (base) => `${base}-USD`,
  );
  /** The frozen 00:30 primary slot offset: outcomes are collected from it on. */
  const SLOT = 30 * 60_000;
  /** Linear daily drift per instrument: open(day) = 100 × (1 + rate × day). */
  const RATES: Record<string, number> = { ETHUSDT: 0.01, BTCUSDT: 0.005 };

  /** Synthetic Binance honoring [startTime, endTime] and limit; `omit` drops exact days. */
  function provider(
    options: {
      omit?: Record<string, number[]>;
      revise?: (instrument: string, candle: Candle, day: number) => Candle;
      fail?: string;
    } = {},
  ) {
    const calls: Array<{ instrument: string; startTime: number; endTime: number; limit: number }> =
      [];
    const fetchCandles: FetchOutcomeCandles = async (instrument, range) => {
      calls.push({ instrument, ...range });
      if (instrument === options.fail) throw new Error('Binance klines request failed');
      const open = (day: number) => 100 * (1 + (RATES[instrument] ?? 0) * day);
      const candles: Candle[] = [];
      for (let time = range.startTime; time <= range.endTime; time += DAY) {
        const day = (time - REF) / DAY;
        if (options.omit?.[instrument]?.includes(day)) continue;
        const [o, c] = [open(day), open(day + 1)];
        const candle = {
          timestamp: time,
          closeTime: time + DAY - 1,
          open: o,
          high: Math.max(o, c) + 1,
          low: Math.min(o, c) - 1,
          close: c,
        };
        candles.push(options.revise?.(instrument, candle, day) ?? candle);
      }
      return candles.slice(0, range.limit);
    };
    return { calls, fetchCandles };
  }

  /** A campaign whose first slot (observedAt = OBSERVED) emitted one ETH Opportunity. */
  async function campaignWithOpportunity() {
    const store = await mkdtemp(join(tmpdir(), 'zerochart-outcomes-'));
    const campaignId = 'outcomes';
    await initializeOpportunityCampaign({
      campaignId,
      store,
      startSlot: OBSERVED,
      endSlot: OBSERVED + 179 * DAY,
      implementationCommit: 'a'.repeat(40),
      now: OBSERVED - 12 * 60 * 60_000,
    });
    const directory = join(store, 'campaigns', campaignId);
    const slotDirectory = opportunitySlotDirectory(directory, new Date(OBSERVED).toISOString());
    const assets = TICKERS.map((base) => ({
      ticker: `${base}-USD`,
      reasons:
        base === 'ETH'
          ? []
          : base === 'DOT'
            ? ['SCANNER_NOT_EVALUATED']
            : base === 'AVAX'
              ? ['INSUFFICIENT_HISTORY']
              : ['SCORE_BELOW_MINIMUM'],
    }));
    await mkdir(slotDirectory, { recursive: true });
    const slotBytes = JSON.stringify({ result: { assets, opportunities: [OPPORTUNITY] } });
    await writeFile(join(slotDirectory, 'slot.json'), slotBytes);
    const recordPath = (days: number) =>
      join(
        directory,
        'outcomes',
        SPECIFICATION_ID,
        new Date(OBSERVED).toISOString().replaceAll(':', '-'),
        `ETH-USD-${days}d.json`,
      );
    const record = async (days: number) =>
      JSON.parse(await readFile(recordPath(days), 'utf8')) as OpportunityOutcomeRecord;
    return { store, campaignId, directory, slotBytes, recordPath, record };
  }

  const collect = (
    campaign: { store: string; campaignId: string },
    now: number,
    fetchCandles: FetchOutcomeCandles,
  ) =>
    collectOpportunityOutcomes({
      campaignId: campaign.campaignId,
      store: campaign.store,
      fetchCandles,
      now: () => now,
    });

  const counts = (changes: Partial<Record<string, number>> = {}) => ({
    created: 0,
    unchanged: 0,
    recorded: 0,
    conflicts: 0,
    pending: 0,
    fetchFailed: 0,
    ...changes,
  });

  it.each([
    ['before the 5-day endpoint opens', REF + 5 * DAY - 1],
    ['at the 5-day endpoint open, before its 00:30 slot', REF + 5 * DAY],
    ['one millisecond before that slot', REF + 5 * DAY + SLOT - 1],
  ])('skips an immature Opportunity %s, fetching and writing nothing', async (_label, now) => {
    const campaign = await campaignWithOpportunity();
    const { calls, fetchCandles } = provider();

    await expect(collect(campaign, now, fetchCandles)).resolves.toEqual(counts({ pending: 4 }));
    expect(calls).toEqual([]);
    await expect(access(join(campaign.directory, 'outcomes'))).rejects.toThrow();
  });

  it("collects a horizon from its endpoint day's 00:30 slot", async () => {
    const campaign = await campaignWithOpportunity();
    await expect(collect(campaign, REF + 5 * DAY + SLOT, provider().fetchCandles)).resolves.toEqual(
      counts({ created: 1, pending: 3 }),
    );
  });

  it('measures BTC and the frozen eligible universe over identical timestamps', async () => {
    const campaign = await campaignWithOpportunity();
    const { calls, fetchCandles } = provider();

    await expect(collect(campaign, REF + 10 * DAY + SLOT, fetchCandles)).resolves.toEqual(
      counts({ created: 2, pending: 2 }),
    );
    // Exactly the eligible members (BTC among them), each over the exact matured range.
    expect(calls).toEqual(
      ['ADA', 'BCH', 'BNB', 'BTC', 'DOGE', 'ETH', 'LINK', 'LTC', 'SOL', 'XRP'].map((base) => ({
        instrument: `${base}USDT`,
        startTime: REF,
        endTime: REF + 10 * DAY,
        limit: 11,
      })),
    );

    const record = await campaign.record(10);
    expect(record).toMatchObject({
      opportunityId: OPPORTUNITY.id,
      horizonDays: 10,
      primary: false,
      referenceOpenTime: at(0),
      roundTripBps: 30,
      slotSha256: createHash('sha256').update(campaign.slotBytes).digest('hex'),
      outcome: { status: 'AVAILABLE', endpointOpenTime: at(10) },
      btc: { status: 'AVAILABLE', endpointOpenTime: at(10), referencePrice: 100 },
      equalWeight: { members: ELIGIBLE, available: 10 },
    });
    expect(record.outcome.netChangePct).toBeCloseTo(9.7, 10);
    expect(record.btc.grossChangePct).toBeCloseTo(5, 10);
    expect(record.equalWeight.meanGrossChangePct).toBeCloseTo(1.5, 10);
    expect(record.equalWeight.meanNetChangePct).toBeCloseTo(1.2, 10);
    expect(record.candles['ETH-USD']!.map((candle) => candle.openTime)).toEqual(
      Array.from({ length: 11 }, (_, day) => REF + day * DAY),
    );
    expect((await campaign.record(5)).equalWeight.meanGrossChangePct).toBeCloseTo(0.75, 10);
  });

  it('does not refetch until a horizon matures, then re-verifies earlier records unchanged', async () => {
    const campaign = await campaignWithOpportunity();
    await collect(campaign, REF + 10 * DAY + SLOT, provider().fetchCandles);
    const before = await Promise.all([5, 10].map((days) => readFile(campaign.recordPath(days))));

    const idle = provider();
    await expect(collect(campaign, REF + 12 * DAY + SLOT, idle.fetchCandles)).resolves.toEqual(
      counts({ recorded: 2, pending: 2 }),
    );
    expect(idle.calls).toEqual([]);

    const later = provider();
    await expect(collect(campaign, REF + 20 * DAY + SLOT, later.fetchCandles)).resolves.toEqual(
      counts({ created: 1, unchanged: 2, pending: 1 }),
    );
    expect(later.calls[0]).toMatchObject({ endTime: REF + 20 * DAY, limit: 21 });
    expect(await Promise.all([5, 10].map((days) => readFile(campaign.recordPath(days))))).toEqual(
      before,
    );
  });

  it('reports revised provider bytes as CONFLICT and writes nothing new for that slot', async () => {
    const campaign = await campaignWithOpportunity();
    await collect(campaign, REF + 10 * DAY + SLOT, provider().fetchCandles);
    const before = await readFile(campaign.recordPath(10), 'utf8');
    const revised = provider({
      revise: (instrument, candle, day) =>
        instrument === 'ETHUSDT' && day === 3 ? { ...candle, high: candle.high + 5 } : candle,
    });

    await expect(collect(campaign, REF + 20 * DAY + SLOT, revised.fetchCandles)).resolves.toEqual(
      counts({ conflicts: 2, pending: 1 }),
    );
    expect(await readFile(campaign.recordPath(10), 'utf8')).toBe(before);
    await expect(access(campaign.recordPath(20))).rejects.toThrow();
  });

  it('records matured missing data explicitly and averages only available members', async () => {
    const campaign = await campaignWithOpportunity();
    const { fetchCandles } = provider({ omit: { ETHUSDT: [5], SOLUSDT: [10] } });

    await expect(collect(campaign, REF + 10 * DAY + SLOT, fetchCandles)).resolves.toEqual(
      counts({ created: 2, pending: 2 }),
    );
    const five = await campaign.record(5);
    expect(five.outcome).toMatchObject({
      status: 'MISSING',
      detail: `${at(5)}: no candle; none substituted`,
      netChangePct: null,
    });
    expect(five.equalWeight.available).toBe(9);
    expect(five.equalWeight.outcomes['ETH-USD']).toEqual({
      status: 'MISSING',
      grossChangePct: null,
      netChangePct: null,
    });
    const ten = await campaign.record(10);
    expect(ten.btc.status).toBe('AVAILABLE');
    expect(ten.equalWeight.available).toBe(8);
    expect(ten.equalWeight.meanGrossChangePct).toBeCloseTo(5 / 8, 10);
  });

  it('records nothing when a fetch fails, so the next run can still collect', async () => {
    const campaign = await campaignWithOpportunity();

    await expect(
      collect(campaign, REF + 10 * DAY + SLOT, provider({ fail: 'LINKUSDT' }).fetchCandles),
    ).resolves.toEqual(counts({ fetchFailed: 2, pending: 2 }));
    await expect(access(join(campaign.directory, 'outcomes'))).rejects.toThrow();

    await expect(
      collect(campaign, REF + 10 * DAY + SLOT, provider().fetchCandles),
    ).resolves.toEqual(counts({ created: 2, pending: 2 }));
  });
});
