// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { measureOpportunityOutcome, type OpportunityOutcome } from './opportunityOutcomes';
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
