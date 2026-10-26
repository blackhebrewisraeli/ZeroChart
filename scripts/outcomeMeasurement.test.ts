// @vitest-environment node

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DecisionSnapshot } from '@/lib/evaluationLab';
import {
  OutcomeConflictError,
  LEGACY_OUTCOME_SPECIFICATION_ID,
  OUTCOME_SPECIFICATION,
  firstDailyOpenStrictlyAfter,
  loadCampaignOutcomes,
  measureOutcome,
  saveOutcomeRecord,
} from './outcomeMeasurement';
import { stableSerialize } from './evaluationStore';

const day = 86_400_000;

function decision(asset = 'ETH-USD'): DecisionSnapshot {
  return {
    logicalKey: `run:${asset}`,
    evaluationTime: Date.parse('2026-10-25T06:30:00.000Z'),
    dataAsOf: Date.parse('2026-10-25T00:00:00.000Z'),
    asset,
    source: 'fixture',
    timeframe: '1d',
    strategyVersion: 'strategy-v1',
    modelVersion: 'model-v1',
    configurationId: 'config-v1',
    inputReference: 'fixture',
    inputSnapshot: [],
    status: 'ELIGIBLE',
    selectionStatus: 'SELECTED',
    rejectionReasons: [],
    proposedAction: 'PROPOSE_ALLOCATION',
    score: 72,
    scoreComponents: null,
    regime: null,
    rationale: null,
    close: 100,
    atr: 2,
    allocationWeight: 1,
    allocatedAmount: 100_000,
    observedInputCount: 40,
  };
}

function candles(reference: number, opens: number[]) {
  return opens.map((open, index) => ({
    openTime: reference + index * day,
    closeTime: reference + (index + 1) * day - 1,
    open,
    high: open + 1,
    low: open - 1,
    close: open,
  }));
}

function record(
  options: {
    observedAt?: string;
    slot?: string;
    now?: string;
    assetCandles?: ReturnType<typeof candles>;
    benchmarkCandles?: ReturnType<typeof candles>;
    synthetic?: boolean;
  } = {},
) {
  const observedAt = options.observedAt ?? '2026-10-25T23:59:59.999Z';
  const reference = firstDailyOpenStrictlyAfter(observedAt);
  return measureOutcome({
    campaignId: 'campaign',
    slot: options.slot ?? '2026-10-25T06:30:00.000Z',
    runKey: 'run',
    observedAt,
    decision: decision(),
    assetCandles:
      options.assetCandles ??
      candles(
        reference,
        Array(31)
          .fill(100)
          .map((v, i) => v + i),
      ),
    benchmarkCandles:
      options.benchmarkCandles ??
      candles(
        reference,
        Array(31)
          .fill(100)
          .map((v, i) => v + i / 2),
      ),
    now: new Date(options.now ?? '2026-11-26T00:00:00.000Z'),
    fetchedAt: new Date('2026-11-26T00:01:00.000Z'),
    ...(options.synthetic === undefined ? {} : { synthetic: options.synthetic }),
  });
}

