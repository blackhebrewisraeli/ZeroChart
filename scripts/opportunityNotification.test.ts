// @vitest-environment node

import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initializeOpportunityCampaign, opportunitySlotDirectory } from './opportunityCampaign';
import {
  deliverOpportunityNotifications,
  type NotificationResult,
} from './opportunityNotification';
import type { NotificationTransport, TransportResult } from './telegramTransport';

const DAY = 86_400_000;
const MINUTE = 60_000;
const START = Date.UTC(2026, 9, 30, 0, 30);
/** The third UTC daily open after the 00:30 observation: 30 minutes before START + 72 hours. */
const EXPIRES = Date.UTC(2026, 10, 2);
const SLOT = new Date(START).toISOString();
const SPECIFICATION_ID = '0eddcc4f81ba47d74168392bb50af64050d3a9db2ab56da914c3814087d64483';
const iso = (time: number) => new Date(time).toISOString();
const OPPORTUNITY = {
  id: `${SLOT}|ETH-USD`,
  specificationId: SPECIFICATION_ID,
  evaluationTime: START,
  ticker: 'ETH-USD',
  instrument: 'ETHUSDT',
  rank: 1,
  score: 85,
  regime: 'MEAN_REVERTING',
  momentumPercent: 0.002,
  anchorClose: 2500,
  atr: 40,
  entryZone: { low: 2480, high: 2510 },
  invalidation: 2420,
  validDailyOpens: 3,
  expiresAt: EXPIRES,
  primaryHorizonDays: 20,
  secondaryHorizonDays: [5, 10, 30],
};
const RATIONALE = 'Bullish momentum (+0.2%) + calm volatility (1.6%) + oversold RSI 25';
const DELIVERED: TransportResult = { status: 'DELIVERED', messageId: '42' };
const REJECTED: TransportResult = {
  status: 'REJECTED',
  httpStatus: 429,
  description: 'Too Many Requests: retry after 5',
};

/** The anchor: the last daily candle that closed before the observation slot. */
const ANCHOR_OPEN = Date.UTC(2026, 9, 29);

interface SlotOptions {
  /** ETH lows of the candles after the anchor, oldest first; 2450 when absent. */
  lows?: number[];
  gate?: { passed: boolean; reasons: string[] };
  ethStatus?: string;
  finishedAt?: number;
  schemaVersion?: string;
}

/**
 * A completed slot's evidence: ETH's closed candles from the anchor through the
 * day before the slot. The anchor's own low is below invalidation, so only a
 * later candle may count.
 */
function slotJson(slot: number, options: SlotOptions = {}, opportunities: object[] = []) {
  const candles = Array.from({ length: (slot - (slot % DAY) - ANCHOR_OPEN) / DAY }, (_, day) => ({
    timestamp: ANCHOR_OPEN + day * DAY,
    low: day === 0 ? 2400 : (options.lows?.[day - 1] ?? 2450),
  }));
  return JSON.stringify({
    schemaVersion: options.schemaVersion ?? '2',
    attempts: [{ status: 'COMPLETED', finishedAt: iso(options.finishedAt ?? slot + 5 * MINUTE) }],
    inputs: [{ ticker: 'ETH-USD', candles }],
    result: {
      scan: {
        modelVersion: '1.0.0',
        results: [
          { ticker: 'ETH-USD', dataAsOf: START - 30 * MINUTE - 1, model: { rationale: RATIONALE } },
        ],
      },
      marketGate: options.gate ?? { passed: true, reasons: [] },
      assets: [
        {
          ticker: 'BTC-USD',
          scannerStatus: 'EVALUATED',
          close: 70000,
          smaFast: 66000,
          smaSlow: 60000,
          regime: 'TRENDING',
        },
        { ticker: 'ETH-USD', scannerStatus: options.ethStatus ?? 'EVALUATED' },
      ],
      opportunities,
    },
  });
}

