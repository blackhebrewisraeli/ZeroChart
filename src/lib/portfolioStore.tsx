import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  applyBuyTransaction,
  applyCashTransaction,
  applySellTransaction,
  mergeDuplicateTickers,
  normalizePositionLots,
  type BuyTransactionInput,
  type CashTransaction,
  type PortfolioContainer,
  type PortfolioTransaction,
  type PortfolioTransition,
  type PortfolioType,
  type Position,
  type SellTransactionInput,
} from '@/lib/portfolioAccounting';

export type {
  BuyTransactionInput,
  CashTransaction,
  PortfolioContainer,
  PortfolioTransaction,
  PortfolioTransition,
  PortfolioType,
  SellTransactionInput,
} from '@/lib/portfolioAccounting';

const GUEST_STORAGE_KEY = 'zerochart:portfolio-positions';

function userStorageKey(userId: string): string {
  return `zerochart:portfolio-positions:${userId}`;
}

function storageKeyFor(userId: string | null): string {
  return userId === null ? GUEST_STORAGE_KEY : userStorageKey(userId);
}

const MOCK_POSITIONS: Position[] = [
  {
    id: 'demo-nvda',
    ticker: 'NVDA',
    buyPrice: 108,
    shares: 10,
    isSimulation: false,
    dateAdded: '2026-09-02',
  },
  {
    id: 'demo-aapl',
    ticker: 'AAPL',
    buyPrice: 252,
    shares: 4,
    isSimulation: false,
    dateAdded: '2026-09-18',
  },
];

const DEMO_OPENING_CASH = 2_500;
const INITIAL_PAPER_CASH = 10_000;

