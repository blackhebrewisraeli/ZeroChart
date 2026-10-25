import { describe, expect, it } from 'vitest';
import referenceFixtures from '../../docs/quant-reference-fixtures.json';
import {
  classifyRegime,
  evaluateCandles,
  momentumFactorScore,
  rsiFactorScore,
  scoreFactors,
  volatilityFactorScore,
  type EngineCandle,
  type FactorInputs,
} from '@/lib/canonicalModel';
import { atr, macd, rsi } from '@/lib/indicators';
import {
  allocateScoreCandidates,
  qualifiesForRiskProfile,
  selectPortfolioCandidates,
} from '@/lib/portfolioBuilder';

const tolerance = referenceFixtures.provenance.tolerances;

function expectReference(actual: number, expected: number): void {
  const error = Math.abs(actual - expected);
  const allowed = Math.max(tolerance.absoluteFloor, Math.abs(expected) * tolerance.relative);
  expect(error, `expected ${actual} to be within ${allowed} of ${expected}`).toBeLessThanOrEqual(
    allowed,
  );
}

function firstFinite(values: Float64Array): number {
  return Array.from(values).findIndex(Number.isFinite);
}

describe('independent indicator references', () => {
  for (const fixture of referenceFixtures.cases) {
    it(`matches the Decimal reference for ${fixture.name}`, () => {
      const rsiValues = rsi(fixture.closes, 14);
      const macdValues = macd(fixture.closes, 12, 26, 9);
      const atrValues = atr(fixture.highs, fixture.lows, fixture.closes, 14);
      const last = fixture.closes.length - 1;

      expect(firstFinite(rsiValues)).toBe(fixture.expected.firstRsiIndex);
      expect(firstFinite(macdValues.macd)).toBe(fixture.expected.firstMacdIndex);
      expect(firstFinite(macdValues.signal)).toBe(fixture.expected.firstSignalIndex);
      expect(firstFinite(macdValues.histogram)).toBe(fixture.expected.firstHistogramIndex);
      expect(firstFinite(atrValues)).toBe(fixture.expected.firstAtrIndex);

      expectReference(rsiValues[last]!, fixture.expected.last.rsi!);
      expectReference(macdValues.macd[last]!, fixture.expected.last.macd!);
      expectReference(macdValues.signal[last]!, fixture.expected.last.signal!);
      expectReference(macdValues.histogram[last]!, fixture.expected.last.histogram!);
      expectReference(atrValues[last]!, fixture.expected.last.atr!);
    });
  }

  it('pins the hand-derived gap and first-bar true ranges', () => {
    const example = referenceFixtures.handExamples.gapAtrPeriod2;
    const values = atr(example.highs, example.lows, example.closes, 2);
    expect(Array.from(values)).toEqual(example.expected.map((value) => value ?? Number.NaN));
  });

  it('keeps warm-up output undefined until each seed is complete', () => {
    const closes = Array.from({ length: 34 }, (_, index) => index + 1);
    const macdValues = macd(closes);
    expect(Number.isNaN(rsi(closes.slice(0, 14))[13]!)).toBe(true);
    expect(Number.isNaN(macdValues.histogram[32]!)).toBe(true);
    expect(macdValues.histogram[33]).toBe(0);
    expect(
      Number.isNaN(atr(closes.slice(0, 13), closes.slice(0, 13), closes.slice(0, 13))[12]!),
    ).toBe(true);
  });
});

describe('input-domain boundary', () => {
  const validCandles = (): EngineCandle[] =>
    referenceFixtures.cases[3]!.closes.map((close, index) => ({
      high: referenceFixtures.cases[3]!.highs[index]!,
      low: referenceFixtures.cases[3]!.lows[index]!,
      close,
    }));

  it.each([
    ['close NaN', { high: 10, low: 9, close: Number.NaN }],
    ['high infinity', { high: Number.POSITIVE_INFINITY, low: 9, close: 9.5 }],
    ['low NaN', { high: 10, low: Number.NaN, close: 9.5 }],
  ])('rejects a nonfinite last candle: %s', (_label, invalid) => {
    const candles = validCandles();
    candles[candles.length - 1] = invalid;
    expect(evaluateCandles(candles).status).toBe('INSUFFICIENT_DATA');
  });

  it('documents that structural OHLC validation is outside the pure model', () => {
    const inverted = validCandles();
    inverted[10] = { high: 90, low: 110, close: 100 };
    const closeOutsideRange = validCandles();
    closeOutsideRange[10] = { high: 101, low: 99, close: 120 };

    expect(evaluateCandles(inverted).status).toBe('OK');
    expect(evaluateCandles(closeOutsideRange).status).toBe('OK');
  });
});

