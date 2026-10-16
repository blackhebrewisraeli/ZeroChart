import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Position } from '@/lib/portfolioManager';

/**
 * Account-scoped local persistence (M1-T1, finding F-4.1a).
 *
 * Positions are stored under a scope key: one shared guest key for signed-out
 * sessions and one key per authenticated user. `switchScope` re-scopes the
 * store atomically — it flushes the outgoing owner's latest positions under
 * their own key and loads the incoming owner's own persisted state — so
 * positions can never bleed from one account (or a pre-login session) into
 * another, even when the next account's cloud row is empty.
 */
const GUEST_STORAGE_KEY = 'zerochart:portfolio-positions';

function userStorageKey(userId: string): string {
  return `zerochart:portfolio-positions:${userId}`;
}

function storageKeyFor(userId: string | null): string {
  return userId === null ? GUEST_STORAGE_KEY : userStorageKey(userId);
}

/**
 * Seed positions for the simulation portfolio. These are the canonical
 * starting state for a scope with no persisted data (first-time guest or a
 * brand-new account) — demo data, never another account's positions.
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

/** Loads a scope's persisted positions, falling back to the demo seeds. */
function readScopePositions(userId: string | null): Position[] {
  if (typeof window === 'undefined') return MOCK_POSITIONS;
  try {
    const raw = window.localStorage.getItem(storageKeyFor(userId));
    if (!raw) return MOCK_POSITIONS;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return MOCK_POSITIONS;
    return parsed as Position[];
  } catch {
    return MOCK_POSITIONS;
  }
}

function persistScopePositions(userId: string | null, positions: Position[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKeyFor(userId), JSON.stringify(positions));
  } catch {
    // Ignore quota / private-mode errors — the store still works in memory.
  }
}

interface PortfolioStore {
  positions: Position[];
  /** The owner of the in-memory positions: a user id, or null for guest. */
  scopeUserId: string | null;
  /**
   * Re-scopes the store to another owner (user id, or null for guest). The
   * outgoing owner's positions are flushed to their own storage key and the
   * incoming owner's persisted state (or demo seed) is loaded — a fresh
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
  const [scope, setScope] = useState<{ userId: string | null; positions: Position[] }>(() => ({
    userId: null,
    positions: readScopePositions(null),
  }));

  // Persist the active scope's positions under that scope's own key.
  useEffect(() => {
    persistScopePositions(scope.userId, scope.positions);
  }, [scope]);

  const switchScope = useCallback((userId: string | null) => {
    setScope((prev) => {
      if (prev.userId === userId) return prev; // same owner — keep in-memory state
      // Flush the outgoing owner's latest positions under their own key
      // before swapping (idempotent; StrictMode re-invocation is harmless).
      persistScopePositions(prev.userId, prev.positions);
      return { userId, positions: readScopePositions(userId) };
    });
  }, []);

  const addPositions = useCallback((incoming: Position[]) => {
    setScope((prev) => ({ ...prev, positions: [...prev.positions, ...incoming] }));
  }, []);

  const replacePositions = useCallback((incoming: Position[]) => {
    setScope((prev) => ({ ...prev, positions: incoming }));
  }, []);

  const removePosition = useCallback((id: string) => {
    setScope((prev) => ({ ...prev, positions: prev.positions.filter((p) => p.id !== id) }));
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
      switchScope,
      addPositions,
      replacePositions,
      removePosition,
      updatePosition,
    }),
    [scope, switchScope, addPositions, replacePositions, removePosition, updatePosition],
  );

  return <PortfolioContext.Provider value={value}>{children}</PortfolioContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePortfolio(): PortfolioStore {
  const context = useContext(PortfolioContext);
  if (!context) {
    throw new Error('usePortfolio must be used within a PortfolioProvider');
  }
  return context;
}
