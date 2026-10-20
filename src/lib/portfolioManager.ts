import type { Asset } from '@/lib/assets';
import { scoreOf, type CanonicalResult } from '@/lib/canonicalModel';
import type { Position } from '@/lib/portfolioAccounting';

export type { Position } from '@/lib/portfolioAccounting';

export interface PortfolioStats {
  totalValue: number;
  totalInvested: number;
  unrealizedPnL: number;
  pnlPercent: number;
  /** Value-weighted canonical Signal Score; null when no holding has one. */
  healthScore: number | null;
}

/**
 * Calculates portfolio-level statistics by mapping each position to its live
 * market price. Positions without a valid live price fall back to their buy
 * price so they never report phantom profit or loss. `healthScore` is the
 * market-value-weighted average canonical Signal Score of the holdings the
 * engine could score; holdings without enough data are left out, not zeroed.
 */
export function calculatePortfolioStats(
  positions: Position[],
  liveAssets: Asset[],
  scores: ReadonlyMap<string, CanonicalResult>,
): PortfolioStats {
  const priceByTicker = new Map<string, number>();
  for (const asset of liveAssets) {
    if (
      asset.current_price !== null &&
      Number.isFinite(asset.current_price) &&
      asset.current_price > 0
    ) {
      priceByTicker.set(asset.ticker, asset.current_price);
    }
  }

  let totalInvested = 0;
  let totalValue = 0;
  let weightedScoreSum = 0;
  let scoreWeightSum = 0;

  for (const position of positions) {
    const invested = position.buyPrice * position.shares;
    const livePrice = priceByTicker.get(position.ticker);
    const currentPrice = livePrice !== undefined ? livePrice : position.buyPrice;
    const currentValue = currentPrice * position.shares;

    totalInvested += invested;
    totalValue += currentValue;

    const score = scoreOf(scores.get(position.ticker));
    if (score !== null) {
      weightedScoreSum += score * currentValue;
      scoreWeightSum += currentValue;
    }
  }

  const unrealizedPnL = totalValue - totalInvested;
  const pnlPercent = totalInvested > 0 ? (unrealizedPnL / totalInvested) * 100 : 0;
  const healthScore = scoreWeightSum > 0 ? weightedScoreSum / scoreWeightSum : null;

  return { totalValue, totalInvested, unrealizedPnL, pnlPercent, healthScore };
}

export type RiskLabel = 'Conservative' | 'Moderate' | 'Aggressive';

/**
 * Derives a human-friendly risk label from the portfolio's value-weighted
 * average per-asset `risk_pct` (a 0–1 fraction surfaced by the data provider).
 * Boundaries are intentionally wide so the label stays stable as live prices
 * tick: below 4% reads as conservative, above 8% as aggressive, and everything
 * in between as moderate. Missing risk data falls back to moderate rather than
 * implying a false signal.
 */
export function deriveRiskLabel(weightedRiskPct: number | null): RiskLabel {
  if (weightedRiskPct === null || !Number.isFinite(weightedRiskPct)) return 'Moderate';
  if (weightedRiskPct < 0.04) return 'Conservative';
  if (weightedRiskPct > 0.08) return 'Aggressive';
  return 'Moderate';
}

/**
 * Builds a clean, shareable text summary of the current portfolio. Positions
 * are valued at their live price (falling back to buy price) and aggregated by
 * ticker, then sorted largest-first with whole-number percentage weights.
 */
export function generateShareText(positions: Position[], assets: Asset[]): string {
  const assetByTicker = new Map(assets.map((asset) => [asset.ticker, asset]));

  const valueByTicker = new Map<string, number>();
  let totalValue = 0;
  let weightedRiskSum = 0;
  let weightedRiskWeight = 0;

  for (const position of positions) {
    const asset = assetByTicker.get(position.ticker);
    const livePrice = asset?.current_price;
    const price =
      typeof livePrice === 'number' && Number.isFinite(livePrice) && livePrice > 0
        ? livePrice
        : position.buyPrice;
    const value = price * position.shares;

    valueByTicker.set(position.ticker, (valueByTicker.get(position.ticker) ?? 0) + value);
    totalValue += value;

    const risk = asset?.risk_pct;
    if (risk !== null && risk !== undefined && Number.isFinite(risk) && risk > 0) {
      weightedRiskSum += risk * value;
      weightedRiskWeight += value;
    }
  }

  const lines = ['My ZeroChart Portfolio 🚀'];
  lines.push(
    `Risk: ${deriveRiskLabel(weightedRiskWeight > 0 ? weightedRiskSum / weightedRiskWeight : null)}`,
  );

  const allocations = [...valueByTicker.entries()]
    .map(([ticker, value]) => ({ ticker, value }))
    .sort((a, b) => b.value - a.value);

  if (allocations.length === 0) {
    lines.push('• No positions yet');
  } else {
    for (const { ticker, value } of allocations) {
      const percent = totalValue > 0 ? Math.round((value / totalValue) * 100) : 0;
      lines.push(`• ${percent}% ${ticker}`);
    }
  }

  lines.push('Simulated with ZeroChart.');

  return lines.join('\n');
}