/** A campaign whose first slot persisted one ETH Opportunity. */
async function campaign(options: SlotOptions = {}) {
  const store = await mkdtemp(join(tmpdir(), 'zerochart-notify-'));
  const campaignId = 'notify';
  await initializeOpportunityCampaign({
    campaignId,
    store,
    startSlot: START,
    endSlot: START + 179 * DAY,
    implementationCommit: 'a'.repeat(40),
    now: START - DAY,
  });
  const directory = join(store, 'campaigns', campaignId);
  const slotDirectory = opportunitySlotDirectory(directory, SLOT);
  const slotBytes = slotJson(START, options, [OPPORTUNITY]);
  await mkdir(slotDirectory, { recursive: true });
  await writeFile(join(slotDirectory, 'slot.json'), slotBytes);
  const folder = join(directory, 'notifications', `${SLOT.replaceAll(':', '-')}_ETH-USD`);
  /** Records the later slot `days` after the observation; it carries no new Opportunity. */
  const later = async (days: number, slotOptions: SlotOptions = {}) => {
    const slotTime = START + days * DAY;
    const laterDirectory = opportunitySlotDirectory(directory, iso(slotTime));
    await mkdir(laterDirectory, { recursive: true });
    await writeFile(join(laterDirectory, 'slot.json'), slotJson(slotTime, slotOptions));
  };
  return { store, campaignId, directory, slotDirectory, slotBytes, folder, later };
}

/** Answers in order, then DELIVERED; `throws` makes the send itself reject. */
function fake(answers: Array<TransportResult | 'throws'> = []) {
  const sent: string[] = [];
  const transport: NotificationTransport = {
    channel: 'fake',
    async send(text) {
      sent.push(text);
      const answer = answers.shift() ?? DELIVERED;
      if (answer === 'throws') throw new Error('socket hang up');
      return answer;
    },
  };
  return { sent, transport };
}

const counts = (changes: Record<string, number>) => ({
  delivered: 0,
  rejected: 0,
  unknown: 0,
  alreadyDelivered: 0,
  unresolved: 0,
  expired: 0,
  invalidated: 0,
  marketGateFailed: 0,
  evidenceUnavailable: 0,
  incompatible: 0,
  exhausted: 0,
  ...changes,
});

describe('Opportunity notifications', () => {
  const deliver = (
    setup: { store: string; campaignId: string },
    transport: NotificationTransport,
    now = START + 60 * 60_000,
  ) =>
    deliverOpportunityNotifications({
      campaignId: setup.campaignId,
      store: setup.store,
      transport,
      now: () => now,
    });

  it('delivers a persisted Opportunity once, with every frozen alert field', async () => {
    const setup = await campaign();
    const { sent, transport } = fake();

    await expect(deliver(setup, transport)).resolves.toEqual(counts({ delivered: 1 }));
    await expect(deliver(setup, transport)).resolves.toEqual(counts({ alreadyDelivered: 1 }));
    expect(sent).toHaveLength(1);
    for (const field of [
      'ETH-USD (ETHUSDT) · score 85 · mean reverting regime',
      'Entry zone 2480 – 2510 (first 3 daily opens)',
      'Invalidation 2420',
      'Primary horizon 20 days · expires 2026-11-02 00:00 UTC',
      'Observed 2026-10-30 00:30 UTC · data as of 2026-10-29 23:59 UTC',
      `Why: ${RATIONALE}`,
      'Market gate (BTC-USD): close 70000 > SMA200 60000; SMA50 66000 > SMA200; trending regime · passed',
      `Model 1.0.0 · specification 0eddcc4f81ba · ${OPPORTUNITY.id}`,
      'not financial advice. No order is placed.',
    ]) {
      expect(sent[0]).toContain(field);
    }
  });

  it.each([
    ['a timeout', { status: 'UNKNOWN', reason: 'TIMEOUT' } as const],
    ['a server error', { status: 'UNKNOWN', reason: 'SERVER_ERROR' } as const],
    ['a send that throws', 'throws' as const],
  ])('never resends after %s', async (_label, answer) => {
    const setup = await campaign();
    const { sent, transport } = fake([answer]);

    await expect(deliver(setup, transport)).resolves.toEqual(counts({ unknown: 1 }));
    await expect(deliver(setup, transport)).resolves.toEqual(counts({ unresolved: 1 }));
    expect(sent).toHaveLength(1);
  });

  it('never resends when a run stopped between the attempt and its result', async () => {
    const setup = await campaign();
    await mkdir(setup.folder, { recursive: true });
    await writeFile(join(setup.folder, 'attempt-1.json'), '{}');
    const { sent, transport } = fake();

    await expect(deliver(setup, transport)).resolves.toEqual(counts({ unresolved: 1 }));
    expect(sent).toEqual([]);
  });

  it('retries a definite rejection and records exactly one delivery', async () => {
    const setup = await campaign();
    const { sent, transport } = fake([REJECTED]);

    await expect(deliver(setup, transport)).resolves.toEqual(counts({ rejected: 1 }));
    await expect(deliver(setup, transport)).resolves.toEqual(counts({ delivered: 1 }));
    await expect(deliver(setup, transport)).resolves.toEqual(counts({ alreadyDelivered: 1 }));
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    const results = await Promise.all(
      [1, 2].map(
        async (attempt) =>
          JSON.parse(
            await readFile(join(setup.folder, `result-${attempt}.json`), 'utf8'),
          ) as NotificationResult,
      ),
    );
    expect(results.map((item) => item.result.status)).toEqual(['REJECTED', 'DELIVERED']);
  });

  it('stops after three definite rejections', async () => {
    const setup = await campaign();
    const { sent, transport } = fake([REJECTED, REJECTED, REJECTED]);

    for (let run = 0; run < 3; run += 1) {
      await expect(deliver(setup, transport)).resolves.toEqual(counts({ rejected: 1 }));
    }
    await expect(deliver(setup, transport)).resolves.toEqual(counts({ exhausted: 1 }));
    expect(sent).toHaveLength(3);
  });

  it('does not send an Opportunity that has already expired', async () => {
    const setup = await campaign();
    const { sent, transport } = fake();

    await expect(deliver(setup, transport, OPPORTUNITY.expiresAt)).resolves.toEqual(
      counts({ expired: 1 }),
    );
    expect(sent).toEqual([]);
  });

  it('lets only one of two concurrent runners send', async () => {
    const setup = await campaign();
    const { sent, transport } = fake();

    const runs = await Promise.all([deliver(setup, transport), deliver(setup, transport)]);
    expect(sent).toHaveLength(1);
    expect(runs).toEqual(
      expect.arrayContaining([counts({ delivered: 1 }), counts({ unresolved: 1 })]),
    );
  });

  it('keeps delivery state apart from study evidence', async () => {
    const setup = await campaign();
    await deliver(setup, fake(['throws']).transport);
    await deliver(setup, fake([REJECTED]).transport);

    expect(await readFile(join(setup.slotDirectory, 'slot.json'), 'utf8')).toBe(setup.slotBytes);
    expect(await readdir(setup.slotDirectory)).toEqual(['slot.json']);
    expect((await readdir(setup.directory)).sort()).toEqual([
      'manifest.json',
      'notifications',
      'slots',
    ]);
  });
});

