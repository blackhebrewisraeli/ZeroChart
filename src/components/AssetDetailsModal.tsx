import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { UTCTimestamp } from 'lightweight-charts';
import { LineChart, X } from 'lucide-react';
import { AssetIcon } from '@/components/AssetIcon';
import { CandlestickChart, type CandlePoint } from '@/components/LightweightChart';
import { formatPrice, getAssetClass, type Asset } from '@/lib/assets';
import { fetchHistoricalCandles, isBinanceCrypto, type Candle } from '@/lib/binance';
import { cn } from '@/lib/utils';

const CLOSE_MS = 260;

/**
 * A modal shown when a user clicks a row in the Markets table. It fetches daily
 * historical candles from Binance (crypto only) and renders a gradient area
 * chart, falling back gracefully for stocks and forex.
 */
export function AssetDetailsModal({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const [closing, setClosing] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [candles, setCandles] = useState<Candle[]>([]);

  const closingRef = useRef(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const closeRef = useRef<HTMLButtonElement>(null);

  const isCrypto = isBinanceCrypto(asset.ticker);
  const assetClass = getAssetClass(asset.ticker);

  const close = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    closeTimer.current = window.setTimeout(() => onClose(), CLOSE_MS);
  }, [onClose]);

  useEffect(
    () => () => {
      if (closeTimer.current) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  useEffect(() => {
    closeRef.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  useEffect(() => {
    if (!isCrypto) {
      setStatus('idle');
      setCandles([]);
      return;
    }
    let cancelled = false;
    setStatus('loading');
    fetchHistoricalCandles(asset.ticker)
      .then((data) => {
        if (cancelled) return;
        setCandles(data);
        setStatus('success');
      })
      .catch(() => {
        if (cancelled) return;
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [asset.ticker, isCrypto]);

  const candleData = useMemo<CandlePoint[]>(
    () =>
      candles.map((candle) => ({
        time: Math.floor(candle.timestamp / 1000) as UTCTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      })),
    [candles],
  );

  return createPortal(
    <div className={cn('asset-details-overlay', closing && 'is-closing')} onClick={close}>
      <div
        className={cn('asset-details-sheet', closing && 'is-closing')}
        role="dialog"
        aria-modal="true"
        aria-label={`${asset.ticker} details`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="asset-details-header">
          <div className="asset-details-title">
            <AssetIcon symbol={asset.ticker} name={asset.name} size="lg" />
            <div>
              <span className="asset-details-eyebrow">{assetClass}</span>
              <h3 className="asset-details-name">{asset.ticker}</h3>
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="asset-details-close"
            onClick={close}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </header>

        <div className="asset-details-price">
          <span className="asset-details-price-label">Current price</span>
          <span className="asset-details-price-value">{formatPrice(asset.current_price)}</span>
        </div>

        <section className="asset-details-chart" aria-label={`${asset.ticker} historical chart`}>
          {!isCrypto ? (
            <div className="asset-chart-fallback">
              <LineChart size={22} />
              <span>Historical charts are available for crypto assets.</span>
            </div>
          ) : status === 'loading' ? (
            <div className="asset-chart-fallback">Loading historical data…</div>
          ) : status === 'error' ? (
            <div className="asset-chart-fallback">
              <LineChart size={22} />
              <span>Couldn't load chart data. Please try again.</span>
            </div>
          ) : (
            <CandlestickChart data={candleData} height={276} />
          )}
        </section>

        <footer className="asset-details-footer">
          <span>Data: Binance public REST API · Daily candles (30 days)</span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
