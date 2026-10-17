import type { Asset } from '@/lib/assets';
import { computeMultiFactorBreakdown, type MarketRegime } from '@/lib/multiFactor';
import type { Position } from '@/lib/portfolioManager';
import { supabase } from '@/lib/supabaseClient';
import type { Json } from '@/integrations/supabase/types';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Percentage-only by design: no field here may carry an absolute amount
// (balances, cost basis, P&L in dollars, share counts). Percentages are
// scale-invariant, so the portfolio's size cannot be recovered from them.
export interface SharedPortfolioHolding {
  ticker: string;
  name: string;
  allocationPercent: number;
  pnlPercent: number;
  quantScore: number;
  regime: MarketRegime;
}

export interface SharedPortfolioSnapshot {
  version: 2;
  createdAt: string;
  pnlPercent: number;
  quantScore: number;
  holdings: SharedPortfolioHolding[];
}

export interface SharedPortfolioRecord {
  id: string;
  createdAt: string;
  snapshot: SharedPortfolioSnapshot;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRegime(value: unknown): value is MarketRegime {
  return (
    value === 'TRENDING' ||
    value === 'MEAN_REVERTING' ||
    value === 'HIGH_VOLATILITY' ||
    value === 'NEUTRAL'
  );
}

export function createSharedPortfolioId(): string {
  return crypto.randomUUID();
}

/**
 * Creates an immutable, percentage-only public snapshot: allocation weights,
 * returns, and quant scores. Dollar values are used to compute the weights
 * and returns, then dropped — user identity, balances, cost basis, absolute
 * P&L, share counts, cash, and trades never leave the device.
 */
export function buildSharedPortfolioSnapshot(
  positions: Position[],
  assets: Asset[],
  createdAt = new Date().toISOString(),
): SharedPortfolioSnapshot {
  const assetByTicker = new Map(assets.map((asset) => [asset.ticker, asset]));
  const grouped = new Map<string, { value: number; invested: number }>();

  for (const position of positions) {
    const asset = assetByTicker.get(position.ticker);
    const livePrice = finiteOrNull(asset?.current_price);
    const currentPrice = livePrice !== null && livePrice > 0 ? livePrice : position.buyPrice;
    const value = currentPrice * position.shares;
    const invested = position.buyPrice * position.shares;
    const current = grouped.get(position.ticker) ?? { value: 0, invested: 0 };
    current.value += value;
    current.invested += invested;
    grouped.set(position.ticker, current);
  }

  const totalValue = [...grouped.values()].reduce((sum, holding) => sum + holding.value, 0);
  const totalInvested = [...grouped.values()].reduce((sum, holding) => sum + holding.invested, 0);

  const holdings = [...grouped.entries()]
    .map(([ticker, holding]): SharedPortfolioHolding => {
      const asset = assetByTicker.get(ticker);
      const breakdown = computeMultiFactorBreakdown({
        rsi: finiteOrNull(asset?.rsi_14),
        momentumPercent: finiteOrNull(asset?.change_24h),
        volatilityPercent: (() => {
          const risk = finiteOrNull(asset?.risk_pct);
          return risk === null ? null : Math.abs(risk);
        })(),
      });
      return {
        ticker: ticker.slice(0, 24),
        name: (asset?.name || ticker).slice(0, 120),
        allocationPercent: totalValue > 0 ? (holding.value / totalValue) * 100 : 0,
        pnlPercent:
          holding.invested > 0 ? ((holding.value - holding.invested) / holding.invested) * 100 : 0,
        quantScore: breakdown.score,
        regime: breakdown.regime,
      };
    })
    .sort((a, b) => b.allocationPercent - a.allocationPercent);

  const quantWeight = holdings.reduce((sum, holding) => sum + holding.allocationPercent, 0);
  const quantScore =
    quantWeight > 0
      ? holdings.reduce((sum, holding) => sum + holding.quantScore * holding.allocationPercent, 0) /
        quantWeight
      : 0;

  return {
    version: 2,
    createdAt,
    pnlPercent: totalInvested > 0 ? ((totalValue - totalInvested) / totalInvested) * 100 : 0,
    quantScore,
    holdings,
  };
}

export async function publishSharedPortfolio({
  id,
  userId,
  snapshot,
}: {
  id: string;
  userId: string;
  snapshot: SharedPortfolioSnapshot;
}): Promise<void> {
  const { error } = await supabase.from('shared_portfolios').insert({
    id,
    user_id: userId,
    snapshot: snapshot as unknown as Json,
  });

  if (error) throw error;
}

/**
 * Validates a stored snapshot and rebuilds it from whitelisted fields only, so
 * nothing outside the percentage-only contract (e.g. an injected dollar field)
 * can reach the public view.
 */
export function parseSharedPortfolioSnapshot(value: unknown): SharedPortfolioSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<SharedPortfolioSnapshot>;
  if (
    candidate.version !== 2 ||
    typeof candidate.createdAt !== 'string' ||
    !finite(candidate.pnlPercent) ||
    !finite(candidate.quantScore) ||
    !Array.isArray(candidate.holdings)
  ) {
    return null;
  }

  const holdings: SharedPortfolioHolding[] = [];
  for (const value of candidate.holdings) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const holding = value as Partial<SharedPortfolioHolding>;
    if (
      typeof holding.ticker !== 'string' ||
      holding.ticker.length === 0 ||
      holding.ticker.length > 24 ||
      typeof holding.name !== 'string' ||
      holding.name.length > 120 ||
      !finite(holding.allocationPercent) ||
      !finite(holding.pnlPercent) ||
      !finite(holding.quantScore) ||
      !isRegime(holding.regime)
    ) {
      return null;
    }
    holdings.push({
      ticker: holding.ticker,
      name: holding.name,
      allocationPercent: holding.allocationPercent,
      pnlPercent: holding.pnlPercent,
      quantScore: holding.quantScore,
      regime: holding.regime,
    });
  }

  return {
    version: 2,
    createdAt: candidate.createdAt,
    pnlPercent: candidate.pnlPercent,
    quantScore: candidate.quantScore,
    holdings,
  };
}

export async function fetchSharedPortfolio(id: string): Promise<SharedPortfolioRecord | null> {
  if (!UUID_PATTERN.test(id)) return null;

  // The table has no public SELECT (that would make every link listable);
  // this RPC returns one snapshot by id only.
  const { data, error } = await supabase
    .rpc('get_shared_portfolio', { share_id: id })
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const snapshot = parseSharedPortfolioSnapshot(data.snapshot);
  if (!snapshot) throw new Error('The shared portfolio snapshot is invalid.');

  return { id: data.id, createdAt: data.created_at, snapshot };
}
