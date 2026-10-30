// @vitest-environment node

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  OPPORTUNITY_SPECIFICATION_ID,
  OpportunitySpecificationError,
  computeOpportunitySpecificationId,
  loadOpportunitySpecification,
  parseOpportunitySpecification,
} from './opportunitySpecification';

const SPECIFICATION_PATH = 'docs/opportunity-radar.v1.json';

async function documentedSpecification(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(SPECIFICATION_PATH, 'utf8')) as Record<string, unknown>;
}

describe('Opportunity Radar frozen specification', () => {
  it('loads the committed contract and exposes its exact runtime decisions', async () => {
    const loaded = await loadOpportunitySpecification();

    expect(loaded.specification.specificationId).toBe(OPPORTUNITY_SPECIFICATION_ID);
    expect(computeOpportunitySpecificationId(loaded.specification)).toBe(
      OPPORTUNITY_SPECIFICATION_ID,
    );
    expect(loaded.runtime).toEqual({
      specificationId: OPPORTUNITY_SPECIFICATION_ID,
      studyId: 'zerochart-opportunity-radar-binance-spot-v1',
      universe: [
        { ticker: 'BTC-USD', instrument: 'BTCUSDT' },
        { ticker: 'ETH-USD', instrument: 'ETHUSDT' },
        { ticker: 'BNB-USD', instrument: 'BNBUSDT' },
        { ticker: 'SOL-USD', instrument: 'SOLUSDT' },
        { ticker: 'XRP-USD', instrument: 'XRPUSDT' },
        { ticker: 'ADA-USD', instrument: 'ADAUSDT' },
        { ticker: 'DOGE-USD', instrument: 'DOGEUSDT' },
        { ticker: 'AVAX-USD', instrument: 'AVAXUSDT' },
        { ticker: 'LINK-USD', instrument: 'LINKUSDT' },
        { ticker: 'DOT-USD', instrument: 'DOTUSDT' },
        { ticker: 'LTC-USD', instrument: 'LTCUSDT' },
        { ticker: 'BCH-USD', instrument: 'BCHUSDT' },
      ],
      schedule: {
        primarySlot: '00:30:00.000Z',
        retryDeadline: '06:00:00.000Z',
      },
      indicators: { smaFast: 50, smaSlow: 200 },
      candidate: {
        minimumScore: 78,
        minimumMomentumPercent: 0.0005,
        excludeHighVolatility: true,
        requireCloseAboveFastSma: true,
        requireFastSmaAboveSlowSma: true,
      },
      marketGate: {
        benchmark: 'BTC-USD',
        excludeHighVolatility: true,
        requireCloseAboveSlowSma: true,
        requireFastSmaAboveSlowSma: true,
      },
      opportunity: {
        entryZoneAtrBelowClose: 0.5,
        entryZoneAtrAboveClose: 0.25,
        invalidationAtrBelowClose: 2,
        validDailyOpens: 3,
        primaryHorizonDays: 20,
        secondaryHorizonDays: [5, 10, 30],
      },
      costs: {
        entryFeeBps: 10,
        exitFeeBps: 10,
        entrySlippageBps: 5,
        exitSlippageBps: 5,
        roundTripBps: 30,
      },
      decisionGate: {
        minimumCalendarSlots: 180,
        minimumMaturedPrimaryOutcomes: 40,
        minimumDistinctAssets: 6,
        minimumDistinctOpportunityMonths: 4,
        maximumSingleAssetShare: 0.3,
        minimumCompletedSlotFraction: 0.95,
      },
    });
  });

  it('computes the same identifier after JSON keys are reordered', async () => {
    const documented = await documentedSpecification();
    const reordered = Object.fromEntries(Object.entries(documented).reverse());

    expect(computeOpportunitySpecificationId(reordered)).toBe(OPPORTUNITY_SPECIFICATION_ID);
    expect(parseOpportunitySpecification(reordered).specification.specificationId).toBe(
      OPPORTUNITY_SPECIFICATION_ID,
    );
  });

  it('rejects a semantic change under the frozen identifier', async () => {
    const documented = await documentedSpecification();
    const changed = structuredClone(documented);
    const outcomes = changed['outcomes'] as Record<string, unknown>;
    const costModel = outcomes['costModel'] as Record<string, unknown>;
    costModel['roundTripBps'] = 31;

    expect(() => parseOpportunitySpecification(changed)).toThrow(
      expect.objectContaining({ code: 'IDENTIFIER_MISMATCH' }),
    );
  });

  it('rejects an unsupported schema even when its identifier is recomputed', async () => {
    const documented = await documentedSpecification();
    const changed = structuredClone(documented);
    changed['schemaVersion'] = '2';
    changed['specificationId'] = computeOpportunitySpecificationId(changed);

    expect(() => parseOpportunitySpecification(changed)).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_SPECIFICATION' }),
    );
  });

  it('rejects malformed members before exposing runtime config', async () => {
    const documented = await documentedSpecification();
    const changed = structuredClone(documented);
    const universe = changed['universe'] as Record<string, unknown>;
    universe['members'] = [{ ticker: 'BTC-USD' }];

    expect(() => parseOpportunitySpecification(changed)).toThrow(
      expect.objectContaining({ code: 'INVALID_SCHEMA' }),
    );
  });

  it('uses a typed contract error for an unreadable specification', async () => {
    await expect(loadOpportunitySpecification('docs/does-not-exist.json')).rejects.toBeInstanceOf(
      OpportunitySpecificationError,
    );
  });
});
