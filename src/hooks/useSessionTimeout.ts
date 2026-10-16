import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const ACTIVITY_EVENTS = [
  'mousemove',
  'mousedown',
  'keydown',
  'touchstart',
  'scroll',
  'wheel',
] as const;

/**
 * Logs the user out after a period of inactivity (mouse/keyboard/touch) and
 * surfaces a neon session-expiration toast. Active only while signed in.
 */
export function useSessionTimeout(userId: string | null, signOut: () => Promise<void>): void {
  const timerRef = useRef<number | undefined>(undefined);
  const signOutRef = useRef(signOut);
  signOutRef.current = signOut;

  useEffect(() => {
    if (!userId) return;

    function resetTimer(): void {
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        void signOutRef.current();
        toast.error('Session expired', {
          description: 'You were signed out after 15 minutes of inactivity.',
        });
      }, INACTIVITY_TIMEOUT_MS);
    }

    function onActivity(): void {
      resetTimer();
    }

    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, onActivity, { passive: true });
    }
    resetTimer();

    return () => {
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, onActivity);
      }
    };
  }, [userId]);
}
