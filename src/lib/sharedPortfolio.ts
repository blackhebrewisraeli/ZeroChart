import type { Asset } from '@/lib/assets';
import { computeBacktest, deriveWeights, type AssetPriceSeries } from '@/lib/backtestManager';
import { fetchHistoricalKlines, isBinanceCrypto } from '@/lib/binance';
import { computeMultiFactorBreakdown, type MarketRegime } from '@/lib/multiFactor';
import type { Position } from '@/lib/portfolioManager';
import { supabase } from '@/lib/supabaseClient';
import type { Json } from '@/integrations/supabase/types';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Market benchmark for shared-portfolio alpha (buy-and-hold over the same window). */
const SHARED_BENCHMARK_TICKER = 'BTC';
const MAX_LOOKBACK_DAYS = 365;
const DAY_MS = 86_400_000;

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

export interface SharedPortfolioRisk {
  /** Peak-to-trough decline (0–100) of the allocation-weighted curve over the lookback. */
  maxDrawdownPercent: number | null;
  /** Lookback return minus BTC buy-and-hold over the same window, in percentage points. */
  alphaPercent: number | null;
}

export interface SharedPortfolioSnapshot extends SharedPortfolioRisk {
  version: 3;
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

const NO_RISK: SharedPortfolioRisk = { maxDrawdownPercent: null, alphaPercent: null };

async function fetchDailySeries(ticker: string, days: number): Promise<AssetPriceSeries> {
  const klines = await fetchHistoricalKlines(ticker, '1d', days);
  return {
    ticker,
    points: klines.map((kline) => ({ timestamp: kline.timestamp, price: kline.close })),
  };
}

/**
 * Replays the current allocation over daily history since the earliest
 * position (capped at a year) with the backtest engine, and reports its max
 * drawdown and its return in excess of BTC buy-and-hold. Any missing history
 * yields nulls rather than a curve diluted by a cash sleeve, and a failed
 * fetch never blocks the share.
 */
async function computeSharedPortfolioRisk(
  positions: Position[],
  assets: Asset[],
  createdAt: string,
): Promise<SharedPortfolioRisk> {
  const weights = deriveWeights(positions, assets);
  if (weights.length === 0 || !weights.every((item) => isBinanceCrypto(item.ticker))) {
    return NO_RISK;
  }

  const start = Math.min(
    ...positions.map((position) => Date.parse(position.dateAdded)).filter(Number.isFinite),
  );
  const elapsedDays = Math.ceil((Date.parse(createdAt) - start) / DAY_MS) + 1;
  const days = Number.isFinite(elapsedDays)
    ? Math.min(MAX_LOOKBACK_DAYS, Math.max(2, elapsedDays))
    : MAX_LOOKBACK_DAYS;

  try {
    const [series, benchmarkSeries] = await Promise.all([
      Promise.all(weights.map((item) => fetchDailySeries(item.ticker, days))),
      // A missing benchmark only costs alpha; drawdown stands on its own.
      fetchDailySeries(SHARED_BENCHMARK_TICKER, days).catch((): AssetPriceSeries => ({
        ticker: SHARED_BENCHMARK_TICKER,
        points: [],
      })),
    ]);
    const portfolio = computeBacktest({ weights, series });
    if (portfolio.coverage.some((entry) => entry.status === 'missing')) return NO_RISK;

    // Same window: holdings listed after the lookback start shorten the curve.
    const first = portfolio.points[0]?.timestamp ?? Number.POSITIVE_INFINITY;
    const last = portfolio.points.at(-1)?.timestamp ?? Number.NEGATIVE_INFINITY;
    const benchmark = computeBacktest({
      weights: [{ ticker: SHARED_BENCHMARK_TICKER, weight: 1 }],
      series: [
        {
          ticker: SHARED_BENCHMARK_TICKER,
          points: benchmarkSeries.points.filter(
            (point) => point.timestamp >= first && point.timestamp <= last,
          ),
        },
      ],
    });
    return {
      maxDrawdownPercent: portfolio.maxDrawdownPercent,
      alphaPercent:
        benchmark.coverageWeight > 0
          ? portfolio.totalReturnPercent - benchmark.totalReturnPercent
          : null,
    };
  } catch {
    return NO_RISK;
  }
}

/**
 * Creates an immutable, percentage-only public snapshot: allocation weights,
 * returns, max drawdown, alpha, and quant scores. Dollar values are used to
 * compute the weights and returns, then dropped — user identity, balances,
 * cost basis, absolute P&L, share counts, cash, and trades never leave the
 * device.
 */
export async function buildSharedPortfolioSnapshot(
  positions: Position[],
  assets: Asset[],
  createdAt = new Date().toISOString(),
): Promise<SharedPortfolioSnapshot> {
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
    version: 3,
    createdAt,
    pnlPercent: totalInvested > 0 ? ((totalValue - totalInvested) / totalInvested) * 100 : 0,
    quantScore,
    ...(await computeSharedPortfolioRisk(positions, assets, createdAt)),
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
 * can reach the public view. Version 2 snapshots predate drawdown and alpha
 * and read back as version 3 with those fields null.
 */
export function parseSharedPortfolioSnapshot(value: unknown): SharedPortfolioSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<Omit<SharedPortfolioSnapshot, 'version'>> & {
    version?: unknown;
  };
  if (
    (candidate.version !== 2 && candidate.version !== 3) ||
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
    version: 3,
    createdAt: candidate.createdAt,
    pnlPercent: candidate.pnlPercent,
    quantScore: candidate.quantScore,
    maxDrawdownPercent: finiteOrNull(candidate.maxDrawdownPercent),
    alphaPercent: finiteOrNull(candidate.alphaPercent),
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