describe('independently specified decision boundaries', () => {
  it.each<[FactorInputs, ReturnType<typeof classifyRegime>]>([
    [{ rsi: 50, momentumPercent: 0, volatilityPercent: 0.039999999 }, 'NEUTRAL'],
    [{ rsi: 50, momentumPercent: 0, volatilityPercent: 0.04 }, 'HIGH_VOLATILITY'],
    [{ rsi: 50, momentumPercent: 0.004999999, volatilityPercent: 0.02 }, 'NEUTRAL'],
    [{ rsi: 50, momentumPercent: 0.005, volatilityPercent: 0.02 }, 'TRENDING'],
    [{ rsi: 30.000001, momentumPercent: 0, volatilityPercent: 0.02 }, 'NEUTRAL'],
    [{ rsi: 30, momentumPercent: 0, volatilityPercent: 0.02 }, 'MEAN_REVERTING'],
    [{ rsi: 70, momentumPercent: 0, volatilityPercent: 0.02 }, 'MEAN_REVERTING'],
  ])('classifies %o as %s', (inputs, expected) => {
    expect(classifyRegime(inputs)).toBe(expected);
  });

  it('matches an arithmetic-only component and weighted-score derivation', () => {
    const inputs = { rsi: 45, momentumPercent: 0.002, volatilityPercent: 0.025 };
    // RSI: 95 + (55-95)*(15/20) = 65. Momentum: 50+50*(.002/.01) = 60.
    // Volatility: 100*(1-(.025-.005)/.05) = 60. Neutral weighted = 62.
    expect(rsiFactorScore(inputs.rsi)).toBe(65);
    expect(momentumFactorScore(inputs.momentumPercent)).toBe(60);
    expect(volatilityFactorScore(inputs.volatilityPercent)).toBeCloseTo(60, 12);
    expect(scoreFactors(inputs)).toMatchObject({ signal_score: 62, regime: 'NEUTRAL' });
  });

  it('uses JavaScript half-up-for-positive rounding at the final score only', () => {
    // Trending components: RSI 55, momentum 100, volatility 70 => 80.5 => 81.
    expect(
      scoreFactors({ rsi: 50, momentumPercent: 0.01, volatilityPercent: 0.02 }).signal_score,
    ).toBe(81);
  });

  it.each([
    ['conservative', 59, 50, 'NEUTRAL', false],
    ['conservative', 60, 50, 'NEUTRAL', true],
    ['conservative', 61, 50, 'NEUTRAL', true],
    ['moderate', 59, 50, 'HIGH_VOLATILITY', false],
    ['moderate', 60, 50, 'HIGH_VOLATILITY', true],
    ['aggressive', 70, 100, 'TRENDING', false],
    ['aggressive', 71, 50, 'TRENDING', false],
    ['aggressive', 71, 50.000001, 'TRENDING', true],
  ] as const)(
    '%s profile boundary: score=%s momentum=%s regime=%s => %s',
    (profile, signal_score, momentumScore, regime, expected) => {
      expect(
        qualifiesForRiskProfile(profile, {
          signal_score,
          regime,
          components: { momentumScore },
        }),
      ).toBe(expected);
    },
  );

  it('separates eligibility from selection and resolves score ties by ticker', () => {
    const eligible = [
      { ticker: 'ZZZ', score: 80 },
      { ticker: 'AAA', score: 80 },
      { ticker: 'MID', score: 70 },
    ];
    expect(selectPortfolioCandidates(eligible, 'aggressive', 2)).toEqual([
      { ticker: 'AAA', score: 80 },
      { ticker: 'ZZZ', score: 80 },
    ]);
  });

  it('caps each allocation independently and leaves the remainder as cash', () => {
    const allocations = allocateScoreCandidates(
      [
        { ticker: 'A', score: 90 },
        { ticker: 'B', score: 60 },
      ],
      'conservative',
      10_000,
    );
    expect(allocations).toEqual([
      { ticker: 'A', score: 90, weight: 0.1, allocatedAmount: 1000 },
      { ticker: 'B', score: 60, weight: 0.1, allocatedAmount: 1000 },
    ]);
    expect(1 - allocations.reduce((sum, item) => sum + item.weight, 0)).toBeCloseTo(0.8, 12);
  });
});
