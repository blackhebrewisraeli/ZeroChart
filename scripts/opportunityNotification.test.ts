// @vitest-environment node

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
const COMMIT = 'a'.repeat(40);
const iso = (time: number) => new Date(time).toISOString();
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
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
  /** false: no reproduction receipt is written for the slot. */
  reproduced?: boolean;
}

/**
 * A completed slot's evidence: ETH's closed candles from the anchor through the
 * day before the slot. The anchor's own low is below invalidation, so only a
 * later candle may count.
 */
function slotJson(
  slot: number,
  options: SlotOptions,
  opportunities: object[],
  previous: { slot: string; sha256: string } | null,
) {
  const candles = Array.from({ length: (slot - (slot % DAY) - ANCHOR_OPEN) / DAY }, (_, day) => ({
    timestamp: ANCHOR_OPEN + day * DAY,
    low: day === 0 ? 2400 : (options.lows?.[day - 1] ?? 2450),
  }));
  return JSON.stringify({
    schemaVersion: options.schemaVersion ?? '2',
    previous,
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

/**
 * A campaign whose second slot persisted one ETH Opportunity, judged against the
 * first. Every slot is reproduced MATCH, as the frozen implementation would,
 * unless `reproduced` is false.
 */
async function campaign(options: SlotOptions = {}) {
  const store = await mkdtemp(join(tmpdir(), 'zerochart-notify-'));
  const campaignId = 'notify';
  await initializeOpportunityCampaign({
    campaignId,
    store,
    startSlot: START - DAY,
    endSlot: START + 179 * DAY,
    implementationCommit: COMMIT,
    now: START - 2 * DAY,
  });
  const directory = join(store, 'campaigns', campaignId);
  /** The slot `days` after the observation; -1 is the slot its transition was judged against. */
  const slotPath = (days: number) =>
    join(opportunitySlotDirectory(directory, iso(START + days * DAY)), 'slot.json');
  /** The receipt `opportunity-campaign-reproduce --block-network` writes at the frozen commit. */
  const reproduce = async (days: number, receipt: Record<string, unknown> = {}) => {
    const bytes = await readFile(slotPath(days), 'utf8');
    const reproductions = join(dirname(slotPath(days)), 'reproductions');
    await mkdir(reproductions, { recursive: true });
    await writeFile(
      join(reproductions, `${randomUUID()}.json`),
      JSON.stringify({
        schemaVersion: '1',
        campaignId,
        slot: iso(START + days * DAY),
        slotSha256: sha256(bytes),
        reproducedAt: (JSON.parse(bytes) as { attempts: Array<{ finishedAt: string }> })
          .attempts[0]!.finishedAt,
        networkBlocked: true,
        reproducerCommit: COMMIT,
        status: 'MATCH',
        reason: null,
        ...receipt,
      }),
    );
  };
  const record = async (days: number, slotOptions: SlotOptions, opportunities: object[] = []) => {
    const previous = await readFile(slotPath(days - 1), 'utf8').catch(() => null);
    const bytes = slotJson(
      START + days * DAY,
      slotOptions,
      opportunities,
      previous === null ? null : { slot: iso(START + (days - 1) * DAY), sha256: sha256(previous) },
    );
    await mkdir(dirname(slotPath(days)), { recursive: true });
    await writeFile(slotPath(days), bytes);
    if (slotOptions.reproduced !== false) await reproduce(days);
    return bytes;
  };
  await record(-1, {});
  const slotBytes = await record(0, options, [OPPORTUNITY]);
  const slotDirectory = dirname(slotPath(0));
  const folder = join(directory, 'notifications', `${SLOT.replaceAll(':', '-')}_ETH-USD`);
  /** Records the later slot `days` after the observation; it carries no new Opportunity. */
  const later = (days: number, slotOptions: SlotOptions = {}) => record(days, slotOptions);
  return {
    store,
    campaignId,
    directory,
    slotDirectory,
    slotBytes,
    folder,
    later,
    reproduce,
    slotPath,
  };
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

const counts = (changes: Record<string, number>, unverifiedSlots: Record<string, number> = {}) => ({
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
  originUnverified: 0,
  evidenceUnverified: 0,
  exhausted: 0,
  ...changes,
  unverifiedSlots: {
    UNSUPPORTED_SCHEMA: 0,
    NOT_REPRODUCED: 0,
    REPRODUCTION_MISMATCH: 0,
    PREDECESSOR_CHANGED: 0,
    PREDECESSOR_UNVERIFIED: 0,
    ...unverifiedSlots,
  },
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
    expect((await readdir(setup.slotDirectory)).sort()).toEqual(['reproductions', 'slot.json']);
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

describe('Delivery verification', () => {
  type Setup = Awaited<ReturnType<typeof campaign>>;
  const deliver = (setup: Setup, now: number, answers: TransportResult[] = []) => {
    const { sent, transport } = fake(answers);
    return deliverOpportunityNotifications({
      campaignId: setup.campaignId,
      store: setup.store,
      transport,
      now: () => now,
    }).then((summary) => ({ summary, sent }));
  };
  /** A refusal: nothing claimed, nothing sent. */
  const refused = async (
    setup: Setup,
    now: number,
    changes: Record<string, number>,
    reasons: Record<string, number>,
  ) => {
    const { summary, sent } = await deliver(setup, now);
    expect(summary).toEqual(counts(changes, reasons));
    expect(sent).toEqual([]);
    await expect(readdir(setup.directory)).resolves.not.toContain('notifications');
  };

  it('sends exactly once when the slot, its predecessor and every later slot reproduced MATCH', async () => {
    const setup = await campaign();
    await setup.later(1);
    await setup.later(2);

    const first = await deliver(setup, START + 2 * DAY + 30 * MINUTE);
    expect(first.summary).toEqual(counts({ delivered: 1 }));
    expect(first.sent).toHaveLength(1);
    expect((await deliver(setup, START + 2 * DAY + 40 * MINUTE)).summary).toEqual(
      counts({ alreadyDelivered: 1 }),
    );
  });

  it.each([
    ['no reproduction', null, 'NOT_REPRODUCED'],
    ['a MISMATCH', { status: 'MISMATCH', reason: 'OUTPUT_MISMATCH' }, 'REPRODUCTION_MISMATCH'],
    ['a MATCH with the network open', { networkBlocked: false }, 'NOT_REPRODUCED'],
    ['a MATCH from a modified checkout', { reproducerCommit: null }, 'NOT_REPRODUCED'],
    ['a MATCH from another commit', { reproducerCommit: 'c'.repeat(40) }, 'NOT_REPRODUCED'],
    ['a MATCH that names no reproducer', { reproducerCommit: undefined }, 'NOT_REPRODUCED'],
    ['a MATCH from another campaign', { campaignId: 'other' }, 'NOT_REPRODUCED'],
    ['a MATCH of another slot', { slot: iso(START + DAY) }, 'NOT_REPRODUCED'],
    ['a MATCH of older bytes', { slotSha256: sha256('older slot bytes') }, 'NOT_REPRODUCED'],
    [
      'a MATCH recorded after the decision',
      { reproducedAt: iso(START + 2 * 60 * MINUTE) },
      'NOT_REPRODUCED',
    ],
  ])('sends nothing from a slot with %s', async (_label, receipt, reason) => {
    const setup = await campaign({ reproduced: false });
    if (receipt) await setup.reproduce(0, receipt);

    await refused(setup, START + 60 * MINUTE, { originUnverified: 1 }, { [reason]: 1 });
  });

  it('lets the latest receipt for the same bytes decide, and a MISMATCH win a tie', async () => {
    const setup = await campaign();
    await setup.reproduce(0, {
      reproducedAt: iso(START + 20 * MINUTE),
      status: 'MISMATCH',
      reason: 'OUTPUT_MISMATCH',
    });
    await refused(
      setup,
      START + 60 * MINUTE,
      { originUnverified: 1 },
      { REPRODUCTION_MISMATCH: 1 },
    );

    await setup.reproduce(0, { reproducedAt: iso(START + 70 * MINUTE) });
    expect((await deliver(setup, START + 80 * MINUTE)).summary).toEqual(counts({ delivered: 1 }));

    // Recorded at the same instant as the default MATCH.
    const tie = await campaign();
    await tie.reproduce(0, { status: 'MISMATCH', reason: 'OUTPUT_MISMATCH' });
    await refused(tie, START + 60 * MINUTE, { originUnverified: 1 }, { REPRODUCTION_MISMATCH: 1 });
  });

  it('does not let an earlier MATCH authorize slot bytes modified after it', async () => {
    const setup = await campaign();
    await writeFile(setup.slotPath(0), setup.slotBytes.replace('"score":85', '"score":99'));

    await refused(setup, START + 60 * MINUTE, { originUnverified: 1 }, { NOT_REPRODUCED: 1 });
  });

  it.each([
    [
      'modified after its MATCH',
      async (setup: Setup) =>
        writeFile(setup.slotPath(-1), `${await readFile(setup.slotPath(-1), 'utf8')} `),
      'PREDECESSOR_CHANGED',
    ],
    ['removed', (setup: Setup) => rm(setup.slotPath(-1)), 'PREDECESSOR_CHANGED'],
    [
      'unchanged but last reproduced MISMATCH',
      (setup: Setup) =>
        setup.reproduce(-1, {
          reproducedAt: iso(START + 10 * MINUTE),
          status: 'MISMATCH',
          reason: 'OUTPUT_MISMATCH',
        }),
      'PREDECESSOR_UNVERIFIED',
    ],
  ])(
    'sends nothing when the slot the transition was judged against is %s',
    async (_label, change, reason) => {
      const setup = await campaign();
      await change(setup);

      await refused(setup, START + 60 * MINUTE, { originUnverified: 1 }, { [reason]: 1 });
    },
  );

  it.each([
    ['not reproduced', { reproduced: false }, null, 'NOT_REPRODUCED'],
    ['an unverified touch', { reproduced: false, lows: [2000] }, null, 'NOT_REPRODUCED'],
    [
      'a mismatched failed gate',
      { reproduced: false, gate: { passed: false, reasons: ['MARKET_HIGH_VOLATILITY'] } },
      { status: 'MISMATCH', reason: 'OUTPUT_MISMATCH' },
      'REPRODUCTION_MISMATCH',
    ],
    ['schema 1, matched by its own code', { schemaVersion: '1' }, null, 'UNSUPPORTED_SCHEMA'],
  ])(
    'holds, neither sending nor cancelling, on a later slot that is %s',
    async (_label, slotOptions, receipt, reason) => {
      const setup = await campaign();
      await setup.later(1, slotOptions);
      if (receipt) await setup.reproduce(1, receipt);

      await refused(setup, START + DAY + 30 * MINUTE, { evidenceUnverified: 1 }, { [reason]: 1 });
    },
  );

  it('keeps a slot that failed on day one blocked on day two, then sends after a legitimate MATCH', async () => {
    const setup = await campaign({ reproduced: false });
    await setup.reproduce(0, { status: 'MISMATCH', reason: 'PREVIOUS_SLOT_MISMATCH' });
    await refused(
      setup,
      START + 60 * MINUTE,
      { originUnverified: 1 },
      { REPRODUCTION_MISMATCH: 1 },
    );

    // Day two's own slot reproduces; the day-one Opportunity stays held.
    await setup.later(1);
    await refused(
      setup,
      START + DAY + 30 * MINUTE,
      { originUnverified: 1 },
      { REPRODUCTION_MISMATCH: 1 },
    );

    await setup.reproduce(0, { reproducedAt: iso(START + DAY + 40 * MINUTE) });
    const recovered = await deliver(setup, START + DAY + 50 * MINUTE);
    expect(recovered.summary).toEqual(counts({ delivered: 1 }));
    expect(recovered.sent).toHaveLength(1);
  });

  it('stops reporting an unverified slot once its Opportunity has expired', async () => {
    const setup = await campaign({ reproduced: false });

    const { summary, sent } = await deliver(setup, EXPIRES);
    expect(summary).toEqual(counts({ expired: 1 }));
    expect(sent).toEqual([]);
  });

  it('sends after the later slot it held on is reproduced', async () => {
    const setup = await campaign();
    await setup.later(1, { reproduced: false });
    await refused(
      setup,
      START + DAY + 30 * MINUTE,
      { evidenceUnverified: 1 },
      { NOT_REPRODUCED: 1 },
    );

    await setup.reproduce(1, { reproducedAt: iso(START + DAY + 40 * MINUTE) });
    expect((await deliver(setup, START + DAY + 50 * MINUTE)).summary).toEqual(
      counts({ delivered: 1 }),
    );
  });

  it('never resends a delivered or unresolved Opportunity, whatever verification finds later', async () => {
    const delivered = await campaign();
    expect((await deliver(delivered, START + 60 * MINUTE)).summary).toEqual(
      counts({ delivered: 1 }),
    );
    await delivered.reproduce(0, {
      reproducedAt: iso(START + 70 * MINUTE),
      status: 'MISMATCH',
      reason: 'OUTPUT_MISMATCH',
    });
    const again = await deliver(delivered, START + 80 * MINUTE);
    expect(again.summary).toEqual(counts({ alreadyDelivered: 1 }));
    expect(again.sent).toEqual([]);

    const unresolved = await campaign({ reproduced: false });
    await mkdir(unresolved.folder, { recursive: true });
    await writeFile(join(unresolved.folder, 'attempt-1.json'), '{}');
    const held = await deliver(unresolved, START + 60 * MINUTE);
    expect(held.summary).toEqual(counts({ unresolved: 1 }));
    expect(held.sent).toEqual([]);
  });

  it('reads evidence and receipts without writing or repairing any', async () => {
    const setup = await campaign({ reproduced: false });
    await setup.later(1, { reproduced: false });
    await setup.reproduce(1, { status: 'MISMATCH', reason: 'OUTPUT_MISMATCH' });
    const snapshot = async () =>
      Promise.all(
        [-1, 0, 1].map(async (day) => {
          const reproductions = join(dirname(setup.slotPath(day)), 'reproductions');
          const receipts = (await readdir(reproductions).catch(() => [])).sort();
          return {
            slot: await readFile(setup.slotPath(day), 'utf8'),
            receipts: await Promise.all(
              receipts.map((name) => readFile(join(reproductions, name), 'utf8')),
            ),
          };
        }),
      );
    const before = await snapshot();
    const manifest = await readFile(join(setup.directory, 'manifest.json'), 'utf8');

    await refused(setup, START + DAY + 30 * MINUTE, { originUnverified: 1 }, { NOT_REPRODUCED: 1 });
    expect(await snapshot()).toEqual(before);
    expect(before[1]!.slot).toBe(setup.slotBytes);
    await expect(readFile(join(setup.directory, 'manifest.json'), 'utf8')).resolves.toBe(manifest);
    expect((await readdir(setup.directory)).sort()).toEqual(['manifest.json', 'slots']);
  });
});
