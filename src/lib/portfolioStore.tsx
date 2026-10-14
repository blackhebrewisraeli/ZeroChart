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

const STORAGE_KEY = 'zerochart:portfolio-positions';

/**
 * Seed positions for the simulation portfolio. These are the canonical
 * starting state and are only used to initialise the store — every other
 * consumer reads from the global portfolio state below.
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

interface PortfolioStore {
  positions: Position[];
  addPositions: (incoming: Position[]) => void;
  removePosition: (id: string) => void;
  updatePosition: (id: string, updates: Partial<Pick<Position, 'shares' | 'buyPrice'>>) => void;
}

const PortfolioContext = createContext<PortfolioStore | null>(null);

function readInitialPositions(): Position[] {
  if (typeof window === 'undefined') return MOCK_POSITIONS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return MOCK_POSITIONS;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return MOCK_POSITIONS;
    return parsed as Position[];
  } catch {
    return MOCK_POSITIONS;
  }
}

export function PortfolioProvider({ children }: { children: ReactNode }) {
  const [positions, setPositions] = useState<Position[]>(readInitialPositions);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
    } catch {
      // Ignore quota / private-mode errors — the store still works in memory.
    }
  }, [positions]);

  const addPositions = useCallback((incoming: Position[]) => {
    setPositions((prev) => [...prev, ...incoming]);
  }, []);

  const removePosition = useCallback((id: string) => {
    setPositions((prev) => prev.filter((position) => position.id !== id));
  }, []);

  const updatePosition = useCallback(
    (id: string, updates: Partial<Pick<Position, 'shares' | 'buyPrice'>>) => {
      setPositions((prev) =>
        prev.map((position) => (position.id === id ? { ...position, ...updates } : position)),
      );
    },
    [],
  );

  const value = useMemo(
    () => ({ positions, addPositions, removePosition, updatePosition }),
    [positions, addPositions, removePosition, updatePosition],
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
