import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabaseClient';
import { cn } from '@/lib/utils';

const CLOSE_MS = 260;

type AuthMode = 'signin' | 'signup';

export function AuthModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [mode, setMode] = useState<AuthMode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [closing, setClosing] = useState(false);

  const closingRef = useRef(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const emailRef = useRef<HTMLInputElement>(null);

  const close = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    closeTimer.current = window.setTimeout(() => {
      onOpenChange(false);
      setClosing(false);
      closingRef.current = false;
    }, CLOSE_MS);
  }, [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    closingRef.current = false;
    setClosing(false);
    setMode('signin');
    setEmail('');
    setPassword('');
    setError(null);
  }, [open]);

  useEffect(
    () => () => {
      if (closeTimer.current) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    window.addEventListener('keydown', onKey);
    const focusTimer = window.setTimeout(() => emailRef.current?.focus(), 140);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.clearTimeout(focusTimer);
    };
  }, [open, close]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);

    const { data, error: authError } =
      mode === 'signin'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });

    if (authError) {
      setError(authError.message);
      setSubmitting(false);
      return;
    }

    if (mode === 'signup' && !data.session) {
      toast.success('Account created', {
        description: 'Check your inbox to confirm your email, then sign in.',
      });
    } else {
      toast.success(mode === 'signin' ? 'Signed in' : 'Account created');
    }

    setSubmitting(false);
    close();
  }

  if (!open) return null;

  return createPortal(
    <div className={cn('auth-overlay', closing && 'is-closing')} onClick={close}>
      <motion.form
        className="auth-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="ZeroChart account"
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={closing ? { opacity: 0, scale: 0.96, y: 12 } : { opacity: 1, scale: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 340, damping: 32 }}
      >
        <header className="auth-header">
          <div>
            <span className="auth-eyebrow">ZeroChart Account</span>
            <h3 className="auth-title">{mode === 'signin' ? 'Sign in' : 'Create account'}</h3>
          </div>
          <button type="button" className="auth-close" onClick={close} aria-label="Close">
            <X size={18} />
          </button>
        </header>

        <div className="auth-mode" role="group" aria-label="Authentication mode">
          <button
            type="button"
            className={cn('auth-mode-btn', mode === 'signin' && 'is-active')}
            aria-pressed={mode === 'signin'}
            onClick={() => {
              setMode('signin');
              setError(null);
            }}
          >
            Sign In
          </button>
          <button
            type="button"
            className={cn('auth-mode-btn', mode === 'signup' && 'is-active')}
            aria-pressed={mode === 'signup'}
            onClick={() => {
              setMode('signup');
              setError(null);
            }}
          >
            Sign Up
          </button>
        </div>

        <div className="auth-body">
          <label className="auth-field">
            <span className="auth-label">Email</span>
            <input
              ref={emailRef}
              className="auth-input"
              type="email"
              autoComplete="email"
              required
              value={email}
              placeholder="you@example.com"
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="auth-field">
            <span className="auth-label">Password</span>
            <input
              className="auth-input"
              type="password"
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              required
              minLength={6}
              value={password}
              placeholder="••••••••"
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}
        </div>

        <footer className="auth-footer">
          <button type="button" className="auth-cancel" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="auth-submit" disabled={submitting}>
            {submitting ? 'Please wait…' : mode === 'signin' ? 'Sign In' : 'Create Account'}
          </button>
        </footer>
      </motion.form>
    </div>,
    document.body,
  );
}
