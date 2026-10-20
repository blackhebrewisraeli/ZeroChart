import {
  CANONICAL_MODEL_VERSION,
  scoreFactors,
  type CanonicalScore,
  type FactorInputs,
} from '@/lib/canonicalModel';

/** Oversold + bullish + quiet: the top of the scale (a BUY idea). */
export const STRONG_INPUTS: FactorInputs = {
  rsi: 25,
  momentumPercent: 0.02,
  volatilityPercent: 0.004,
};
/** Overbought + bearish + blown-out: the bottom of the scale (a SELL for holders). */
export const WEAK_INPUTS: FactorInputs = {
  rsi: 85,
  momentumPercent: -0.02,
  volatilityPercent: 0.08,
};

/** A canonical OK result for the given readings, at a $100 close with a $1 ATR. */
export function okResult(inputs: FactorInputs): CanonicalScore {
  return {
    status: 'OK',
    version: CANONICAL_MODEL_VERSION,
    close: 100,
    atr: 1,
    ...scoreFactors(inputs),
  };
}
