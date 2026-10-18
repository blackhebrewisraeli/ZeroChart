import type { Asset } from '@/lib/assets';
import type { MarketRegime } from '@/lib/multiFactor';
import type { Position } from '@/lib/portfolioAccounting';
import { scoreAssetStatic } from '@/lib/roboAdvisor';

/**
 * Active Research Lab signal advisor (M2-T2): tactical, alpha-seeking ideas
 * from the Multi-Factor engine (RSI · momentum · volatility regime). Core
 * Portfolio never calls this — its trades come from `rebalance.ts`.
 */

export interface TacticalSignal {
  type: 'BUY' | 'SELL';
  ticker: string;
  score: number;
  regime: MarketRegime;
  rationale: string;
}

const SELL_BELOW = 50;
const BUY_AT = 85;

/** Multi-Factor score, or null when the asset has no factor data (no signal, never a SELL). */
function breakdownOf(asset: Asset) {
  const { breakdown } = scoreAssetStatic(asset);
  const { rsiScore, momentumScore, volatilityScore } = breakdown.components;
  return rsiScore === null && momentumScore === null && volatilityScore === null ? null : breakdown;
}

/**
 * - SELL: a held asset whose Multi-Factor score is below 50.
 * - BUY: a non-held asset scoring 85+ while the ledger has cash to deploy.
 */
export function generateTacticalSignals(
  positions: readonly Position[],
  assets: readonly Asset[],
  availableCash: number,
): TacticalSignal[] {
  const held = new Set(positions.map((position) => position.ticker.toUpperCase()));
  const signals: TacticalSignal[] = [];
  const seen = new Set<string>();

  for (const asset of assets) {
    const ticker = asset.ticker.toUpperCase();
    if (seen.has(ticker)) continue;
    seen.add(ticker);
    const isHeld = held.has(ticker);
    if (!isHeld && availableCash <= 0) continue;
    const breakdown = breakdownOf(asset);
    if (!breakdown) continue;
    const { score, regime, rationale } = breakdown;
    const base = { ticker: asset.ticker, score, regime, rationale };
    if (isHeld && score < SELL_BELOW) signals.push({ type: 'SELL', ...base });
    else if (!isHeld && score >= BUY_AT) signals.push({ type: 'BUY', ...base });
  }

  return signals.sort((a, b) =>
    a.type === b.type ? b.score - a.score : a.type === 'SELL' ? -1 : 1,
  );
}