describe('prospective signal outcomes', () => {
  it('keeps the versioned machine-readable specification aligned with code', async () => {
    const documented = JSON.parse(
      await readFile('docs/outcome-measurement.v2.json', 'utf8'),
    ) as unknown;
    expect(stableSerialize(documented)).toBe(stableSerialize(OUTCOME_SPECIFICATION));
  });

  it('selects the first daily UTC OPEN strictly after actual observation time', () => {
    expect(new Date(firstDailyOpenStrictlyAfter('2026-10-25T00:00:00.000Z')).toISOString()).toBe(
      '2026-10-26T00:00:00.000Z',
    );
    const measured = record({
      observedAt: '2026-10-26T01:00:00.000Z',
      slot: '2026-10-25T06:30:00.000Z',
    });
    expect(measured.referenceOpenTime).toBe('2026-10-27T00:00:00.000Z');
    expect(measured.scheduledSlot).not.toBe(measured.observedAt);
  });

  it('uses exact UTC horizon boundaries and calculates BTC percentage-point differences', () => {
    const measured = record();
    expect(measured.horizons.map((item) => item.endpointOpenTime)).toEqual([
      '2026-10-27T00:00:00.000Z',
      '2026-11-02T00:00:00.000Z',
      '2026-11-25T00:00:00.000Z',
    ]);
    expect(measured.horizons[0]?.status).toBe('AVAILABLE');
    expect(measured.horizons[0]?.assetChangePct).toBeCloseTo(1);
    expect(measured.horizons[0]?.benchmarkChangePct).toBeCloseTo(0.5);
    expect(measured.horizons[0]?.differencePercentagePoints).toBeCloseTo(0.5);
  });

  it('distinguishes pending from matured-but-missing without nearest-candle substitution', () => {
    const reference = firstDailyOpenStrictlyAfter('2026-10-25T23:59:59.999Z');
    const measured = record({
      now: '2026-10-28T00:00:00.000Z',
      assetCandles: candles(reference, [100]),
      benchmarkCandles: candles(reference, [100]),
    });
    expect(measured.horizons.map((item) => item.status)).toEqual(['MISSING', 'PENDING', 'PENDING']);
  });

  it('marks duplicate exact candles invalid/conflicting', () => {
    const reference = firstDailyOpenStrictlyAfter('2026-10-25T23:59:59.999Z');
    const duplicated = [...candles(reference, [100, 101]), ...candles(reference + day, [102])];
    const measured = record({
      now: '2026-10-28T00:00:00.000Z',
      assetCandles: duplicated,
      benchmarkCandles: candles(reference, [100, 101]),
    });
    expect(measured.horizons[0]?.status).toBe('INVALID_CONFLICTING');
  });

  it('refuses an invalid reference or endpoint candle', () => {
    const reference = firstDailyOpenStrictlyAfter('2026-10-25T23:59:59.999Z');
    const invalidReference = candles(reference, [100, 101]);
    invalidReference[0] = { ...invalidReference[0]!, high: 90, low: 110 };
    const invalidEndpoint = candles(reference, [100, 101]);
    invalidEndpoint[1] = { ...invalidEndpoint[1]!, close: 200 };

    expect(
      record({
        now: '2026-10-28T00:00:00.000Z',
        assetCandles: invalidReference,
        benchmarkCandles: candles(reference, [100, 101]),
      }).horizons[0],
    ).toMatchObject({ status: 'INVALID_CONFLICTING', endpointPrice: null });
    expect(
      record({
        now: '2026-10-28T00:00:00.000Z',
        assetCandles: invalidEndpoint,
        benchmarkCandles: candles(reference, [100, 101]),
      }).horizons[0],
    ).toMatchObject({ status: 'INVALID_CONFLICTING', endpointPrice: null });
  });

  it('is idempotent but rejects a provider revision instead of overwriting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zerochart-outcome-'));
    const path = join(root, 'record.json');
    const original = record();
    await expect(saveOutcomeRecord(path, original)).resolves.toBe('CREATED');
    await expect(saveOutcomeRecord(path, original)).resolves.toBe('UNCHANGED');
    const revised = structuredClone(original);
    revised.referencePrice = 999;
    await expect(saveOutcomeRecord(path, revised)).rejects.toBeInstanceOf(OutcomeConflictError);
  });

  it('loads legacy outcome evidence without rewriting it', async () => {
    const store = await mkdtemp(join(tmpdir(), 'zerochart-outcome-'));
    const legacy = structuredClone(record());
    legacy.schemaVersion = '1';
    legacy.outcomeSpecificationId = LEGACY_OUTCOME_SPECIFICATION_ID;
    delete legacy.candleValidationPolicyVersion;
    const directory = join(
      store,
      legacy.campaignId,
      'outcomes',
      LEGACY_OUTCOME_SPECIFICATION_ID,
      'legacy-slot',
    );
    await mkdir(directory, { recursive: true });
    const content = `${JSON.stringify(legacy, null, 2)}\n`;
    const path = join(directory, 'ETH-USD.json');
    await writeFile(path, content);

    await expect(loadCampaignOutcomes(legacy.campaignId, store)).resolves.toMatchObject([
      { schemaVersion: '1', outcomeSpecificationId: LEGACY_OUTCOME_SPECIFICATION_ID },
    ]);
    await expect(readFile(path, 'utf8')).resolves.toBe(content);
  });

  it('labels pre-freeze and synthetic evidence honestly', () => {
    const measured = record({
      observedAt: '2026-10-24T12:00:00.000Z',
      synthetic: true,
    });
    expect(measured.analysisRegistration).toBe('RETROSPECTIVELY_SPECIFIED');
    expect(measured.synthetic).toBe(true);
  });

  it('identifies BTC versus itself with an exact zero difference', () => {
    const observedAt = '2026-10-25T23:59:59.999Z';
    const reference = firstDailyOpenStrictlyAfter(observedAt);
    const btc = candles(
      reference,
      Array(31)
        .fill(100)
        .map((v, i) => v + i),
    );
    const measured = measureOutcome({
      campaignId: 'campaign',
      slot: '2026-10-25T06:30:00.000Z',
      runKey: 'run',
      observedAt,
      decision: decision('BTC-USD'),
      assetCandles: btc,
      benchmarkCandles: btc,
      now: new Date('2026-11-26T00:00:00.000Z'),
    });
    expect(measured.horizons.every((item) => item.differencePercentagePoints === 0)).toBe(true);
  });
});