describe('Opportunity delivery lifecycle', () => {
  const deliver = (
    setup: { store: string; campaignId: string },
    now: number,
    answers: TransportResult[] = [],
  ) => {
    const { sent, transport } = fake(answers);
    return deliverOpportunityNotifications({
      campaignId: setup.campaignId,
      store: setup.store,
      transport,
      now: () => now,
    }).then((summary) => ({ summary, sent }));
  };
  /** A first send that Telegram definitely rejected, so a later run retries it. */
  const rejectedOnce = async (setup: { store: string; campaignId: string }) =>
    expect((await deliver(setup, START + 60 * MINUTE, [REJECTED])).summary).toEqual(
      counts({ rejected: 1 }),
    );

  it('retries immediately before the third daily open and never at it', async () => {
    for (const [now, expected] of [
      [EXPIRES - 1, counts({ delivered: 1 })],
      [EXPIRES, counts({ expired: 1 })],
    ] as const) {
      const setup = await campaign();
      await rejectedOnce(setup);
      await setup.later(1);
      await setup.later(2);

      const { summary, sent } = await deliver(setup, now);
      expect(summary).toEqual(expected);
      expect(sent).toHaveLength(expected.delivered);
    }
  });

  it.each([
    ['a delayed first delivery', 1, [2420], false],
    ['a retry', 2, [2450, 2300], true],
  ])(
    'does not send %s after a later daily low reaches invalidation',
    async (_label, days, lows, retry) => {
      const setup = await campaign();
      if (retry) await rejectedOnce(setup);
      for (let day = 1; day <= days; day += 1) {
        await setup.later(day, { lows: lows.slice(0, day) });
      }

      const { summary, sent } = await deliver(setup, START + days * DAY + 30 * MINUTE);
      expect(summary).toEqual(counts({ invalidated: 1 }));
      expect(sent).toEqual([]);
    },
  );

  it('does not send after a later completed slot fails the BTC market gate', async () => {
    const setup = await campaign();
    await setup.later(1, { gate: { passed: false, reasons: ['MARKET_HIGH_VOLATILITY'] } });

    const { summary, sent } = await deliver(setup, START + DAY + 30 * MINUTE);
    expect(summary).toEqual(counts({ marketGateFailed: 1 }));
    expect(sent).toEqual([]);
  });

  it.each([
    ['a due slot is not collected', null],
    ['BTC was not evaluated', { gate: { passed: false, reasons: ['MARKET_NOT_EVALUATED'] } }],
    ['the member data failed validation', { ethStatus: 'DATA_INVALID' }],
  ])('holds, without cancelling, while %s', async (_label, gap) => {
    const setup = await campaign();
    if (gap) await setup.later(1, gap);

    const held = await deliver(setup, START + DAY + 30 * MINUTE);
    expect(held.summary).toEqual(counts({ evidenceUnavailable: 1 }));
    expect(held.sent).toEqual([]);
    await expect(readdir(join(setup.directory))).resolves.not.toContain('notifications');

    // A later clean slot does not prove the earlier gap, so delivery stays held.
    await setup.later(2);
    const stillHeld = await deliver(setup, START + 2 * DAY + 30 * MINUTE);
    expect(stillHeld.summary).toEqual(counts({ evidenceUnavailable: 1 }));
  });

  it('sends once the gap is filled by the slot it was waiting for', async () => {
    const setup = await campaign();
    expect((await deliver(setup, START + DAY + MINUTE)).summary).toEqual(
      counts({ evidenceUnavailable: 1 }),
    );
    await setup.later(1);

    const { summary, sent } = await deliver(setup, START + DAY + 30 * MINUTE);
    expect(summary).toEqual(counts({ delivered: 1 }));
    expect(sent).toHaveLength(1);
  });

  it('ignores slots and candles recorded after the decision time', async () => {
    const setup = await campaign();
    // Day 1 is collected at 00:40 and records a touch and a failed market gate.
    await setup.later(1, {
      lows: [2000],
      gate: { passed: false, reasons: ['MARKET_HIGH_VOLATILITY'] },
      finishedAt: START + DAY + 10 * MINUTE,
    });

    // Before that slot exists, and between its due time and its completion.
    expect((await deliver(setup, START + DAY - MINUTE, [REJECTED])).summary).toEqual(
      counts({ rejected: 1 }),
    );
    expect((await deliver(setup, START + DAY + 5 * MINUTE)).summary).toEqual(
      counts({ evidenceUnavailable: 1 }),
    );
    expect((await deliver(setup, START + DAY + 10 * MINUTE)).summary).toEqual(
      counts({ marketGateFailed: 1 }),
    );
  });

  it('never resends an unresolved delivery, even after a later invalidation', async () => {
    const setup = await campaign();
    await mkdir(setup.folder, { recursive: true });
    await writeFile(join(setup.folder, 'attempt-1.json'), '{}');
    await setup.later(1, { lows: [2000] });

    const { summary, sent } = await deliver(setup, START + DAY + 30 * MINUTE);
    expect(summary).toEqual(counts({ unresolved: 1 }));
    expect(sent).toEqual([]);
  });

  it('refuses an Opportunity from a version-1 slot, whose expiry is observedAt + 72 hours', async () => {
    const setup = await campaign({ schemaVersion: '1' });

    const { summary, sent } = await deliver(setup, START + 60 * MINUTE);
    expect(summary).toEqual(counts({ incompatible: 1 }));
    expect(sent).toEqual([]);
  });

  it('writes nothing when it holds or cancels, and changes no study evidence', async () => {
    const setup = await campaign();
    await setup.later(1, { ethStatus: 'DATA_INVALID' });
    await setup.later(2, { lows: [2450, 2000] });
    const before = await Promise.all(
      [0, 1, 2].map((day) =>
        readFile(
          join(opportunitySlotDirectory(setup.directory, iso(START + day * DAY)), 'slot.json'),
          'utf8',
        ),
      ),
    );
    const manifest = await readFile(join(setup.directory, 'manifest.json'), 'utf8');

    for (const now of [START + DAY + 30 * MINUTE, START + 2 * DAY + 30 * MINUTE, EXPIRES]) {
      expect((await deliver(setup, now)).sent).toEqual([]);
    }
    expect(before[0]).toBe(setup.slotBytes);
    for (const [day, bytes] of before.entries()) {
      await expect(
        readFile(
          join(opportunitySlotDirectory(setup.directory, iso(START + day * DAY)), 'slot.json'),
          'utf8',
        ),
      ).resolves.toBe(bytes);
    }
    await expect(readFile(join(setup.directory, 'manifest.json'), 'utf8')).resolves.toBe(manifest);
    expect((await readdir(setup.directory)).sort()).toEqual(['manifest.json', 'slots']);
  });
});
