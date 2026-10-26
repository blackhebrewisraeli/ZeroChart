import { describe, expect, it } from 'vitest';
import {
  BINANCE_DAILY_CANDLE_POLICY_VERSION,
  DAY_MS,
  validateBinanceDailyCandles,
  type DailyCandle,
} from '@/lib/candleValidation';

const evaluationTime = Date.parse('2026-10-26T06:30:00.000Z');
const start = Date.parse('2026-09-01T00:00:00.000Z');

function candle(index: number, overrides: Partial<DailyCandle> = {}): DailyCandle {
  const timestamp = start + index * DAY_MS;
  return {
    timestamp,
    closeTime: timestamp + DAY_MS - 1,
    open: 100,
    high: 102,
    low: 98,
    close: 101,
    ...overrides,
  };
}

function codes(candles: DailyCandle[]) {
  return validateBinanceDailyCandles(candles, { evaluationTime }).issues.map((item) => item.code);
}

describe('Binance daily candle input contract', () => {
  it('accepts correct daily candles and reports its policy version', () => {
    const result = validateBinanceDailyCandles([candle(0), candle(1)], {
      evaluationTime,
      maxDataAgeMs: 60 * DAY_MS,
    });
    expect(result.structurallyValid).toBe(true);
    expect(result.policyVersion).toBe(BINANCE_DAILY_CANDLE_POLICY_VERSION);
    expect(result.fresh).toBe(true);
  });

  it('sorts valid unordered input without mutating the caller', () => {
    const input = [candle(2), candle(0), candle(1)];
    const result = validateBinanceDailyCandles(input, { evaluationTime });
    expect(result.normalized.map((item) => item.timestamp)).toEqual([
      candle(0).timestamp,
      candle(1).timestamp,
      candle(2).timestamp,
    ]);
    expect(input[0]?.timestamp).toBe(candle(2).timestamp);
  });

  it.each([
    ['identical duplicate', [candle(0), candle(0)], 'DUPLICATE_TIMESTAMP'],
    ['conflicting duplicate', [candle(0), candle(0, { close: 99 })], 'DUPLICATE_TIMESTAMP'],
    ['missing interval', [candle(0), candle(2)], 'MISSING_DAILY_INTERVAL'],
  ])('rejects %s', (_label, input, expected) => {
    expect(codes(input as DailyCandle[])).toContain(expected);
  });

  it.each([
    ['nonfinite', { close: Number.NaN }, 'NONFINITE_PRICE'],
    ['nonpositive', { low: 0 }, 'NON_POSITIVE_PRICE'],
    ['high below low', { high: 97 }, 'HIGH_BELOW_LOW'],
    ['open outside range', { open: 103 }, 'OPEN_OUTSIDE_RANGE'],
    ['close outside range', { close: 103 }, 'CLOSE_OUTSIDE_RANGE'],
    ['seconds timestamp', { timestamp: 1_700_000_000 }, 'TIMESTAMP_NOT_MILLISECONDS'],
    [
      'unaligned timestamp',
      { timestamp: start + 1, closeTime: start + DAY_MS },
      'TIMESTAMP_NOT_UTC_DAY_ALIGNED',
    ],
    [
      'next-midnight close convention',
      { closeTime: start + DAY_MS },
      'CLOSE_TIME_CONVENTION_MISMATCH',
    ],
  ])('rejects %s', (_label, overrides, expected) => {
    expect(codes([candle(0, overrides as Partial<DailyCandle>)])).toContain(expected);
  });

  it('excludes a not-yet-closed candle and keeps freshness separate from structure', () => {
    const latestClosed = candle(54);
    const openTimestamp = Date.parse('2026-10-26T00:00:00.000Z');
    const open = candle(55, {
      timestamp: openTimestamp,
      closeTime: openTimestamp + DAY_MS - 1,
    });
    const result = validateBinanceDailyCandles([latestClosed, open], {
      evaluationTime,
      maxDataAgeMs: 1,
    });
    expect(result.closed).toEqual([latestClosed]);
    expect(result.excludedOpenCount).toBe(1);
    expect(result.structurallyValid).toBe(true);
    expect(result.fresh).toBe(false);
  });

  it('validates only the configured model window, leaving older unused data untouched', () => {
    const oldInvalid = candle(0, { high: 1, low: 2 });
    const result = validateBinanceDailyCandles([oldInvalid, candle(1), candle(2)], {
      evaluationTime,
      modelWindow: 2,
    });
    expect(result.closed).toHaveLength(2);
    expect(result.structurallyValid).toBe(true);
  });
});
