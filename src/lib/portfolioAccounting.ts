export type PortfolioType = 'real_tracking' | 'long_term_sim' | 'paper_trading';

export const LEDGER_NAMES: Record<PortfolioType, string> = {
  long_term_sim: 'Simulation',
  real_tracking: 'Live Tracking',
  paper_trading: 'Paper Trading',
};

/**
 * The ledger fills book into and the Core dashboard shows for the active
 * selection. Paper Trading has no workspace until M2-T3, so a saved
 * `paper_trading` selection maps to Simulation everywhere alike.
 */
export function activeLedgerType(active: PortfolioType): 'real_tracking' | 'long_term_sim' {
  return active === 'real_tracking' ? 'real_tracking' : 'long_term_sim';
}

/** Why a trade was placed: a Core rebalance or an Active Research Lab tactical trade. */
export type TradeIntent = 'rebalance' | 'tactical';

export interface PositionLot {
  id: string;
  shares: number;
  /** Execution price per share, excluding acquisition costs. */
  buyPrice: number;
  /**
   * Acquisition costs (fee + slippage) still attached to this lot. Part of
   * its cost basis; allocated pro rata when the lot is partially sold.
   */
  feePaid?: number;
  acquiredAt: string;
}

/**
 * Compatibility position shared by the legacy UI and the v3 accounting
 * model. `isSimulation` is the established ZeroChart field;
 * `isSimulated` is accepted as a migration alias for older/external payloads.
 */
export interface Position {
  id: string;
  ticker: string;
  name?: string;
  buyPrice: number;
  shares: number;
  isSimulation: boolean;
  isSimulated?: boolean;
  dateAdded: string;
  lots?: PositionLot[];
  targetWeight?: number;
}

export interface CashTransaction {
  id: string;
  type: 'deposit' | 'withdrawal';
  /** Positive USD amount. */
  amount: number;
  createdAt: string;
}

export interface PortfolioTransaction {
  id: string;
  portfolioType: PortfolioType;
  type: 'deposit' | 'withdrawal' | 'buy' | 'sell';
  ticker?: string;
  shares?: number;
  price?: number;
  fee?: number;
  slippage?: number;
  amount: number;
  realizedPnl?: number;
  timestamp: string;
  note?: string;
  intent?: TradeIntent;
}

export interface PortfolioContainer {
  type: PortfolioType;
  positions: Position[];
  cashBalance: number;
  cashLedger: CashTransaction[];
  transactions: PortfolioTransaction[];
  realizedPnl: number;
  targetAllocations?: Record<string, number>;
}

export interface BuyTransactionInput {
  ticker: string;
  name?: string;
  shares: number;
  price: number;
  fee?: number;
  slippage?: number;
  timestamp?: string;
  transactionId?: string;
  lotId?: string;
  positionId?: string;
  requireCash?: boolean;
  intent?: TradeIntent;
}

export interface SellTransactionInput {
  ticker: string;
  shares: number;
  price: number;
  fee?: number;
  slippage?: number;
  timestamp?: string;
  transactionId?: string;
  creditCash?: boolean;
  intent?: TradeIntent;
}

export type BuyTransactionResult =
  | {
      ok: true;
      container: PortfolioContainer;
      position: Position;
      transaction: PortfolioTransaction;
    }
  | { ok: false; container: PortfolioContainer; error: string };

export interface CashTransactionInput {
  type: CashTransaction['type'];
  amount: number;
  note?: string;
  timestamp?: string;
  cashTransactionId?: string;
  transactionId?: string;
}

/** Any engine step: the next container, or why nothing changed. */
export type PortfolioTransition =
  { ok: true; container: PortfolioContainer } | { ok: false; error: string };

export type SellTransactionResult =
  | {
      ok: true;
      container: PortfolioContainer;
      realizedPnl: number;
      costBasisSold: number;
      transaction: PortfolioTransaction;
    }
  | { ok: false; container: PortfolioContainer; error: string };

export interface PortfolioValuation {
  investedCostBasis: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  realizedPnl: number;
  cashBalance: number;
  totalEquity: number;
  missingPriceCount: number;
}

const DEFAULT_TIMESTAMP = '1970-01-01T00:00:00.000Z';
const ZERO_SHARE_EPSILON = 1e-9;

