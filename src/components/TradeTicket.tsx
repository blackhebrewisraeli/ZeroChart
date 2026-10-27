import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { X, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { AssetIcon } from '@/components/AssetIcon';
import { formatPrice, getAssetClass, type Asset } from '@/lib/assets';
import { usePortfolio, type PortfolioType } from '@/lib/portfolioStore';
import {
  heldShares,
  LEDGER_NAMES,
  type CorePortfolioType,
  type TradeIntent,
} from '@/lib/portfolioAccounting';
import { usePaperRisk } from '@/hooks/usePaperRisk';
import { checkSell, formatShares } from '@/lib/risk';
import { usePriceFlash } from '@/hooks/usePriceFlash';
import { useLivePrice } from '@/lib/livePriceStore';
import { toBinanceSymbol } from '@/lib/ticker';
import { cn } from '@/lib/utils';

export const FEE_RATE = 0.0025; // 0.25% network fee, also charged on simulated closes
const SPRING = { type: 'spring' as const, stiffness: 320, damping: 30 };

type Side = 'buy' | 'sell';

/** What a USD amount buys or sells at `price`: units, the 0.25% fee, and the cash it moves. */
function orderEstimate(amount: number, price: number | null | undefined, side: Side) {
  if (!(Number.isFinite(amount) && amount > 0 && price != null && price > 0)) {
    return { canSubmit: false, estimatedQty: 0, fee: 0, total: 0 };
  }
  const fee = amount * FEE_RATE;
  return {
    canSubmit: true,
    estimatedQty: amount / price,
    fee,
    total: side === 'buy' ? amount + fee : amount - fee,
  };
}

/** What the ticket's fill does, by the ledger it books to (none: a mock). */
function ticketFootnote(portfolioType: PortfolioType | undefined): string {
  if (portfolioType === undefined) {
    return 'Mock execution — no real funds move. Slippage controls ship with the broker integration.';
  }
  if (portfolioType === 'real_tracking') {
    return 'Recorded in your Live Tracking ledger and cash at the live price. ZeroChart places no real orders — log trades you made at your broker.';
  }
  return `Simulated fill at the live price, recorded in your ${LEDGER_NAMES[portfolioType]} ledger. No real funds move.`;
}

export function TradeTicket({
  asset,
  variant = 'compact',
  portfolioType,
  intent = 'tactical',
  initialSide = 'buy',
  initialAmount,
  label,
}: Readonly<{
  asset: Asset;
  variant?: 'hero' | 'compact';
  /** Ledger that records fills (the active one). Omitted: mock execution only. */
  portfolioType?: PortfolioType;
  /** Core rebalance or Lab tactical trade — tagged on the recorded transaction. */
  intent?: TradeIntent;
  initialSide?: Side;
  /** Prefilled USD order amount, e.g. the size of a rebalance trade. */
  initialAmount?: number;
  /** Compact trigger text; defaults to "Trade". */
  label?: string;
}>) {
  const { executeBuy, executeSell, executePaperTrade, portfolios } = usePortfolio();
  const recordsFills = portfolioType !== undefined;
  const isPaper = portfolioType === 'paper_trading';
  const paperRisk = usePaperRisk(isPaper ? asset.ticker : undefined);
  const [open, setOpen] = useState(false);
  /** A paper fill is in flight to the server. */
  const [booking, setBooking] = useState(false);
  // The same, for a second press that lands before `booking` re-renders.
  const bookingRef = useRef(false);
  const [mounted, setMounted] = useState(false);
  const [side, setSide] = useState<Side>('buy');
  const [amount, setAmount] = useState('');

  const amountRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Fill at the streamed tick when there is one, wherever the ticket opens.
  const price = useLivePrice(toBinanceSymbol(asset.ticker))?.price ?? asset.current_price;
  const priceFlash = usePriceFlash(price);
  const assetClass = getAssetClass(asset.ticker);

  const numericAmount = Number(amount);
  const { canSubmit, estimatedQty, fee, total } = orderEstimate(numericAmount, price, side);
  const rejection = paperCheck();

  useEffect(() => {
    setMounted(true);
  }, []);

  function openTicket() {
    setSide(initialSide);
    setAmount(initialAmount ? initialAmount.toFixed(2) : '');
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

  /** Books a Paper Trading fill on the server. */
  async function bookPaperFill(shares: number, fillPrice: number) {
    bookingRef.current = true;
    setBooking(true);
    const result = await executePaperTrade({
      side,
      ticker: asset.ticker,
      shares,
      price: fillPrice,
      fee,
    });
    bookingRef.current = false;
    setBooking(false);
    return result;
  }

  /** Records a fill in a Core ledger, synchronously. */
  function bookCoreFill(type: CorePortfolioType, shares: number, fillPrice: number) {
    const input = {
      ticker: asset.ticker,
      shares,
      price: fillPrice,
      fee,
      timestamp: new Date().toISOString(),
      intent,
    };
    return side === 'buy'
      ? // Every ledger's cash moves with its fills, Live Tracking's included:
        // it mirrors the broker cash a real trade spends or frees.
        executeBuy(type, {
          ...input,
          requireCash: true,
          ...(asset.name ? { name: asset.name } : {}),
        })
      : executeSell(type, input);
  }

  /** Shares the order fills, snapped to the holding when selling it all. */
  function fillShares(type: PortfolioType, fillPrice: number): number {
    const held = heldShares(portfolios[type], asset.ticker);
    const orderShares = numericAmount / fillPrice;
    // A cent-rounded "sell everything" amount can overshoot the holding by dust.
    return side === 'sell' && Math.abs(orderShares - held) * fillPrice < 0.01 ? held : orderShares;
  }

  /**
   * Why a Paper Trading order can't book, shown before it is sent: a BUY must
   * clear the portfolio risk manager, a SELL can't exceed the holding. The
   * server checks both again.
   */
  function paperCheck(): string | null {
    if (!isPaper || !canSubmit || price == null) return null;
    const check =
      side === 'buy'
        ? paperRisk.checkBuy(asset.ticker, { shares: estimatedQty, price, fee })
        : checkSell(
            portfolios.paper_trading,
            asset.ticker,
            fillShares('paper_trading', price),
            price,
          );
    return check.ok ? null : check.reason;
  }

  async function handleSubmit() {
    if (!canSubmit || price == null || bookingRef.current || rejection) return;
    if (recordsFills) {
      const shares = fillShares(portfolioType, price);
      const result =
        portfolioType === 'paper_trading'
          ? await bookPaperFill(shares, price)
          : bookCoreFill(portfolioType, shares, price);
      if (!result.ok) {
        toast.error(result.error ?? 'Order rejected');
        return;
      }
      // The units booked, which the ticket only estimated.
      toast.success(`${side === 'buy' ? 'Bought' : 'Sold'} ${asset.ticker}`, {
        description: `${formatShares(shares)} ${asset.ticker} (${formatPrice(numericAmount)}) at ${formatPrice(
          price,
        )} · fee ${formatPrice(fee)} — recorded in your ${LEDGER_NAMES[portfolioType]} ledger.`,
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
          <Zap size={15} /> {label ?? 'Trade'}
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
                      <span className="ticket-eyebrow">
                        {assetClass} ·{' '}
                        {intent === 'rebalance' ? 'Core rebalance' : 'Tactical trade'}
                      </span>
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
                    <fieldset className="ticket-side" aria-label="Order side">
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
                    </fieldset>

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
                        {/* Already marked as an estimate: one ≈ is enough. */}≈{' '}
                        {estimatedQty > 0 ? formatShares(estimatedQty).replace('≈', '') : '0'}{' '}
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
                      disabled={!canSubmit || booking || rejection !== null}
                      aria-describedby={rejection ? 'ticket-rejection' : undefined}
                      onClick={() => void handleSubmit()}
                    >
                      {side === 'buy' ? 'Buy' : 'Sell'} {asset.ticker}
                    </button>
                    {rejection && (
                      <p id="ticket-rejection" className="ticket-rejection">
                        {rejection}
                      </p>
                    )}

                    <p className="ticket-footnote">{ticketFootnote(portfolioType)}</p>
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
