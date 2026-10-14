import { calculateSignalScore, type Asset } from '@/lib/assets';

export interface Position {
  id: string;
  ticker: string;
  buyPrice: number;
  shares: number;
  isSimulation: boolean;
  dateAdded: string;
}

export interface PortfolioStats {
  totalValue: number;
  totalInvested: number;
  unrealizedPnL: number;
  pnlPercent: number;
  healthScore: number;
}

export interface Suggestion {
  type: 'BUY' | 'SELL';
  ticker: string;
  reason: string;
  score: number;
}

/**
 * Calculates portfolio-level statistics by mapping each position to its live
 * market price. Positions without a valid live price fall back to their buy
 * price so they never report phantom profit or loss. `healthScore` is the
 * market-value-weighted average Signal Score of the held assets we can resolve
 * to live data.
 */
export function calculatePortfolioStats(
  positions: Position[],
  liveAssets: Asset[],
): PortfolioStats {
  const priceByTicker = new Map<string, number>();
  const assetByTicker = new Map<string, Asset>();
  for (const asset of liveAssets) {
    assetByTicker.set(asset.ticker, asset);
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

    const asset = assetByTicker.get(position.ticker);
    if (asset) {
      const score = calculateSignalScore(asset);
      weightedScoreSum += score * currentValue;
      scoreWeightSum += currentValue;
    }
  }

  const unrealizedPnL = totalValue - totalInvested;
  const pnlPercent = totalInvested > 0 ? (unrealizedPnL / totalInvested) * 100 : 0;
  const healthScore = scoreWeightSum > 0 ? weightedScoreSum / scoreWeightSum : 0;

  return { totalValue, totalInvested, unrealizedPnL, pnlPercent, healthScore };
}

/**
 * Produces rebalancing suggestions from the live signal landscape.
 * - SELL: a held asset whose Signal Score has fallen below 50.
 * - BUY: a non-held asset scoring 85+ while there is cash to deploy.
 */
export function generateSuggestions(
  positions: Position[],
  liveAssets: Asset[],
  availableCash: number,
): Suggestion[] {
  const suggestions: Suggestion[] = [];
  const heldTickers = new Set(positions.map((position) => position.ticker));

  const flaggedForSell = new Set<string>();
  for (const position of positions) {
    if (flaggedForSell.has(position.ticker)) continue;
    const asset = liveAssets.find((candidate) => candidate.ticker === position.ticker);
    if (!asset) continue;
    const score = calculateSignalScore(asset);
    if (score < 50) {
      flaggedForSell.add(position.ticker);
      suggestions.push({
        type: 'SELL',
        ticker: position.ticker,
        reason: `Signal score dropped to ${score} (below 50) — consider cutting losses or taking profits.`,
        score,
      });
    }
  }

  if (availableCash > 0) {
    const flaggedForBuy = new Set<string>();
    for (const asset of liveAssets) {
      if (heldTickers.has(asset.ticker) || flaggedForBuy.has(asset.ticker)) continue;
      const score = calculateSignalScore(asset);
      if (score >= 85) {
        flaggedForBuy.add(asset.ticker);
        suggestions.push({
          type: 'BUY',
          ticker: asset.ticker,
          reason: `Strong signal score of ${score} with cash available — consider adding a position.`,
          score,
        });
      }
    }
  }

  return suggestions;
}