const SEED_CASH_LEDGER: CashTransaction[] = [
  {
    id: 'seed-opening-deposit',
    type: 'deposit',
    amount: DEMO_OPENING_CASH,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
];

const PAPER_CASH_LEDGER: CashTransaction[] = [
  {
    id: 'seed-paper-cash',
    type: 'deposit',
    amount: INITIAL_PAPER_CASH,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
];

export interface PortfolioStateV3 {
  version: 3;
  activePortfolioType: PortfolioType;
  portfolios: Record<PortfolioType, PortfolioContainer>;
}

export interface PortfolioStateV2 {
  version: 2;
  positions: Position[];
  cashBalance: number;
  cashLedger: CashTransaction[];
}

export type PortfolioPersistedState = Position[] | PortfolioStateV2 | PortfolioStateV3;

interface ScopedPortfolioState extends PortfolioStateV3 {
  userId: string | null;
}

function emptyContainer(type: PortfolioType): PortfolioContainer {
  return {
    type,
    positions: [],
    cashBalance: 0,
    cashLedger: [],
    transactions: [],
    realizedPnl: 0,
  };
}

function seedScope(): PortfolioStateV3 {
  return {
    version: 3,
    activePortfolioType: 'real_tracking',
    portfolios: {
      real_tracking: {
        type: 'real_tracking',
        positions: MOCK_POSITIONS.map(normalizePositionLots),
        cashBalance: DEMO_OPENING_CASH,
        cashLedger: SEED_CASH_LEDGER.map((transaction) => ({ ...transaction })),
        transactions: [],
        realizedPnl: 0,
      },
      long_term_sim: emptyContainer('long_term_sim'),
      paper_trading: {
        ...emptyContainer('paper_trading'),
        cashBalance: INITIAL_PAPER_CASH,
        cashLedger: PAPER_CASH_LEDGER.map((transaction) => ({ ...transaction })),
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPortfolioType(value: unknown): value is PortfolioType {
  return value === 'real_tracking' || value === 'long_term_sim' || value === 'paper_trading';
}

function normalizePersistedPosition(value: unknown): Position | null {
  if (!isRecord(value)) return null;
  if (
    typeof value['id'] !== 'string' ||
    typeof value['ticker'] !== 'string' ||
    typeof value['buyPrice'] !== 'number' ||
    !Number.isFinite(value['buyPrice']) ||
    typeof value['shares'] !== 'number' ||
    !Number.isFinite(value['shares']) ||
    typeof value['dateAdded'] !== 'string'
  ) {
    return null;
  }

  const isSimulation = value['isSimulated'] === true || value['isSimulation'] === true;
  return normalizePositionLots({
    ...(value as unknown as Position),
    isSimulation,
  });
}

function normalizePersistedPositions(value: unknown): Position[] {
  if (!Array.isArray(value)) return [];
  const positions: Position[] = [];
  for (const candidate of value) {
    const position = normalizePersistedPosition(candidate);
    if (position) positions.push(position);
  }
  return positions;
}

function normalizeCashLedger(value: unknown): CashTransaction[] {
  if (!Array.isArray(value)) return [];
  return value.filter((candidate): candidate is CashTransaction => {
    if (!isRecord(candidate)) return false;
    return (
      typeof candidate['id'] === 'string' &&
      (candidate['type'] === 'deposit' || candidate['type'] === 'withdrawal') &&
      typeof candidate['amount'] === 'number' &&
      Number.isFinite(candidate['amount']) &&
      candidate['amount'] > 0 &&
      typeof candidate['createdAt'] === 'string'
    );
  });
}

function normalizeTransactions(
  value: unknown,
  portfolioType: PortfolioType,
): PortfolioTransaction[] {
  if (!Array.isArray(value)) return [];
  const transactions: PortfolioTransaction[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    if (
      typeof candidate['id'] !== 'string' ||
      (candidate['type'] !== 'deposit' &&
        candidate['type'] !== 'withdrawal' &&
        candidate['type'] !== 'buy' &&
        candidate['type'] !== 'sell') ||
      typeof candidate['amount'] !== 'number' ||
      !Number.isFinite(candidate['amount']) ||
      typeof candidate['timestamp'] !== 'string'
    ) {
      continue;
    }
    transactions.push({
      ...(candidate as unknown as PortfolioTransaction),
      portfolioType,
    });
  }
  return transactions;
}

function normalizeTargetAllocations(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const targets: Record<string, number> = {};
  for (const [ticker, weight] of Object.entries(value)) {
    if (typeof weight === 'number' && Number.isFinite(weight) && weight >= 0) {
      targets[ticker.trim().toUpperCase()] = weight;
    }
  }
  return Object.keys(targets).length > 0 ? targets : undefined;
}

function normalizeContainer(
  value: unknown,
  type: PortfolioType,
  fallback: PortfolioContainer,
): PortfolioContainer {
  if (!isRecord(value)) return fallback;
  const targetAllocations = normalizeTargetAllocations(value['targetAllocations']);
  const positions = Array.isArray(value['positions'])
    ? normalizePersistedPositions(value['positions'])
    : fallback.positions;
  return {
    type,
    // Real-tracking rows are user-entered and closed by id; the others trade by ticker.
    positions: type === 'real_tracking' ? positions : mergeDuplicateTickers(positions),
    cashBalance:
      typeof value['cashBalance'] === 'number' && Number.isFinite(value['cashBalance'])
        ? value['cashBalance']
        : fallback.cashBalance,
    cashLedger: Array.isArray(value['cashLedger'])
      ? normalizeCashLedger(value['cashLedger'])
      : fallback.cashLedger,
    transactions: Array.isArray(value['transactions'])
      ? normalizeTransactions(value['transactions'], type)
      : fallback.transactions,
    realizedPnl:
      typeof value['realizedPnl'] === 'number' && Number.isFinite(value['realizedPnl'])
        ? value['realizedPnl']
        : fallback.realizedPnl,
    ...(targetAllocations ? { targetAllocations } : {}),
  };
}

function migrateLegacy(
  positionsValue: unknown,
  cashBalance: number,
  cashLedger: CashTransaction[],
): PortfolioStateV3 {
  const positions = normalizePersistedPositions(positionsValue);
  const realPositions: Position[] = [];
  const simulatedPositions: Position[] = [];
  for (const position of positions) {
    if (position.isSimulated === true || position.isSimulation) simulatedPositions.push(position);
    else realPositions.push(position);
  }

  const seeded = seedScope();
  return {
    version: 3,
    activePortfolioType: 'real_tracking',
    portfolios: {
      real_tracking: {
        ...emptyContainer('real_tracking'),
        positions: realPositions,
        cashBalance,
        cashLedger,
      },
      long_term_sim: {
        ...emptyContainer('long_term_sim'),
        positions: mergeDuplicateTickers(simulatedPositions),
      },
      paper_trading: seeded.portfolios.paper_trading,
    },
  };
}

/** Converts local/cloud v1, v2, or v3 JSON into the canonical v3 envelope. */
function migratePortfolioState(payload: unknown): PortfolioStateV3 {
  if (Array.isArray(payload)) {
    return migrateLegacy(
      payload,
      DEMO_OPENING_CASH,
      SEED_CASH_LEDGER.map((transaction) => ({ ...transaction })),
    );
  }
  if (!isRecord(payload)) return seedScope();

  if (payload['version'] === 3 && isRecord(payload['portfolios'])) {
    const persistedPortfolios = payload['portfolios'];
    const seeded = seedScope();
    return {
      version: 3,
      activePortfolioType: isPortfolioType(payload['activePortfolioType'])
        ? payload['activePortfolioType']
        : 'real_tracking',
      portfolios: {
        real_tracking: normalizeContainer(
          persistedPortfolios['real_tracking'],
          'real_tracking',
          seeded.portfolios.real_tracking,
        ),
        long_term_sim: normalizeContainer(
          persistedPortfolios['long_term_sim'],
          'long_term_sim',
          seeded.portfolios.long_term_sim,
        ),
        paper_trading: normalizeContainer(
          persistedPortfolios['paper_trading'],
          'paper_trading',
          seeded.portfolios.paper_trading,
        ),
      },
    };
  }

  if (Array.isArray(payload['positions'])) {
    const cashBalance =
      typeof payload['cashBalance'] === 'number' && Number.isFinite(payload['cashBalance'])
        ? payload['cashBalance']
        : DEMO_OPENING_CASH;
    const cashLedger = Array.isArray(payload['cashLedger'])
      ? normalizeCashLedger(payload['cashLedger'])
      : SEED_CASH_LEDGER.map((transaction) => ({ ...transaction }));
    return migrateLegacy(payload['positions'], cashBalance, cashLedger);
  }

  return seedScope();
}

function readScopeState(userId: string | null): PortfolioStateV3 {
  if (typeof window === 'undefined') return seedScope();
  try {
    const raw = window.localStorage.getItem(storageKeyFor(userId));
    if (!raw) return seedScope();
    return migratePortfolioState(JSON.parse(raw) as unknown);
  } catch {
    return seedScope();
  }
}

function persistScopeState(userId: string | null, state: PortfolioStateV3): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      storageKeyFor(userId),
      JSON.stringify({
        version: 3,
        activePortfolioType: state.activePortfolioType,
        portfolios: state.portfolios,
      } satisfies PortfolioStateV3),
    );
  } catch {
    // Ignore quota/private-mode errors; in-memory state remains authoritative.
  }
}

let transactionSequence = 0;

function nextTransactionId(prefix: string): string {
  transactionSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${transactionSequence.toString(36)}`;
}

function replaceContainer(
  state: ScopedPortfolioState,
  type: PortfolioType,
  container: PortfolioContainer,
): ScopedPortfolioState {
  return {
    ...state,
    portfolios: {
      ...state.portfolios,
      [type]: container,
    },
  };
}

interface PortfolioStore {
  positions: Position[];
  scopeUserId: string | null;
  cashBalance: number;
  cashLedger: CashTransaction[];
  activePortfolioType: PortfolioType;
  portfolios: Record<PortfolioType, PortfolioContainer>;
  setActivePortfolioType: (type: PortfolioType) => void;
  getPortfolio: (type: PortfolioType) => PortfolioContainer;
  executeBuy: (type: PortfolioType, input: BuyTransactionInput) => { ok: boolean; error?: string };
  executeSell: (
    type: PortfolioType,
    input: SellTransactionInput,
  ) => { ok: boolean; realizedPnl?: number; error?: string };
  depositPortfolioCash: (type: PortfolioType, amount: number, note?: string) => boolean;
  /** Commits every step `build` applies to the container, or none of them. */
  transactPortfolio: (
    type: PortfolioType,
    build: (container: PortfolioContainer) => PortfolioTransition,
  ) => { ok: boolean; error?: string };
  withdrawPortfolioCash: (type: PortfolioType, amount: number, note?: string) => boolean;
  setTargetAllocations: (type: PortfolioType, targets: Record<string, number>) => void;
  depositCash: (amount: number) => boolean;
  withdrawCash: (amount: number) => boolean;
  switchScope: (userId: string | null) => void;
  addPosition: (incoming: Position) => void;
  addPositions: (incoming: Position[]) => void;
  replacePositions: (incoming: Position[]) => void;
  replacePortfolioState: (incoming: PortfolioPersistedState) => void;
  removePosition: (id: string) => void;
  updatePosition: (id: string, updates: Partial<Pick<Position, 'shares' | 'buyPrice'>>) => void;
}

const PortfolioContext = createContext<PortfolioStore | null>(null);

export function PortfolioProvider({ children }: { children: ReactNode }) {
  const [scope, setScope] = useState<ScopedPortfolioState>(() => ({
    userId: null,
    ...readScopeState(null),
  }));
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const commit = useCallback((next: ScopedPortfolioState) => {
    scopeRef.current = next;
    setScope(next);
  }, []);

  useEffect(() => {
    persistScopeState(scope.userId, scope);
  }, [scope]);

  const switchScope = useCallback(
    (userId: string | null) => {
      const current = scopeRef.current;
      if (current.userId === userId) return;
      persistScopeState(current.userId, current);
      commit({ userId, ...readScopeState(userId) });
    },
    [commit],
  );

  const setActivePortfolioType = useCallback(
    (type: PortfolioType) => {
      const current = scopeRef.current;
      commit({ ...current, activePortfolioType: type });
    },
    [commit],
  );

  const getPortfolio = useCallback((type: PortfolioType): PortfolioContainer => {
    return scopeRef.current.portfolios[type];
  }, []);

  const executeBuy = useCallback(
    (type: PortfolioType, input: BuyTransactionInput): { ok: boolean; error?: string } => {
      const current = scopeRef.current;
      const result = applyBuyTransaction(current.portfolios[type], input);
      if (!result.ok) return { ok: false, error: result.error };
      commit(replaceContainer(current, type, result.container));
      return { ok: true };
    },
    [commit],
  );

  const executeSell = useCallback(
    (
      type: PortfolioType,
      input: SellTransactionInput,
    ): { ok: boolean; realizedPnl?: number; error?: string } => {
      const current = scopeRef.current;
      const result = applySellTransaction(current.portfolios[type], input);
      if (!result.ok) return { ok: false, error: result.error };
      commit(replaceContainer(current, type, result.container));
      return { ok: true, realizedPnl: result.realizedPnl };
    },
    [commit],
  );

  const applyPortfolioCash = useCallback(
    (
      type: PortfolioType,
      action: CashTransaction['type'],
      amount: number,
      note?: string,
    ): boolean => {
      const current = scopeRef.current;
      const result = applyCashTransaction(current.portfolios[type], {
        type: action,
        amount,
        timestamp: new Date().toISOString(),
        cashTransactionId: nextTransactionId(action),
        transactionId: nextTransactionId(`portfolio-${action}`),
        ...(note !== undefined ? { note } : {}),
      });
      if (!result.ok) return false;
      commit(replaceContainer(current, type, result.container));
      return true;
    },
    [commit],
  );

  const transactPortfolio = useCallback(
    (type: PortfolioType, build: (container: PortfolioContainer) => PortfolioTransition) => {
      const current = scopeRef.current;
      const result = build(current.portfolios[type]);
      if (!result.ok) return { ok: false, error: result.error };
      commit(replaceContainer(current, type, result.container));
      return { ok: true };
    },
    [commit],
  );

  const depositPortfolioCash = useCallback(
    (type: PortfolioType, amount: number, note?: string) =>
      applyPortfolioCash(type, 'deposit', amount, note),
    [applyPortfolioCash],
  );

  const withdrawPortfolioCash = useCallback(
    (type: PortfolioType, amount: number, note?: string) =>
      applyPortfolioCash(type, 'withdrawal', amount, note),
    [applyPortfolioCash],
  );

  const depositCash = useCallback(
    (amount: number) => depositPortfolioCash('real_tracking', amount),
    [depositPortfolioCash],
  );

  const withdrawCash = useCallback(
    (amount: number) => withdrawPortfolioCash('real_tracking', amount),
    [withdrawPortfolioCash],
  );

  const setTargetAllocations = useCallback(
    (type: PortfolioType, targets: Record<string, number>) => {
      const current = scopeRef.current;
      const normalized = normalizeTargetAllocations(targets) ?? {};
      commit(
        replaceContainer(current, type, {
          ...current.portfolios[type],
          targetAllocations: normalized,
        }),
      );
    },
    [commit],
  );

  const addPositions = useCallback(
    (incoming: Position[]) => {
      const current = scopeRef.current;
      const realIncoming: Position[] = [];
      const simulatedIncoming: Position[] = [];
      for (const rawPosition of incoming) {
        const position = normalizePositionLots(rawPosition);
        if (position.isSimulated === true || position.isSimulation) {
          simulatedIncoming.push(position);
        } else {
          realIncoming.push(position);
        }
      }
      commit({
        ...current,
        portfolios: {
          ...current.portfolios,
          real_tracking: {
            ...current.portfolios.real_tracking,
            positions: [...current.portfolios.real_tracking.positions, ...realIncoming],
          },
          long_term_sim: {
            ...current.portfolios.long_term_sim,
            positions: mergeDuplicateTickers([
              ...current.portfolios.long_term_sim.positions,
              ...simulatedIncoming,
            ]),
          },
        },
      });
    },
    [commit],
  );

  const addPosition = useCallback(
    (incoming: Position) => {
      addPositions([incoming]);
    },
    [addPositions],
  );

  const replacePositions = useCallback(
    (incoming: Position[]) => {
      const realPositions: Position[] = [];
      const simulatedPositions: Position[] = [];
      for (const rawPosition of incoming) {
        const position = normalizePositionLots(rawPosition);
        if (position.isSimulated === true || position.isSimulation) {
          simulatedPositions.push(position);
        } else {
          realPositions.push(position);
        }
      }
      const current = scopeRef.current;
      commit({
        ...current,
        portfolios: {
          ...current.portfolios,
          real_tracking: { ...current.portfolios.real_tracking, positions: realPositions },
          long_term_sim: {
            ...current.portfolios.long_term_sim,
            positions: mergeDuplicateTickers(simulatedPositions),
          },
        },
      });
    },
    [commit],
  );

  const replacePortfolioState = useCallback(
    (incoming: PortfolioPersistedState) => {
      if (Array.isArray(incoming)) {
        replacePositions(incoming);
        return;
      }
      const current = scopeRef.current;
      commit({ userId: current.userId, ...migratePortfolioState(incoming) });
    },
    [commit, replacePositions],
  );

  const removePosition = useCallback(
    (id: string) => {
      const current = scopeRef.current;
      commit({
        ...current,
        portfolios: {
          ...current.portfolios,
          real_tracking: {
            ...current.portfolios.real_tracking,
            positions: current.portfolios.real_tracking.positions.filter(
              (position) => position.id !== id,
            ),
          },
          long_term_sim: {
            ...current.portfolios.long_term_sim,
            positions: current.portfolios.long_term_sim.positions.filter(
              (position) => position.id !== id,
            ),
          },
        },
      });
    },
    [commit],
  );

  const updatePosition = useCallback(
    (id: string, updates: Partial<Pick<Position, 'shares' | 'buyPrice'>>) => {
      const updatePositions = (positions: Position[]): Position[] =>
        positions.map((position) => {
          if (position.id !== id) return position;
          const normalized = normalizePositionLots(position);
          const nextShares = updates.shares ?? normalized.shares;
          const nextBuyPrice = updates.buyPrice ?? normalized.buyPrice;
          if (nextShares === normalized.shares && nextBuyPrice === normalized.buyPrice) {
            return position;
          }

          const shareScale = normalized.shares > 0 ? nextShares / normalized.shares : 0;
          const priceScale = normalized.buyPrice > 0 ? nextBuyPrice / normalized.buyPrice : 0;
          const lots = (normalized.lots ?? []).map((lot) => ({
            ...lot,
            shares: lot.shares * shareScale,
            buyPrice: normalized.buyPrice > 0 ? lot.buyPrice * priceScale : nextBuyPrice,
          }));

          return normalizePositionLots({
            ...normalized,
            shares: nextShares,
            buyPrice: nextBuyPrice,
            lots,
          });
        });
      const current = scopeRef.current;
      commit({
        ...current,
        portfolios: {
          ...current.portfolios,
          real_tracking: {
            ...current.portfolios.real_tracking,
            positions: updatePositions(current.portfolios.real_tracking.positions),
          },
          long_term_sim: {
            ...current.portfolios.long_term_sim,
            positions: updatePositions(current.portfolios.long_term_sim.positions),
          },
        },
      });
    },
    [commit],
  );

  const positions = useMemo(
    () => [
      ...scope.portfolios.real_tracking.positions,
      ...scope.portfolios.long_term_sim.positions,
    ],
    [scope.portfolios.real_tracking.positions, scope.portfolios.long_term_sim.positions],
  );

  const value = useMemo<PortfolioStore>(
    () => ({
      positions,
      scopeUserId: scope.userId,
      cashBalance: scope.portfolios.real_tracking.cashBalance,
      cashLedger: scope.portfolios.real_tracking.cashLedger,
      activePortfolioType: scope.activePortfolioType,
      portfolios: scope.portfolios,
      setActivePortfolioType,
      getPortfolio,
      executeBuy,
      executeSell,
      depositPortfolioCash,
      transactPortfolio,
      withdrawPortfolioCash,
      setTargetAllocations,
      depositCash,
      withdrawCash,
      switchScope,
      addPosition,
      addPositions,
      replacePositions,
      replacePortfolioState,
      removePosition,
      updatePosition,
    }),
    [
      positions,
      scope,
      setActivePortfolioType,
      getPortfolio,
      executeBuy,
      executeSell,
      depositPortfolioCash,
      transactPortfolio,
      withdrawPortfolioCash,
      setTargetAllocations,
      depositCash,
      withdrawCash,
      switchScope,
      addPosition,
      addPositions,
      replacePositions,
      replacePortfolioState,
      removePosition,
      updatePosition,
    ],
  );

  return <PortfolioContext.Provider value={value}>{children}</PortfolioContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePortfolio(): PortfolioStore {
  const context = useContext(PortfolioContext);
  if (!context) throw new Error('usePortfolio must be used within a PortfolioProvider');
  return context;
}
