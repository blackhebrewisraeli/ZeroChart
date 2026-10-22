import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, ExternalLink, X } from 'lucide-react';
import { getAssetClass, type Asset } from '@/lib/assets';
import { cn, closeOnBackdrop } from '@/lib/utils';

const CLOSE_MS = 260;

interface BrokerOption {
  id: string;
  name: string;
  metricLabel: string;
  metricValue: string;
  url: string;
}

const CRYPTO_BROKERS: BrokerOption[] = [
  {
    id: 'binance',
    name: 'Binance',
    metricLabel: 'Maker/Taker Fee',
    metricValue: '0.10%',
    url: 'https://www.binance.com/en/markets',
  },
  {
    id: 'kucoin',
    name: 'KuCoin',
    metricLabel: 'Fee',
    metricValue: '0.10%',
    url: 'https://www.kucoin.com/markets',
  },
];

const TRADFI_BROKERS: BrokerOption[] = [
  {
    id: 'etoro',
    name: 'eToro',
    metricLabel: 'Fee',
    metricValue: '0% commissions',
    url: 'https://www.etoro.com/markets',
  },
  {
    id: 'ibkr',
    name: 'Interactive Brokers',
    metricLabel: 'Latency',
    metricValue: 'Low latency',
    url: 'https://www.interactivebrokers.com/',
  },
];

export function BrokerModal({
  asset,
  variant = 'row',
}: Readonly<{
  asset: Asset;
  variant?: 'hero' | 'row';
}>) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const assetClass = getAssetClass(asset.ticker);
  const brokers = assetClass === 'Crypto' ? CRYPTO_BROKERS : TRADFI_BROKERS;

  function openModal() {
    closingRef.current = false;
    setClosing(false);
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
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeModal]);

  return (
    <>
      {variant === 'hero' ? (
        <button
          ref={triggerRef}
          type="button"
          className="trade-button trade-button-lg"
          onClick={openModal}
        >
          <ArrowUpRight size={16} /> Compare brokers
        </button>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          className="markets-trade-link"
          onClick={openModal}
          aria-label={`Compare brokers for ${asset.ticker}`}
          title={`Compare brokers for ${asset.ticker}`}
        >
          <ExternalLink size={15} />
        </button>
      )}

      {open &&
        createPortal(
          <div // NOSONAR(S6819): click-to-close backdrop, not an image; Escape closes it from the keyboard
            role="presentation"
            className={cn('broker-overlay', closing && 'is-closing')}
            onClick={closeOnBackdrop(closeModal)}
          >
            <div
              className={cn('broker-sheet', closing && 'is-closing')}
              role="dialog"
              aria-modal="true"
              aria-label={`Trade ${asset.ticker}`}
            >
              <header className="broker-header">
                <div>
                  <span className="broker-eyebrow">{assetClass}</span>
                  <h3 className="broker-title">{asset.ticker}</h3>
                </div>
                <button
                  type="button"
                  className="broker-close"
                  onClick={closeModal}
                  aria-label="Close"
                >
                  <X size={18} />
                </button>
              </header>

              <p className="broker-subtitle">Choose a broker to execute your trade.</p>

              <div className="broker-list">
                {brokers.map((broker, index) => (
                  <a
                    key={broker.id}
                    className="broker-card"
                    href={broker.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ animationDelay: `${index * 60}ms` }}
                  >
                    <div className="broker-card-copy">
                      <span className="broker-card-name">{broker.name}</span>
                      <span className="broker-card-metric">
                        {broker.metricLabel}
                        <span className="broker-card-value">{broker.metricValue}</span>
                      </span>
                    </div>
                    <span className="broker-card-cta">
                      Open <ExternalLink size={14} />
                    </span>
                  </a>
                ))}
              </div>

              <footer className="broker-footer">
                Fees are indicative and may vary by region. ZeroChart may earn a referral
                commission.
              </footer>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
