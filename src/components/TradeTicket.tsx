import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { X, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { AssetIcon } from '@/components/AssetIcon';
import { formatPrice, getAssetClass, type Asset } from '@/lib/assets';
import { usePortfolio, type PortfolioType } from '@/lib/portfolioStore';
import { usePriceFlash } from '@/hooks/usePriceFlash';
import { cn } from '@/lib/utils';

export const FEE_RATE = 0.0025; // 0.25% network fee, also charged on simulated closes
const SPRING = { type: 'spring' as const, stiffness: 320, damping: 30 };

type Side = 'buy' | 'sell';

export function TradeTicket({
  asset,
  variant = 'compact',
  portfolioType,
}: {
  asset: Asset;
  variant?: 'hero' | 'compact';
  /** Ledger that records fills. Omitted or real_tracking: mock execution only. */
  portfolioType?: PortfolioType;
}) {
  const { executeBuy, executeSell } = usePortfolio();
  // Recording trades that never happened in a real tracker is a product call,
  // so only simulated portfolios get ledger fills.
  const recordsFills = portfolioType !== undefined && portfolioType !== 'real_tracking';
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [side, setSide] = useState<Side>('buy');
  const [amount, setAmount] = useState('');

  const amountRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const price = asset.current_price;
  const priceFlash = usePriceFlash(price);
  const assetClass = getAssetClass(asset.ticker);

  const numericAmount = Number(amount);
  const canSubmit =
    Number.isFinite(numericAmount) && numericAmount > 0 && price != null && price > 0;
  const estimatedQty = canSubmit ? numericAmount / price : 0;
  const fee = canSubmit ? numericAmount * FEE_RATE : 0;
  const total = canSubmit ? numericAmount + (side === 'buy' ? fee : -fee) : 0;

  useEffect(() => {
    setMounted(true);
  }, []);

  function openTicket() {
    setSide('buy');
    setAmount('');
    setOpen(true);
  }

  function close() {
    setOpen(false);
  }

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
    const focusTimer = window.setTimeout(() => amountRef.current?.focus(), 200);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.clearTimeout(focusTimer);
    };
  }, [open]);

  function handleSubmit() {
    if (!canSubmit) return;
    if (recordsFills) {
      const input = {
        ticker: asset.ticker,
        shares: numericAmount / price,
        price,
        fee,
        timestamp: new Date().toISOString(),
      };
      const result =
        side === 'buy'
          ? executeBuy(portfolioType, { ...input, ...(asset.name ? { name: asset.name } : {}) })
          : executeSell(portfolioType, input);
      if (!result.ok) {
        toast.error(result.error ?? 'Order rejected');
        return;
      }
      toast.success(`${side === 'buy' ? 'Bought' : 'Sold'} ${asset.ticker}`, {
        description: `${formatPrice(numericAmount)} at ${formatPrice(price)} · fee ${formatPrice(
          fee,
        )} — simulated fill, recorded in the ledger.`,
      });
    } else {
      toast.success(`${side === 'buy' ? 'Buy' : 'Sell'} order submitted`, {
        description: `${asset.ticker} · ${formatPrice(numericAmount)} (${
          side === 'buy' ? 'market buy' : 'market sell'
        }) — mock execution, no real funds.`,
      });
    }
    close();
    triggerRef.current?.focus();
  }

  return (
    <>
      {variant === 'hero' ? (
        <button
          ref={triggerRef}
          type="button"
          className="ticket-trigger ticket-trigger-hero"
          onClick={openTicket}
        >
          <Zap size={16} /> Trade {asset.ticker}
        </button>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          className="ticket-trigger ticket-trigger-compact"
          onClick={openTicket}
        >
          <Zap size={15} /> Trade
        </button>
      )}

      {mounted &&
        createPortal(
          <AnimatePresence>
            {open && (
              <motion.div
                key="ticket-overlay"
                className="ticket-overlay"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                onClick={close}
              >
                <motion.aside
                  className="ticket-sheet"
                  role="dialog"
                  aria-modal="true"
                  aria-label={`Trade ${asset.ticker}`}
                  initial={{ x: '100%' }}
                  animate={{ x: 0 }}
                  exit={{ x: '100%' }}
                  transition={SPRING}
                  onClick={(e) => e.stopPropagation()}
                >
                  <header className="ticket-header">
                    <div>
                      <span className="ticket-eyebrow">{assetClass} · Quick trade</span>
                      <div className="ticket-title">
                        <span className="ticket-title-asset">
                          <AssetIcon symbol={asset.ticker} name={asset.name} size="lg" />
                          <span>{asset.ticker}</span>
                        </span>
                        <span className={cn('ticket-price', priceFlash)}>{formatPrice(price)}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="ticket-close"
                      onClick={close}
                      aria-label="Close"
                    >
                      <X size={18} />
                    </button>
                  </header>
                  <p className="ticket-name">{asset.name || 'Asset'}</p>

                  <div className="ticket-body">
                    <div className="ticket-side" role="group" aria-label="Order side">
                      <button
                        type="button"
                        aria-pressed={side === 'buy'}
                        className={cn('ticket-side-btn', side === 'buy' && 'is-active-buy')}
                        onClick={() => setSide('buy')}
                      >
                        Buy
                      </button>
                      <button
                        type="button"
                        aria-pressed={side === 'sell'}
                        className={cn('ticket-side-btn', side === 'sell' && 'is-active-sell')}
                        onClick={() => setSide('sell')}
                      >
                        Sell
                      </button>
                    </div>

                    <div className="ticket-field">
                      <label className="ticket-label" htmlFor="ticket-amount">
                        Order amount (USD)
                      </label>
                      <div className="ticket-input-wrap">
                        <span className="ticket-input-prefix">$</span>
                        <input
                          id="ticket-amount"
                          ref={amountRef}
                          className="ticket-input"
                          type="number"
                          min="0"
                          step="any"
                          inputMode="decimal"
                          placeholder="0.00"
                          value={amount}
                          onChange={(e) => setAmount(e.target.value)}
                        />
                      </div>
                      <span className="ticket-hint">
                        ≈{' '}
                        {estimatedQty > 0
                          ? estimatedQty.toLocaleString(undefined, { maximumFractionDigits: 6 })
                          : '0'}{' '}
                        {asset.ticker}
                      </span>
                    </div>

                    <div className="ticket-summary">
                      <div className="ticket-summary-row">
                        <span className="ticket-summary-label">Est. Price</span>
                        <span className="ticket-summary-value">{formatPrice(price)}</span>
                      </div>
                      <div className="ticket-summary-row">
                        <span className="ticket-summary-label">Network Fee</span>
                        <span className="ticket-summary-value">{formatPrice(fee)}</span>
                      </div>
                      <div className="ticket-summary-row ticket-summary-total">
                        <span className="ticket-summary-label">Total</span>
                        <span className="ticket-summary-value">{formatPrice(total)}</span>
                      </div>
                    </div>

                    <button
                      type="button"
                      className={cn(
                        'ticket-submit',
                        side === 'buy' ? 'ticket-submit-buy' : 'ticket-submit-sell',
                      )}
                      disabled={!canSubmit}
                      onClick={handleSubmit}
                    >
                      {side === 'buy' ? 'Buy' : 'Sell'} {asset.ticker}
                    </button>

                    <p className="ticket-footnote">
                      {recordsFills
                        ? 'Simulated fill at the live price, recorded in your Simulation ledger. No real funds move.'
                        : 'Mock execution — no real funds move. Slippage controls ship with the broker integration.'}
                    </p>
                  </div>
                </motion.aside>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </>
  );
}
