import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Bell, X } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/lib/authStore';
import { useAlertController } from '@/hooks/useAlertEngine';
import { formatPrice, type Asset } from '@/lib/assets';
import { isBinanceCrypto } from '@/lib/binance';
import { cn, closeOnBackdrop } from '@/lib/utils';

const CLOSE_MS = 260;

/**
 * A compact bell that lives next to a crypto asset in the Markets table. It
 * opens a tiny dialog for entering a target price, then registers a one-shot
 * alert through the SINGLE unified alert pipeline (`useAlertController`,
 * M1-T4 F-5.1): guests get session-scoped alerts, signed-in users get cloud
 * alerts synced to `user_alerts`.
 */
export function SetAlertButton({ asset }: { asset: Asset }) {
  const { user } = useAuth();
  const { alerts, createAlert } = useAlertController(user);
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [target, setTarget] = useState('');
  const [direction, setDirection] = useState<'above' | 'below'>('above');

  const closingRef = useRef(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const enabled = isBinanceCrypto(asset.ticker);
  const hasActiveAlert = alerts.some((alert) => alert.ticker === asset.ticker);
  const numericTarget = Number(target);
  const canSubmit = Number.isFinite(numericTarget) && numericTarget > 0;

  function openModal() {
    if (!enabled) return;
    closingRef.current = false;
    setClosing(false);
    setTarget(asset.current_price != null ? String(asset.current_price) : '');
    setDirection('above');
    setOpen(true);
  }

  const closeModal = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    closeTimer.current = window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
      closingRef.current = false;
      triggerRef.current?.focus();
    }, CLOSE_MS);
  }, []);

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
      if (e.key === 'Escape') closeModal();
    }
    window.addEventListener('keydown', onKey);
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 140);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.clearTimeout(focusTimer);
    };
  }, [open, closeModal]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    try {
      await createAlert({ ticker: asset.ticker, targetPrice: numericTarget, condition: direction });
      toast.success(`Alert set for ${asset.ticker}`, {
        description: `We'll notify you when the price goes ${
          direction === 'above' ? 'above' : 'below'
        } ${formatPrice(numericTarget)}.`,
      });
      closeModal();
    } catch {
      toast.error("Couldn't save alert. Please try again.");
    }
  }

  if (!enabled) return null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cn('alert-bell', hasActiveAlert && 'is-active')}
        onClick={(e) => {
          e.stopPropagation();
          openModal();
        }}
        aria-label={`Set price alert for ${asset.ticker}`}
        title={`Set price alert for ${asset.ticker}`}
      >
        <Bell size={14} />
        {hasActiveAlert && <span className="alert-bell-dot" aria-hidden="true" />}
      </button>

      {open &&
        createPortal(
          <div
            role="presentation"
            className={cn('alert-overlay', closing && 'is-closing')}
            onClick={closeOnBackdrop(closeModal)}
          >
            <form
              className={cn('alert-sheet', closing && 'is-closing')}
              role="dialog"
              aria-modal="true"
              aria-label={`Set price alert for ${asset.ticker}`}
              onSubmit={handleSubmit}
            >
              <header className="alert-header">
                <div>
                  <span className="alert-eyebrow">Price alert</span>
                  <h3 className="alert-title">{asset.ticker}</h3>
                </div>
                <button
                  type="button"
                  className="alert-close"
                  onClick={closeModal}
                  aria-label="Close"
                >
                  <X size={18} />
                </button>
              </header>

              <div className="alert-body">
                <p className="alert-current">
                  Current price <span>{formatPrice(asset.current_price)}</span>
                </p>

                <label className="alert-field">
                  <span className="alert-label">Target price (USD)</span>
                  <input
                    ref={inputRef}
                    className="alert-input"
                    type="number"
                    min="0"
                    step="any"
                    inputMode="decimal"
                    value={target}
                    placeholder="0.00"
                    onChange={(e) => setTarget(e.target.value)}
                  />
                </label>

                <div className="alert-direction" role="group" aria-label="Alert direction">
                  <button
                    type="button"
                    className={cn('alert-direction-btn', direction === 'above' && 'is-active')}
                    aria-pressed={direction === 'above'}
                    onClick={() => setDirection('above')}
                  >
                    Rise above
                  </button>
                  <button
                    type="button"
                    className={cn('alert-direction-btn', direction === 'below' && 'is-active')}
                    aria-pressed={direction === 'below'}
                    onClick={() => setDirection('below')}
                  >
                    Fall below
                  </button>
                </div>
              </div>

              <footer className="alert-footer">
                <button type="button" className="alert-cancel" onClick={closeModal}>
                  Cancel
                </button>
                <button type="submit" className="alert-submit" disabled={!canSubmit}>
                  Set Alert
                </button>
              </footer>
            </form>
          </div>,
          document.body,
        )}
    </>
  );
}