function normalizeTicker(ticker: string): string {
  return ticker.trim().toUpperCase();
}

function deterministicId(
  prefix: string,
  ticker: string,
  timestamp: string,
  sequence: number,
): string {
  const safeTimestamp = timestamp.replace(/[^0-9A-Za-z]/g, '').toLowerCase();
  return `${prefix}-${ticker.toLowerCase()}-${safeTimestamp}-${sequence}`;
}

function weightedAverageBuyPrice(lots: PositionLot[]): number {
  const totalShares = lots.reduce((sum, lot) => sum + lot.shares, 0);
  if (totalShares <= ZERO_SHARE_EPSILON) return 0;
  return lots.reduce((sum, lot) => sum + lot.shares * lot.buyPrice, 0) / totalShares;
}

function lotCostBasis(lot: PositionLot): number {
  return lot.shares * lot.buyPrice + (lot.feePaid ?? 0);
}

/** What the open lots cost, acquisition fees and slippage included. */
export function positionCostBasis(position: Position): number {
  return (normalizePositionLots(position).lots ?? []).reduce(
    (sum, lot) => sum + lotCostBasis(lot),
    0,
  );
}

/** Creates a canonical lot representation without mutating the input. */
export function normalizePositionLots(position: Position): Position {
  const ticker = normalizeTicker(position.ticker);
  const existingLots = position.lots?.filter(
    (lot) => Number.isFinite(lot.shares) && lot.shares > ZERO_SHARE_EPSILON,
  );
  const lots: PositionLot[] =
    existingLots && existingLots.length > 0
      ? existingLots.map((lot) => ({ ...lot }))
      : position.shares > ZERO_SHARE_EPSILON
        ? [
            {
              id: `${position.id}-opening-lot`,
              shares: position.shares,
              buyPrice: position.buyPrice,
              acquiredAt: position.dateAdded,
            },
          ]
        : [];
  const shares = lots.reduce((sum, lot) => sum + lot.shares, 0);

  return {
    ...position,
    ticker,
    shares,
    buyPrice: weightedAverageBuyPrice(lots),
    lots,
  };
}

/**
 * Folds rows that share a ticker into one position, keeping every lot. The
 * engine trades by ticker, so engine-driven containers need one row each;
 * older Robo-Advisor invests appended a new row per run.
 */
export function mergeDuplicateTickers(positions: Position[]): Position[] {
  const merged = new Map<string, Position>();
  for (const raw of positions) {
    const position = normalizePositionLots(raw);
    const existing = merged.get(position.ticker);
    merged.set(
      position.ticker,
      existing
        ? normalizePositionLots({
            ...existing,
            lots: [...(existing.lots ?? []), ...(position.lots ?? [])],
          })
        : position,
    );
  }
  return [...merged.values()];
}

/** Applies a deposit or withdrawal; the balance is kept in whole cents. */
export function applyCashTransaction(
  container: PortfolioContainer,
  input: CashTransactionInput,
):
  | { ok: true; container: PortfolioContainer }
  | { ok: false; container: PortfolioContainer; error: string } {
  const { type, amount } = input;
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, container, error: 'Amount must be greater than zero' };
  }
  if (type === 'withdrawal' && amount > container.cashBalance) {
    return { ok: false, container, error: 'Insufficient cash' };
  }

  const timestamp = input.timestamp ?? DEFAULT_TIMESTAMP;
  const nextBalance =
    type === 'deposit' ? container.cashBalance + amount : container.cashBalance - amount;
  const cashTransaction: CashTransaction = {
    id:
      input.cashTransactionId ??
      deterministicId(type, 'cash', timestamp, container.cashLedger.length),
    type,
    amount,
    createdAt: timestamp,
  };
  const transaction: PortfolioTransaction = {
    id:
      input.transactionId ??
      deterministicId(`portfolio-${type}`, 'cash', timestamp, container.transactions.length),
    portfolioType: container.type,
    type,
    amount,
    timestamp,
    ...(input.note !== undefined ? { note: input.note } : {}),
  };
  return {
    ok: true,
    container: {
      ...container,
      cashBalance: Number(nextBalance.toFixed(2)),
      cashLedger: [...container.cashLedger, cashTransaction],
      transactions: [...container.transactions, transaction],
    },
  };
}

