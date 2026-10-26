export const BINANCE_DAILY_CANDLE_POLICY_VERSION = 'binance-daily-v1' as const;
export const DAY_MS = 86_400_000;
export const BINANCE_DAILY_CLOSE_OFFSET_MS = DAY_MS - 1;

export type CandleIssueCode =
  | 'MALFORMED_PROVIDER_ROW'
  | 'INVALID_TIMESTAMP'
  | 'TIMESTAMP_NOT_MILLISECONDS'
  | 'TIMESTAMP_NOT_UTC_DAY_ALIGNED'
  | 'INVALID_CLOSE_TIME'
  | 'CLOSE_TIME_CONVENTION_MISMATCH'
  | 'NONFINITE_PRICE'
  | 'NON_POSITIVE_PRICE'
  | 'HIGH_BELOW_LOW'
  | 'OPEN_OUTSIDE_RANGE'
  | 'CLOSE_OUTSIDE_RANGE'
  | 'DUPLICATE_TIMESTAMP'
  | 'MISSING_DAILY_INTERVAL';

export interface DailyCandle {
  timestamp: number;
  closeTime: number;
  open?: number;
  high: number;
  low: number;
  close: number;
}

export interface CandleIssue {
  code: CandleIssueCode;
  index: number;
  timestamp: number | null;
  detail: string;
  relatedTimestamp?: number;
}

export interface CandleValidationResult<T extends DailyCandle> {
  policyVersion: typeof BINANCE_DAILY_CANDLE_POLICY_VERSION;
  normalized: T[];
  closed: T[];
  excludedOpenCount: number;
  issues: CandleIssue[];
  structurallyValid: boolean;
  latestCloseTime: number | null;
  fresh: boolean | null;
}

function issue(
  code: CandleIssueCode,
  index: number,
  candle: Partial<DailyCandle>,
  detail: string,
  relatedTimestamp?: number,
): CandleIssue {
  return {
    code,
    index,
    timestamp: Number.isFinite(candle.timestamp) ? candle.timestamp! : null,
    detail,
    ...(relatedTimestamp === undefined ? {} : { relatedTimestamp }),
  };
}

function validateTimestamp(candle: DailyCandle, index: number): CandleIssue[] {
  if (!Number.isSafeInteger(candle.timestamp) || candle.timestamp <= 0) {
    return [issue('INVALID_TIMESTAMP', index, candle, 'Open time must be a positive integer.')];
  }
  const issues: CandleIssue[] = [];
  if (candle.timestamp < 100_000_000_000 || candle.timestamp > 10_000_000_000_000) {
    issues.push(
      issue(
        'TIMESTAMP_NOT_MILLISECONDS',
        index,
        candle,
        'Open time must be Unix epoch milliseconds.',
      ),
    );
  }
  if (candle.timestamp % DAY_MS !== 0) {
    issues.push(
      issue(
        'TIMESTAMP_NOT_UTC_DAY_ALIGNED',
        index,
        candle,
        'Daily open time must be aligned to 00:00:00.000 UTC.',
      ),
    );
  }
  return issues;
}

function validateCloseTime(candle: DailyCandle, index: number): CandleIssue[] {
  if (!Number.isSafeInteger(candle.closeTime) || candle.closeTime <= candle.timestamp) {
    return [
      issue('INVALID_CLOSE_TIME', index, candle, 'Close time must be an integer after open time.'),
    ];
  }
  if (candle.closeTime !== candle.timestamp + BINANCE_DAILY_CLOSE_OFFSET_MS) {
    return [
      issue(
        'CLOSE_TIME_CONVENTION_MISMATCH',
        index,
        candle,
        'Binance 1d close time must be open time plus 86,399,999 ms.',
      ),
    ];
  }
  return [];
}

