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
import { loadPortfolio } from '@/lib/db';
import {
  beginHydration,
  completeHydration,
  getHydrationState,
  resetHydration,
} from '@/lib/hydrationStore';
import { usePortfolio } from '@/lib/portfolioStore';
import { useSessionTimeout } from '@/hooks/useSessionTimeout';

interface AuthStore {
  user: User | null;
  isPro: boolean;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthStore | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const { switchScope, replacePortfolioState } = usePortfolio();
  /** The user the currently-executing auth/hydration flow belongs to. */
  const activeUserIdRef = useRef<string | null>(null);

  useEffect(() => {
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
      switchScope(null);
      resetHydration();
      return;
    }

    const hydration = getHydrationState();
    if (hydration.userId === userId && hydration.status !== 'idle') return;

    switchScope(userId);
    beginHydration(userId);

    loadPortfolio(userId)
      .then((saved) => {
        if (activeUserIdRef.current !== userId) return; // stale — user changed/signed out
        // An existing cloud row always wins, including an explicit empty `[]`,
        // which must replace demo seeds rather than coexist with them.
        if (saved !== null) replacePortfolioState(saved);
        completeHydration(userId, 'ready');
      })
      .catch(() => {
        if (activeUserIdRef.current !== userId) return; // stale — user changed/signed out
        completeHydration(userId, 'error');
      });
  }, [user, switchScope, replacePortfolioState]);

  const signOut = useCallback(async () => {
    // Clear the signed-in user's in-memory portfolio and re-scope to guest
    // IMMEDIATELY — before the network sign-out resolves — so a subsequent
    // account can never observe the previous user's positions (F-4.1a).
    activeUserIdRef.current = null;
    switchScope(null);
    resetHydration();
    await supabase.auth.signOut();
  }, [switchScope]);

  useSessionTimeout(user?.id ?? null, signOut);

  // Temporary entitlement bridge until billing is connected. Supabase user
  // metadata gives us a production-shaped switch while every existing account
  // and guest remains on Basic by default.
  const isPro = user?.app_metadata?.['is_pro'] === true || user?.user_metadata?.['is_pro'] === true;

  const value = useMemo(() => ({ user, isPro, loading, signOut }), [user, isPro, loading, signOut]);

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