function validateTradeInput(
  ticker: string,
  shares: number,
  price: number,
  fee: number,
  slippage: number,
): string | null {
  if (normalizeTicker(ticker).length === 0) return 'Ticker is required';
  if (!Number.isFinite(shares) || shares <= 0) return 'Shares must be greater than zero';
  if (!Number.isFinite(price) || price <= 0) return 'Price must be greater than zero';
  if (!Number.isFinite(fee) || fee < 0) return 'Fee cannot be negative';
  if (!Number.isFinite(slippage) || slippage < 0) return 'Slippage cannot be negative';
  return null;
}

/** Applies a buy as an immutable, deterministic state transition. */
export function applyBuyTransaction(
  container: PortfolioContainer,
  input: BuyTransactionInput,
): BuyTransactionResult {
  const ticker = normalizeTicker(input.ticker);
  const fee = input.fee ?? 0;
  const slippage = input.slippage ?? 0;
  const validationError = validateTradeInput(ticker, input.shares, input.price, fee, slippage);
  if (validationError) return { ok: false, container, error: validationError };

  const totalCost = input.shares * input.price + fee + slippage;
  const requireCash = input.requireCash ?? container.type !== 'real_tracking';
  if (requireCash && totalCost > container.cashBalance) {
    return { ok: false, container, error: 'Insufficient cash' };
  }

  const timestamp = input.timestamp ?? DEFAULT_TIMESTAMP;
  const existingIndex = container.positions.findIndex(
    (position) => normalizeTicker(position.ticker) === ticker,
  );
  const existing = existingIndex >= 0 ? container.positions[existingIndex] : undefined;
  const normalizedExisting = existing ? normalizePositionLots(existing) : undefined;
  const lot: PositionLot = {
    id:
      input.lotId ??
      deterministicId('lot', ticker, timestamp, normalizedExisting?.lots?.length ?? 0),
    shares: input.shares,
    buyPrice: input.price,
    ...(fee + slippage > 0 ? { feePaid: fee + slippage } : {}),
    acquiredAt: timestamp,
  };
  const lots = [...(normalizedExisting?.lots ?? []), lot];
  const position: Position = normalizedExisting
    ? {
        ...normalizedExisting,
        ...(input.name !== undefined ? { name: input.name } : {}),
        shares: lots.reduce((sum, current) => sum + current.shares, 0),
        buyPrice: weightedAverageBuyPrice(lots),
        lots,
      }
    : {
        id: input.positionId ?? `position-${ticker.toLowerCase()}`,
        ticker,
        ...(input.name !== undefined ? { name: input.name } : {}),
        shares: input.shares,
        buyPrice: input.price,
        isSimulation: container.type !== 'real_tracking',
        dateAdded: timestamp,
        lots,
      };

  const positions = [...container.positions];
  if (existingIndex >= 0) positions[existingIndex] = position;
  else positions.push(position);

  const transaction: PortfolioTransaction = {
    id:
      input.transactionId ??
      deterministicId('buy', ticker, timestamp, container.transactions.length),
    portfolioType: container.type,
    type: 'buy',
    ticker,
    shares: input.shares,
    price: input.price,
    ...(input.fee !== undefined ? { fee } : {}),
    ...(input.slippage !== undefined ? { slippage } : {}),
    amount: totalCost,
    timestamp,
    ...(input.intent ? { intent: input.intent } : {}),
  };

  return {
    ok: true,
    position,
    transaction,
    container: {
      ...container,
      positions,
      cashBalance: requireCash ? container.cashBalance - totalCost : container.cashBalance,
      transactions: [...container.transactions, transaction],
    },
  };
}

