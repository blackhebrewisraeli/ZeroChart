// @vitest-environment node

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Candle } from '@/lib/binance';
import { hashEvaluationConfig } from './evaluationStore';
import {
  campaignReport,
  initializeCampaign,
  reproduceCampaignRun,
  runDueCampaign,
  type CampaignManifest,
} from './observationCampaign';

const campaignId = 'private-2026q4-001';
const commit = '9d6e349000000000000000000000000000000000';
const slot = '2026-10-25T06:30:00.000Z';
const now = new Date('2026-10-25T07:00:00.000Z');
const day = 24 * 60 * 60 * 1000;

function candles(): Candle[] {
  const lastOpen = Date.parse('2026-10-24T00:00:00.000Z');
  return Array.from({ length: 40 }, (_, index) => {
    const timestamp = lastOpen - (39 - index) * day;
    return { timestamp, open: 100, high: 101, low: 99, close: 100 };
  });
}

async function createCampaign(store: string, start = slot): Promise<void> {
  await initializeCampaign({
    campaignId,
    start,
    end: slot,
    repositoryCommit: commit,
    store,
    now: new Date(Date.parse(start) - day),
  });
}

describe('prospective observation campaign', () => {
  it('requires exact UTC slot boundaries', async () => {
    const store = await mkdtemp(join(tmpdir(), 'zerochart-campaign-'));
    await expect(
      initializeCampaign({
        campaignId,
        start: '2026-10-25T06:29:00.000Z',
        end: slot,
        repositoryCommit: commit,
        store,
      }),
    ).rejects.toThrow('06:30:00Z');
  });

  it('rejects a backdated campaign start', async () => {
    const store = await mkdtemp(join(tmpdir(), 'zerochart-campaign-'));
    await expect(
      initializeCampaign({
        campaignId,
        start: slot,
        end: slot,
        repositoryCommit: commit,
        store,
        now,
      }),
    ).rejects.toThrow('cannot be backdated');
  });

  it('preserves failures, retries the slot, and never duplicates its success', async () => {
    const store = await mkdtemp(join(tmpdir(), 'zerochart-campaign-'));
    await createCampaign(store);
    let failBtc = true;
    let fetches = 0;
    const fetchCandles = async (ticker: string) => {
      fetches += 1;
      if (ticker === 'BTC-USD' && failBtc) throw new Error('temporary provider failure');
      return candles();
    };

    const failed = await runDueCampaign(campaignId, store, { now, fetchCandles });
    expect(failed.attempt.status).toBe('FAILED');
    failBtc = false;
    const completed = await runDueCampaign(campaignId, store, { now, fetchCandles });
    expect(completed.attempt.status).toBe('COMPLETED');
    const fetchesAfterSuccess = fetches;
    const duplicate = await runDueCampaign(campaignId, store, { now, fetchCandles });
    expect(duplicate.alreadyCompleted).toBe(true);
    expect(fetches).toBe(fetchesAfterSuccess);

    const report = await campaignReport(campaignId, store, now);
    expect(report.slots).toMatchObject({
      expected: 1,
      completed: 1,
      failed: 0,
      missed: 0,
      retryAttempts: 1,
    });
    expect(report.attempts.map((attempt) => attempt.status).sort()).toEqual([
      'COMPLETED',
      'FAILED',
    ]);
    expect(report.coverage.eligible).toBe(0);
    expect(report.coverage.selected).toBe(0);
  });

  it('detects missed slots without backdating observations', async () => {
    const store = await mkdtemp(join(tmpdir(), 'zerochart-campaign-'));
    await createCampaign(store, '2026-10-23T06:30:00.000Z');
    await runDueCampaign(campaignId, store, { now, fetchCandles: async () => candles() });
    const report = await campaignReport(campaignId, store, now);
    expect(report.slots).toMatchObject({ expected: 3, completed: 1, missed: 2 });
  });

  it('rejects a campaign configuration mismatch', async () => {
    const store = await mkdtemp(join(tmpdir(), 'zerochart-campaign-'));
    await createCampaign(store);
    const path = join(store, campaignId, 'manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8')) as CampaignManifest;
    manifest.configuration = {
      ...manifest.configuration,
      eligibility: { ...manifest.configuration.eligibility, minimumScore: 61 },
      configurationId: '',
    };
    manifest.configuration.configurationId = hashEvaluationConfig(manifest.configuration);
    await writeFile(path, JSON.stringify(manifest));
    await expect(
      runDueCampaign(campaignId, store, { now, fetchCandles: async () => candles() }),
    ).rejects.toThrow('frozen moderate configuration');
  });

  it('keeps live evidence separate and reproduces it with fetch blocked', async () => {
    const store = await mkdtemp(join(tmpdir(), 'zerochart-campaign-'));
    await createCampaign(store);
    await runDueCampaign(campaignId, store, { now, fetchCandles: async () => candles() });
    const result = await reproduceCampaignRun(campaignId, store, slot, true, now);
    expect(result).toMatchObject({ status: 'MATCH', networkBlocked: true });
    const report = await campaignReport(campaignId, store, now);
    expect(report.evidenceType).toBe('prospective-live');
    expect(report.attempts[0]?.runKey).toBeTruthy();
    expect(report.reproductions).toHaveLength(1);
    expect(report.reproductions[0]).toMatchObject({ status: 'MATCH', networkBlocked: true });
    expect(JSON.stringify(report)).not.toContain('fixture');
  });
});