function validatePrices(candle: DailyCandle, index: number): CandleIssue[] {
  const issues: CandleIssue[] = [];
  const prices = [
    ...(candle.open === undefined ? [] : ([['open', candle.open]] as const)),
    ['high', candle.high] as const,
    ['low', candle.low] as const,
    ['close', candle.close] as const,
  ];
  for (const [field, value] of prices) {
    if (!Number.isFinite(value)) {
      issues.push(issue('NONFINITE_PRICE', index, candle, `${field} must be finite.`));
    } else if (value <= 0) {
      issues.push(issue('NON_POSITIVE_PRICE', index, candle, `${field} must be positive.`));
    }
  }
  if (Number.isFinite(candle.high) && Number.isFinite(candle.low) && candle.high < candle.low) {
    issues.push(
      issue('HIGH_BELOW_LOW', index, candle, 'high must be greater than or equal to low.'),
    );
  }
  if (
    candle.open !== undefined &&
    Number.isFinite(candle.open) &&
    Number.isFinite(candle.low) &&
    Number.isFinite(candle.high) &&
    (candle.open < candle.low || candle.open > candle.high)
  ) {
    issues.push(issue('OPEN_OUTSIDE_RANGE', index, candle, 'open must be within [low, high].'));
  }
  if (
    Number.isFinite(candle.close) &&
    Number.isFinite(candle.low) &&
    Number.isFinite(candle.high) &&
    (candle.close < candle.low || candle.close > candle.high)
  ) {
    issues.push(issue('CLOSE_OUTSIDE_RANGE', index, candle, 'close must be within [low, high].'));
  }
  return issues;
}

/**
 * Validates Binance 1d candles without repairing provider data. Sorting is the
 * sole normalization. Open candles are excluded before cadence and model-window
 * checks, and no deduplication, interpolation, fill, or price inference occurs.
 */
export function validateBinanceDailyCandles<T extends DailyCandle>(
  candles: readonly T[],
  options: {
    evaluationTime: number;
    maxDataAgeMs?: number;
    modelWindow?: number;
  },
): CandleValidationResult<T> {
  const normalized = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  // Closure selection is derived from the provider's documented interval
  // boundary, so a malformed closeTime cannot disguise an otherwise completed
  // candle as still open and bypass validation.
  const closedAll = normalized.filter(
    (candle) => candle.timestamp + BINANCE_DAILY_CLOSE_OFFSET_MS <= options.evaluationTime,
  );
  const closed =
    options.modelWindow === undefined ? closedAll : closedAll.slice(-options.modelWindow);
  const issues: CandleIssue[] = [];

  closed.forEach((candle, index) => {
    issues.push(
      ...validateTimestamp(candle, index),
      ...validateCloseTime(candle, index),
      ...validatePrices(candle, index),
    );
  });

  // A timestamp that cannot be placed on the timeline must not disappear as
  // though it were merely a not-yet-closed candle.
  normalized.forEach((candle, index) => {
    if (
      !closed.includes(candle) &&
      (!Number.isSafeInteger(candle.timestamp) || candle.timestamp <= 0)
    ) {
      issues.push(
        issue('INVALID_TIMESTAMP', index, candle, 'Open time must be a positive integer.'),
      );
    }
  });

  for (let index = 1; index < closed.length; index += 1) {
    const previous = closed[index - 1]!;
    const current = closed[index]!;
    const difference = current.timestamp - previous.timestamp;
    if (difference === 0) {
      issues.push(
        issue(
          'DUPLICATE_TIMESTAMP',
          index,
          current,
          'Daily open timestamps must be unique; duplicates are not deduplicated.',
          previous.timestamp,
        ),
      );
    } else if (difference !== DAY_MS) {
      issues.push(
        issue(
          'MISSING_DAILY_INTERVAL',
          index,
          current,
          `Expected a ${DAY_MS} ms daily interval; received ${difference} ms.`,
          previous.timestamp,
        ),
      );
    }
  }

  const latestCloseTime = closed.at(-1)?.closeTime ?? null;
  return {
    policyVersion: BINANCE_DAILY_CANDLE_POLICY_VERSION,
    normalized,
    closed,
    excludedOpenCount: normalized.length - closedAll.length,
    issues,
    structurallyValid: issues.length === 0,
    latestCloseTime,
    fresh:
      latestCloseTime === null || options.maxDataAgeMs === undefined
        ? null
        : options.evaluationTime - latestCloseTime <= options.maxDataAgeMs,
  };
}

export function formatCandleIssues(issues: readonly CandleIssue[]): string {
  return issues.map((item) => `${item.code} at index ${item.index}: ${item.detail}`).join(' ');
}
