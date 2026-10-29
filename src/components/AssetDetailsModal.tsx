import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Code2, ExternalLink, LockKeyhole, X } from 'lucide-react';
import { AssetIcon } from '@/components/AssetIcon';
import { PricingModal } from '@/components/PricingModal';
import { AssetChart } from '@/components/AssetChart';
import { PineScriptModal } from '@/components/PineScriptModal';
import { NoScoreBadge } from '@/components/NoScoreBadge';
import { FactorBars } from '@/components/ScanReview';
import { formatPrice, getAssetClass, type Asset } from '@/lib/assets';
import { REGIME_LABELS, type CanonicalResult, type CanonicalScore } from '@/lib/canonicalModel';
import { formatShares, recommendPositionSize } from '@/lib/risk';
import { useCanonicalScores } from '@/hooks/useCanonicalScores';
import { getBrokerUrl } from '@/lib/tradeRouter';
import { useAuth } from '@/lib/authStore';
import { cn, closeOnBackdrop } from '@/lib/utils';
import { containDialogTab } from '@/lib/dialogFocus';

const CLOSE_MS = 260;

/** Reference account the ATR position size is quoted against. */
const REFERENCE_CAPITAL = 10_000;

/** Why the engine has no score for an asset, in one or two sentences. */
function noScoreNote(ticker: string, result: Exclude<CanonicalResult, CanonicalScore>): string {
  switch (result.status) {
    case 'INSUFFICIENT_DATA':
      return `The engine needs ${result.required} daily candles to score ${ticker} and has ${result.received}. No score is shown rather than a guess.`;
    case 'UNSUPPORTED':
      return `${result.detail} ${ticker} was not scored.`;
    case 'FETCH_FAILED':
      return `Candle history for ${ticker} failed to load (${result.detail}), so it was not scored.`;
    case 'STALE_DATA':
      return `The latest closed candle for ${ticker} is stale, so it was not scored.`;
    case 'DATA_INVALID':
      return `Candle history for ${ticker} failed validation, so it was not scored.`;
  }
}

/**
 * The engine's verdict on one asset: regime, score, factor breakdown and ATR
 * size once scored, else why there is no score.
 */
function QuantDetails({
  ticker,
  result,
  livePrice,
}: Readonly<{ ticker: string; result: CanonicalResult | undefined; livePrice: number | null }>) {
  if (result === undefined) {
    return <p className="quant-breakdown-note">Computing signal…</p>;
  }
  if (result.status !== 'OK') {
    return (
      <div className="quant-insight-summary">
        <NoScoreBadge status={result.status} />
        <p className="quant-breakdown-note">{noScoreNote(ticker, result)}</p>
      </div>
    );
  }
  const hasLivePrice = livePrice !== null && Number.isFinite(livePrice) && livePrice > 0;
  const sizing = recommendPositionSize({
    capital: REFERENCE_CAPITAL,
    price: hasLivePrice ? livePrice : result.close,
    atr: result.atr,
  });
  return (
    <>
      <div className="quant-insight-summary">
        <span className="regime-badge" data-regime={result.regime} title="Detected market regime">
          {REGIME_LABELS[result.regime]}
        </span>
        <span className="quant-breakdown-score" title="Signal Score (0–100)">
          {result.signal_score}
        </span>
      </div>
      <p className="quant-rationale">{result.rationale}</p>
      <FactorBars model={result} />
      <p className="quant-sizing">
        ATR position size · ${REFERENCE_CAPITAL.toLocaleString('en-US')} account, 2% risk:{' '}
        {sizing.shares > 0 ? (
          <strong>
            {formatShares(sizing.shares)} shares ≈ {formatPrice(sizing.notional)} · stop{' '}
            {formatPrice(sizing.stopPrice)}
          </strong>
        ) : (
          <strong>— (no price/ATR data)</strong>
        )}
      </p>
    </>
  );
}

/**
 * A modal shown when a user clicks a row in the Markets table. It fetches daily
 * historical candles from Binance (crypto only) and renders a gradient area
 * chart, falling back gracefully for stocks and forex.
 */
export function AssetDetailsModal({
  asset,
  onClose,
  portfolioCapital,
}: Readonly<{
  asset: Asset;
  onClose: () => void;
  /** Active portfolio equity; Pro exports pre-fill it into the Pine Script. */
  portfolioCapital?: number;
}>) {
  const { isPro } = useAuth();
  const [pricingOpen, setPricingOpen] = useState(false);
  const [pineOpen, setPineOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
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
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
      returnFocusRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // A nested Radix layer (e.g. PricingModal) that handled this Escape has
      // already called preventDefault — let it close alone.
      if (e.key === 'Escape' && !e.defaultPrevented) close();
      containDialogTab(e, dialogRef.current);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  // Same cached engine result the scanner row shows (undefined while loading).
  const result = useCanonicalScores([asset.ticker]).get(asset.ticker);

  return (
    <>
      {createPortal(
        <div // NOSONAR(S6819): click-to-close backdrop, not an image; Escape closes it from the keyboard
          role="presentation"
          className={cn('asset-details-overlay', closing && 'is-closing')}
          onClick={closeOnBackdrop(close)}
        >
          <dialog
            ref={dialogRef}
            open
            className={cn('asset-details-sheet', closing && 'is-closing')}
            aria-modal="true"
            aria-label={`${asset.ticker} details`}
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
              {assetClass !== 'Forex' && (
                <a
                  className="trade-now-button"
                  href={getBrokerUrl(asset.ticker, assetClass === 'Crypto' ? 'crypto' : 'stock')}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink size={15} /> Trade Now
                </a>
              )}
            </div>

            <AssetChart
              ticker={asset.ticker}
              actions={
                <button
                  type="button"
                  className="pine-export-button"
                  onClick={() => setPineOpen(true)}
                >
                  <Code2 size={14} /> TradingView Indicator
                </button>
              }
            />

            <section className="quant-breakdown" aria-labelledby="quant-breakdown-title">
              <div className="quant-breakdown-head">
                <h4 id="quant-breakdown-title" className="quant-breakdown-title">
                  Model Signal Score
                </h4>
                <p className="quant-breakdown-note">
                  A 0–100 ranking from RSI, MACD and ATR. It is not a probability or return
                  forecast.
                </p>
              </div>
              <div className="pro-feature-gate asset-quant-gate">
                <div
                  className={cn('pro-feature-content', !isPro && 'is-locked')}
                  aria-hidden={!isPro}
                >
                  <QuantDetails
                    ticker={asset.ticker}
                    result={result}
                    livePrice={asset.current_price}
                  />
                </div>
                {!isPro && (
                  <button
                    type="button"
                    className="pro-feature-unlock"
                    onClick={() => setPricingOpen(true)}
                  >
                    <LockKeyhole size={14} /> Upgrade to unlock Quant Insights
                  </button>
                )}
              </div>
            </section>
          </dialog>
        </div>,
        document.body,
      )}
      <PricingModal open={pricingOpen} onOpenChange={setPricingOpen} />
      <PineScriptModal
        open={pineOpen}
        onOpenChange={setPineOpen}
        capital={isPro ? (portfolioCapital ?? null) : null}
      />
    </>
  );
}
