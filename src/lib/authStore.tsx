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
import { usePortfolio } from '@/lib/portfolioStore';
import { useSessionTimeout } from '@/hooks/useSessionTimeout';

interface AuthStore {
  user: User | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthStore | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const { replacePositions } = usePortfolio();
  const loadedUserIdRef = useRef<string | null>(null);

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

  // When a user logs in (or returns with a persisted session), hydrate the
  // global store from their cloud portfolio. This lives at the provider level
  // (mounted once) so it runs on login rather than on every dashboard remount.
  useEffect(() => {
    if (!user) {
      loadedUserIdRef.current = null;
      return;
    }
    if (loadedUserIdRef.current === user.id) return;
    loadedUserIdRef.current = user.id;

    loadPortfolio(user.id)
      .then((saved) => {
        if (saved && saved.length > 0) replacePositions(saved);
      })
      .catch(() => {
        // Offline or no saved row — keep the current local positions.
      });
  }, [user, replacePositions]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  useSessionTimeout(user?.id ?? null, signOut);

  const value = useMemo(() => ({ user, loading, signOut }), [user, loading, signOut]);

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
