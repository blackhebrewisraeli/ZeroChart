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
const START = Date.UTC(2026, 9, 30, 0, 30);
const SLOT = new Date(START).toISOString();
const SPECIFICATION_ID = '0eddcc4f81ba47d74168392bb50af64050d3a9db2ab56da914c3814087d64483';
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
  expiresAt: START + 3 * DAY,
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

/** A campaign whose first slot persisted one ETH Opportunity. */
async function campaign() {
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
  await mkdir(slotDirectory, { recursive: true });
  const slotBytes = JSON.stringify({
    result: {
      scan: {
        modelVersion: '1.0.0',
        results: [
          { ticker: 'ETH-USD', dataAsOf: START - 30 * 60_000 - 1, model: { rationale: RATIONALE } },
        ],
      },
      marketGate: { passed: true, reasons: [] },
      assets: [
        { ticker: 'BTC-USD', close: 70000, smaFast: 66000, smaSlow: 60000, regime: 'TRENDING' },
      ],
      opportunities: [OPPORTUNITY],
    },
  });
  await writeFile(join(slotDirectory, 'slot.json'), slotBytes);
  const folder = join(directory, 'notifications', `${SLOT.replaceAll(':', '-')}_ETH-USD`);
  return { store, campaignId, directory, slotDirectory, slotBytes, folder };
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
      'Primary horizon 20 days · expires 2026-11-02 00:30 UTC',
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
