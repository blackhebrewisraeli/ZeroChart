import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import type { Position } from '@/lib/portfolioManager';

/**
 * Account-scoped local persistence (M1-T1, F-4.1a) with a state-driven cash
 * ledger (M1-T3, F-1.3a).
 *
 * Positions AND cash are stored under a scope key: one shared guest key for
 * signed-out sessions and one key per authenticated user. `switchScope`
 * re-scopes the store atomically — flushing the outgoing owner's state under
 * their own key and loading the incoming owner's own persisted state — so
 * neither positions nor cash can bleed between accounts.
 *
 * The cash ledger (`CashTransaction[]`) is the source of truth for available
 * cash: deposits and withdrawals append entries and update `cashBalance`.
 * Cloud sync of cash arrives with the normalized schema (roadmap M2-2,
 * `portfolios.cash_balance`); today cash persists device-locally only.
 */
const GUEST_STORAGE_KEY = 'zerochart:portfolio-positions';

function userStorageKey(userId: string): string {
  return `zerochart:portfolio-positions:${userId}`;
}

function storageKeyFor(userId: string | null): string {
  return userId === null ? GUEST_STORAGE_KEY : userStorageKey(userId);
}

/**
 * Seed positions for the simulation portfolio. Canonical starting state for
 * a scope with no persisted data (first-time guest or brand-new account) —
 * demo data, never another account's positions.
 */
const MOCK_POSITIONS: Position[] = [
  {
    id: 'sim-nvda',
    ticker: 'NVDA',
    buyPrice: 108,
    shares: 10,
    isSimulation: true,
    dateAdded: '2026-09-02',
  },
  {
    id: 'sim-aapl',
    ticker: 'AAPL',
    buyPrice: 252,
    shares: 4,
    isSimulation: true,
    dateAdded: '2026-09-18',
  },
];

/**
 * Opening cash for scopes with no persisted ledger (M1-T3, F-1.3a). This
 * replaces the old hardcoded `AVAILABLE_CASH = 2500` UI constant — it is now
 * SEED DATA for the cash ledger, and every later change flows through
 * deposits/withdrawals.
 */
const DEMO_OPENING_CASH = 2500;

export interface CashTransaction {
  id: string;
  type: 'deposit' | 'withdrawal';
  /** Positive USD amount. */
  amount: number;
  createdAt: string;
}

const SEED_CASH_LEDGER: CashTransaction[] = [
  {
    id: 'seed-opening-deposit',
    type: 'deposit',
    amount: DEMO_OPENING_CASH,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
];

/** Persisted scope payload. Version 1 was a bare `Position[]` array. */
interface ScopeState {
  positions: Position[];
  cashBalance: number;
  cashLedger: CashTransaction[];
}

function seedScopeCash(): Pick<ScopeState, 'cashBalance' | 'cashLedger'> {
  return { cashBalance: DEMO_OPENING_CASH, cashLedger: SEED_CASH_LEDGER };
}

function seedScope(): ScopeState {
  return { positions: MOCK_POSITIONS, ...seedScopeCash() };
}

/** Loads a scope's persisted state, tolerating legacy v1 (array) payloads. */
function readScopeState(userId: string | null): ScopeState {
  if (typeof window === 'undefined') return seedScope();
  try {
    const raw = window.localStorage.getItem(storageKeyFor(userId));
    if (!raw) return seedScope();
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // Legacy v1 payload: positions only — cash falls back to the seed.
      return { positions: parsed as Position[], ...seedScopeCash() };
    }
    if (parsed !== null && typeof parsed === 'object') {
      const scope = parsed as { positions?: unknown; cashBalance?: unknown; cashLedger?: unknown };
      if (Array.isArray(scope.positions)) {
        const cashBalance =
          typeof scope.cashBalance === 'number' && Number.isFinite(scope.cashBalance)
            ? scope.cashBalance
            : DEMO_OPENING_CASH;
        const cashLedger = Array.isArray(scope.cashLedger)
          ? (scope.cashLedger as CashTransaction[])
          : SEED_CASH_LEDGER;
        return { positions: scope.positions as Position[], cashBalance, cashLedger };
      }
    }
    return seedScope();
  } catch {
    return seedScope();
  }
}

function persistScopeState(userId: string | null, state: ScopeState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKeyFor(userId), JSON.stringify({ version: 2, ...state }));
  } catch {
    // Ignore quota / private-mode errors — the store still works in memory.
  }
}

function nextTransactionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface PortfolioStore {
  positions: Position[];
  /** The owner of the in-memory state: a user id, or null for guest. */
  scopeUserId: string | null;
  /** Available cash (USD), kept in sync with `cashLedger`. */
  cashBalance: number;
  /** Append-only deposit/withdrawal history backing `cashBalance`. */
  cashLedger: CashTransaction[];
  /** Applies a deposit; returns false for invalid amounts. */
  depositCash: (amount: number) => boolean;
  /** Applies a withdrawal; returns false for invalid amounts or overdrafts. */
  withdrawCash: (amount: number) => boolean;
  /**
   * Re-scopes the store to another owner (user id, or null for guest). The
   * outgoing owner's positions+cash are flushed to their own storage key and
   * the incoming owner's persisted state (or demo seed) is loaded — a fresh
   * account always starts from ITS OWN state, never a previous session's.
   */
  switchScope: (userId: string | null) => void;
  addPositions: (incoming: Position[]) => void;
  replacePositions: (incoming: Position[]) => void;
  removePosition: (id: string) => void;
  updatePosition: (id: string, updates: Partial<Pick<Position, 'shares' | 'buyPrice'>>) => void;
}

const PortfolioContext = createContext<PortfolioStore | null>(null);

export function PortfolioProvider({ children }: { children: ReactNode }) {
  const [scope, setScope] = useState<{ userId: string | null } & ScopeState>(() => ({
    userId: null,
    ...readScopeState(null),
  }));

  // Latest-render ref so cash actions can validate against current state
  // before queuing the functional update (single-user UI interactions).
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  // Persist the active scope's state under that scope's own key.
  useEffect(() => {
    persistScopeState(scope.userId, scope);
  }, [scope]);

  const switchScope = useCallback((userId: string | null) => {
    setScope((prev) => {
      if (prev.userId === userId) return prev; // same owner — keep in-memory state
      // Flush the outgoing owner's latest state under their own key
      // before swapping (idempotent; StrictMode re-invocation is harmless).
      persistScopeState(prev.userId, prev);
      return { userId, ...readScopeState(userId) };
    });
  }, []);

  const depositCash = useCallback(
    (amount: number): boolean =>
      applyCashTransaction('deposit', amount, scopeRef.current.cashBalance, setScope),
    [],
  );

  const withdrawCash = useCallback(
    (amount: number): boolean =>
      applyCashTransaction('withdrawal', amount, scopeRef.current.cashBalance, setScope),
    [],
  );

  const addPositions = useCallback((incoming: Position[]) => {
    setScope((prev) => ({ ...prev, positions: [...prev.positions, ...incoming] }));
  }, []);

  const replacePositions = useCallback((incoming: Position[]) => {
    setScope((prev) => ({ ...prev, positions: incoming }));
  }, []);

  const removePosition = useCallback((id: string) => {
    setScope((prev) => ({
      ...prev,
      positions: prev.positions.filter((position) => position.id !== id),
    }));
  }, []);

  const updatePosition = useCallback(
    (id: string, updates: Partial<Pick<Position, 'shares' | 'buyPrice'>>) => {
      setScope((prev) => ({
        ...prev,
        positions: prev.positions.map((position) =>
          position.id === id ? { ...position, ...updates } : position,
        ),
      }));
    },
    [],
  );

  const value = useMemo(
    () => ({
      positions: scope.positions,
      scopeUserId: scope.userId,
      cashBalance: scope.cashBalance,
      cashLedger: scope.cashLedger,
      depositCash,
      withdrawCash,
      switchScope,
      addPositions,
      replacePositions,
      removePosition,
      updatePosition,
    }),
    [
      scope,
      depositCash,
      withdrawCash,
      switchScope,
      addPositions,
      replacePositions,
      removePosition,
      updatePosition,
    ],
  );

  return <PortfolioContext.Provider value={value}>{children}</PortfolioContext.Provider>;
}

type SetScope = Dispatch<SetStateAction<{ userId: string | null } & ScopeState>>;

/**
 * Validates and applies a cash transaction. Returns false for non-positive
 * amounts and overdrafting withdrawals; the functional update re-checks the
 * balance atomically so concurrent renders cannot overdraw.
 */
function applyCashTransaction(
  type: CashTransaction['type'],
  amount: number,
  currentBalance: number,
  setScope: SetScope,
): boolean {
  if (!Number.isFinite(amount) || amount <= 0) return false;
  if (type === 'withdrawal' && amount > currentBalance) return false;
  setScope((prev) => {
    const nextBalance = type === 'deposit' ? prev.cashBalance + amount : prev.cashBalance - amount;
    if (nextBalance < 0) return prev; // no overdrafts (atomic re-check)
    const transaction: CashTransaction = {
      id: nextTransactionId(),
      type,
      amount,
      createdAt: new Date().toISOString(),
    };
    return {
      ...prev,
      cashBalance: Number(nextBalance.toFixed(2)),
      cashLedger: [...prev.cashLedger, transaction],
    };
  });
  return true;
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePortfolio(): PortfolioStore {
  const context = useContext(PortfolioContext);
  if (!context) {
    throw new Error('usePortfolio must be used within a PortfolioProvider');
  }
  return context;
}
