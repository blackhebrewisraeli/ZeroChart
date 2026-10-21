import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Plus, X } from 'lucide-react';
import type { Position } from '@/lib/portfolioManager';
import { usePortfolio } from '@/lib/portfolioStore';
import { cn, closeOnBackdrop } from '@/lib/utils';

const CLOSE_MS = 260;

export function AddPositionModal() {
  const { addPositions } = usePortfolio();
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [ticker, setTicker] = useState('');
  const [buyPrice, setBuyPrice] = useState('');
  const [quantity, setQuantity] = useState('');
  const [error, setError] = useState<string | null>(null);

  const closingRef = useRef(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tickerRef = useRef<HTMLInputElement>(null);

  function openModal() {
    closingRef.current = false;
    setClosing(false);
    setError(null);
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
    const focusTimer = window.setTimeout(() => tickerRef.current?.focus(), 140);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.clearTimeout(focusTimer);
    };
  }, [open, closeModal]);

  function resetForm() {
    setTicker('');
    setBuyPrice('');
    setQuantity('');
    setError(null);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const symbol = ticker.trim().toUpperCase();
    const price = Number(buyPrice);
    const qty = Number(quantity);

    if (!symbol || !Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty <= 0) {
      setError('Enter a valid ticker, a buy price, and a quantity greater than zero.');
      return;
    }

    const position: Position = {
      id: `live-${symbol.toLowerCase()}-${Date.now()}`,
      ticker: symbol,
      buyPrice: price,
      shares: qty,
      isSimulation: false,
      dateAdded: new Date().toISOString().slice(0, 10),
    };

    addPositions([position]);
    resetForm();
    closeModal();
  }

  return (
    <>
      <button ref={triggerRef} type="button" className="add-position-button" onClick={openModal}>
        <Plus size={16} /> Add Position
      </button>

      {open &&
        createPortal(
          <div
            role="presentation"
            className={cn('position-overlay', closing && 'is-closing')}
            onClick={closeOnBackdrop(closeModal)}
          >
            <form
              className={cn('position-sheet', closing && 'is-closing')}
              role="dialog"
              aria-modal="true"
              aria-label="Add live position"
              onSubmit={handleSubmit}
            >
              <header className="position-header">
                <div>
                  <span className="position-eyebrow">Live Tracking</span>
                  <h3 className="position-title">Add a position</h3>
                </div>
                <button
                  type="button"
                  className="position-close"
                  onClick={closeModal}
                  aria-label="Close"
                >
                  <X size={18} />
                </button>
              </header>

              <div className="position-body">
                <label className="position-field">
                  <span className="position-label">Ticker</span>
                  <input
                    ref={tickerRef}
                    className="position-input"
                    type="text"
                    value={ticker}
                    placeholder="e.g. NVDA"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => setTicker(e.target.value.toUpperCase())}
                  />
                </label>

                <div className="position-row">
                  <label className="position-field">
                    <span className="position-label">Buy Price ($)</span>
                    <input
                      className="position-input"
                      type="number"
                      min="0"
                      step="any"
                      inputMode="decimal"
                      value={buyPrice}
                      placeholder="0.00"
                      onChange={(e) => setBuyPrice(e.target.value)}
                    />
                  </label>
                  <label className="position-field">
                    <span className="position-label">Quantity</span>
                    <input
                      className="position-input"
                      type="number"
                      min="0"
                      step="any"
                      inputMode="decimal"
                      value={quantity}
                      placeholder="Shares / Coins"
                      onChange={(e) => setQuantity(e.target.value)}
                    />
                  </label>
                </div>

                {error && <p className="position-error">{error}</p>}
              </div>

              <footer className="position-footer">
                <button type="button" className="position-cancel" onClick={closeModal}>
                  Cancel
                </button>
                <button type="submit" className="position-submit">
                  Save Position
                </button>
              </footer>
            </form>
          </div>,
          document.body,
        )}
    </>
  );
}