/** Applies a sell using stable acquired-date FIFO lot consumption. */
export function applySellTransaction(
  container: PortfolioContainer,
  input: SellTransactionInput,
): SellTransactionResult {
  const ticker = normalizeTicker(input.ticker);
  const fee = input.fee ?? 0;
  const slippage = input.slippage ?? 0;
  const validationError = validateTradeInput(ticker, input.shares, input.price, fee, slippage);
  if (validationError) return { ok: false, container, error: validationError };

  const positionIndex = container.positions.findIndex(
    (position) => normalizeTicker(position.ticker) === ticker,
  );
  const position = positionIndex >= 0 ? container.positions[positionIndex] : undefined;
  if (!position) return { ok: false, container, error: 'Position not found' };

  const normalized = normalizePositionLots(position);
  if (input.shares - normalized.shares > ZERO_SHARE_EPSILON) {
    return { ok: false, container, error: 'Insufficient shares' };
  }

  const orderedLots = (normalized.lots ?? [])
    .map((lot, index) => ({ lot, index }))
    .sort((left, right) => {
      const dateOrder = left.lot.acquiredAt.localeCompare(right.lot.acquiredAt);
      return dateOrder !== 0 ? dateOrder : left.index - right.index;
    });
  let sharesToSell = input.shares;
  let costBasisSold = 0;
  const remainingLots: PositionLot[] = [];

  for (const { lot } of orderedLots) {
    const consumed = Math.min(lot.shares, sharesToSell);
    const feeSold = lot.feePaid ? (lot.feePaid * consumed) / lot.shares : 0;
    costBasisSold += consumed * lot.buyPrice + feeSold;
    sharesToSell -= consumed;
    const remainingShares = lot.shares - consumed;
    if (remainingShares > ZERO_SHARE_EPSILON) {
      remainingLots.push({
        ...lot,
        shares: remainingShares,
        ...(lot.feePaid ? { feePaid: lot.feePaid - feeSold } : {}),
      });
    }
  }

  const netProceeds = input.shares * input.price - fee - slippage;
  const realizedPnl = netProceeds - costBasisSold;
  const remainingShares = remainingLots.reduce((sum, lot) => sum + lot.shares, 0);
  const positions = [...container.positions];
  if (remainingShares <= ZERO_SHARE_EPSILON) {
    positions.splice(positionIndex, 1);
  } else {
    positions[positionIndex] = {
      ...normalized,
      shares: remainingShares,
      buyPrice: weightedAverageBuyPrice(remainingLots),
      lots: remainingLots,
    };
  }

  const timestamp = input.timestamp ?? DEFAULT_TIMESTAMP;
  const transaction: PortfolioTransaction = {
    id:
      input.transactionId ??
      deterministicId('sell', ticker, timestamp, container.transactions.length),
    portfolioType: container.type,
    type: 'sell',
    ticker,
    shares: input.shares,
    price: input.price,
    ...(input.fee !== undefined ? { fee } : {}),
    ...(input.slippage !== undefined ? { slippage } : {}),
    amount: netProceeds,
    realizedPnl,
    timestamp,
    ...(input.intent ? { intent: input.intent } : {}),
  };

  return {
    ok: true,
    realizedPnl,
    costBasisSold,
    transaction,
    container: {
      ...container,
      positions,
      cashBalance:
        input.creditCash === false ? container.cashBalance : container.cashBalance + netProceeds,
      transactions: [...container.transactions, transaction],
      realizedPnl: container.realizedPnl + realizedPnl,
    },
  };
}

export function computePortfolioValuation(
  container: PortfolioContainer,
  livePrices: Readonly<Record<string, number | null | undefined>>,
): PortfolioValuation {
  let investedCostBasis = 0;
  let marketValue = 0;
  let missingPriceCount = 0;

  for (const rawPosition of container.positions) {
    const position = normalizePositionLots(rawPosition);
    const costBasis = positionCostBasis(position);
    const livePrice = livePrices[normalizeTicker(position.ticker)];
    const hasLivePrice =
      typeof livePrice === 'number' && Number.isFinite(livePrice) && livePrice > 0;
    investedCostBasis += costBasis;
    marketValue += hasLivePrice ? livePrice * position.shares : costBasis;
    if (!hasLivePrice) missingPriceCount += 1;
  }

  const unrealizedPnl = marketValue - investedCostBasis;
  return {
    investedCostBasis,
    marketValue,
    unrealizedPnl,
    unrealizedPnlPct: investedCostBasis > 0 ? (unrealizedPnl / investedCostBasis) * 100 : 0,
    realizedPnl: container.realizedPnl,
    cashBalance: container.cashBalance,
    totalEquity: marketValue + container.cashBalance,
    missingPriceCount,
  };
}
