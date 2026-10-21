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
import type { User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabaseClient';
import { loadIsPro, loadPaperTransactions, loadPortfolio } from '@/lib/db';
import {
  beginHydration,
  completeHydration,
  getHydrationState,
  resetHydration,
} from '@/lib/hydrationStore';
import { usePortfolio } from '@/lib/portfolioStore';
import { resetAdManager } from '@/lib/adManager';
import { useSessionTimeout } from '@/hooks/useSessionTimeout';

interface AuthStore {
  user: User | null;
  isPro: boolean;
  loading: boolean;
  signOut: () => Promise<void>;
  /** Sandbox checkout: grants Pro for this tab only — no billing, nothing persisted. */
  activateSandboxPro: () => void;
}

const AuthContext = createContext<AuthStore | null>(null);

const DEV_AUTH_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Dev-only stub user for headless browser verification (Playwright / CDP):
 * open `http://localhost:<port>/?devAuth=1` (or `?devAuth=pro`) to render the
 * signed-in shell without a Supabase session or credentials. Cloud reads and
 * writes still go through RLS with the anon key, so nothing real is reachable
 * (Paper Trading fills need a real session to book).
 * `import.meta.env.DEV` is statically `false` in `vite build`, so this is
 * stripped from production; the vitest run and non-localhost hosts are excluded.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function readDevAuthUser(): User | null {
  if (!import.meta.env.DEV || import.meta.env.MODE === 'test') return null;
  if (typeof location === 'undefined' || !DEV_AUTH_HOSTS.has(location.hostname)) return null;
  const flag = new URLSearchParams(location.search).get('devAuth');
  if (flag !== '1' && flag !== 'pro') return null;
  return {
    id: '00000000-0000-4000-8000-000000000001',
    aud: 'authenticated',
    email: 'dev@localhost',
    app_metadata: { is_pro: flag === 'pro' },
    user_metadata: {},
    created_at: new Date(0).toISOString(),
  };
}

export function AuthProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [sandboxPro, setSandboxPro] = useState(false);
  /** The user whose `user_subscriptions` row grants Pro, once it has loaded. */
  const [proUserId, setProUserId] = useState<string | null>(null);
  const { switchScope, replacePortfolioState, replacePaperLedger } = usePortfolio();
  /** The user the currently-executing auth/hydration flow belongs to. */
  const activeUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    const devUser = readDevAuthUser();
    if (devUser) {
      setUser(devUser);
      setLoading(false);
      return;
    }

    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (active) {
        setUser(data.session?.user ?? null);
        setLoading(false);
      }
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  // Re-scope the portfolio store and hydrate the cloud row whenever the
  // signed-in user changes (M1-T1, F-4.1a / F-4.1b):
  //  1. `switchScope` FIRST so the session reflects only this owner's state —
  //     never a pre-login or previous-user leftover;
  //  2. `beginHydration` opens the cloud-write barrier until `loadPortfolio`
  //     settles for this exact user;
  //  3. stale in-flight responses (user changed or signed out mid-flight) are
  //     ignored via the `activeUserIdRef` guard;
  //  4. same-session auth events (token refresh, StrictMode re-runs) skip
  //     re-hydration while a flow for this user is already active or settled.
  useEffect(() => {
    const userId = user?.id ?? null;
    activeUserIdRef.current = userId;

    if (userId === null) {
      resetAdManager();
      switchScope(null);
      resetHydration();
      return;
    }

    const hydration = getHydrationState();
    if (hydration.userId === userId && hydration.status !== 'idle') return;

    resetAdManager();
    switchScope(userId);
    beginHydration(userId);

    // The dev stub has no session to read `paper_transactions` with.
    const paperLedger = readDevAuthUser() ? null : loadPaperTransactions(userId);
    Promise.all([loadPortfolio(userId), paperLedger])
      .then(([saved, paperRows]) => {
        if (activeUserIdRef.current !== userId) return; // stale — user changed/signed out
        // An existing cloud row always wins, including an explicit empty `[]`,
        // which must replace demo seeds rather than coexist with them.
        if (saved !== null) replacePortfolioState(saved);
        // Paper Trading is replayed from the server ledger, never the local cache.
        if (paperRows !== null) replacePaperLedger(paperRows);
        completeHydration(userId, 'ready');
      })
      .catch(() => {
        if (activeUserIdRef.current !== userId) return; // stale — user changed/signed out
        completeHydration(userId, 'error');
      });
  }, [user, switchScope, replacePortfolioState, replacePaperLedger]);

  // Pro comes only from the user's `user_subscriptions` row, which only the
  // service role writes. Session metadata is never trusted for entitlement.
  const userId = user?.id ?? null;
  useEffect(() => {
    if (userId === null) return;
    const devUser = readDevAuthUser();
    if (devUser) {
      setProUserId(devUser.app_metadata['is_pro'] === true ? devUser.id : null);
      return;
    }
    let active = true;
    loadIsPro(userId)
      .then((pro) => {
        if (active) setProUserId(pro ? userId : null);
      })
      .catch(() => {
        if (active) setProUserId(null); // fail closed
      });
    return () => {
      active = false;
    };
  }, [userId]);

  const signOut = useCallback(async () => {
    const devAuthActive = readDevAuthUser() !== null;
    // Clear the signed-in user's in-memory portfolio and re-scope to guest
    // IMMEDIATELY — before the network sign-out resolves — so a subsequent
    // account can never observe the previous user's positions (F-4.1a).
    activeUserIdRef.current = null;
    setUser(null);
    setSandboxPro(false);
    switchScope(null);
    resetHydration();
    if (devAuthActive) {
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.delete('devAuth');
      window.history.replaceState(window.history.state, '', nextUrl);
      return;
    }
    await supabase.auth.signOut();
  }, [switchScope]);

  useSessionTimeout(user?.id ?? null, signOut);

  const isPro = sandboxPro || (userId !== null && proUserId === userId);

  const activateSandboxPro = useCallback(() => setSandboxPro(true), []);

  const value = useMemo(
    () => ({ user, isPro, loading, signOut, activateSandboxPro }),
    [user, isPro, loading, signOut, activateSandboxPro],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthStore {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
