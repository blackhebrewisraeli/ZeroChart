import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabaseClient';
import { cn } from '@/lib/utils';

const CLOSE_MS = 260;

type AuthMode = 'signin' | 'signup';

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.63v3h3.87c2.26-2.09 3.55-5.16 3.55-8.87Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.08 7.94-2.91l-3.87-3c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.29v3.1A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.28A7.2 7.2 0 0 1 4.89 12c0-.79.14-1.56.38-2.28v-3.1H1.29A12 12 0 0 0 0 12c0 1.94.46 3.77 1.29 5.38l3.98-3.1Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.76c1.77 0 3.35.61 4.6 1.8l3.44-3.44A11.97 11.97 0 0 0 12 0 12 12 0 0 0 1.29 6.62l3.98 3.1C6.22 6.87 8.87 4.76 12 4.76Z"
      />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.11.79-.25.79-.56v-1.96c-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.7 1.25 3.35.96.1-.75.4-1.25.73-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.59.24 2.76.12 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.69 5.39-5.25 5.67.41.36.78 1.06.78 2.14v3.18c0 .31.21.68.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

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

  async function handleOAuth(provider: 'google' | 'github') {
    if (submitting) return;
    setError(null);
    setSubmitting(true);

    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin },
    });

    if (error) {
      setError(error.message);
      setSubmitting(false);
    }
    // On success the browser navigates to the provider's consent screen.
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

        <div className="oauth-buttons">
          <button
            type="button"
            className="oauth-button"
            onClick={() => handleOAuth('google')}
            disabled={submitting}
          >
            <GoogleIcon />
            <span>Continue with Google</span>
          </button>
          <button
            type="button"
            className="oauth-button"
            onClick={() => handleOAuth('github')}
            disabled={submitting}
          >
            <GitHubIcon />
            <span>Continue with GitHub</span>
          </button>
        </div>

        <div className="auth-divider" aria-hidden="true">
          <span>or continue with email</span>
        </div>

        <div className="auth-body">
          <label className="auth-field">
            <span className="auth-label">Email</span>
            <input
              ref={emailRef}
              className="auth-input"
              name="email"
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
              name="password"
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
          <button type="submit" className="auth-submit" disabled={submitting}>
            {submitting ? 'Please wait…' : mode === 'signin' ? 'Sign In' : 'Create Account'}
          </button>
        </div>
      </motion.form>
    </div>,
    document.body,
  );
}
