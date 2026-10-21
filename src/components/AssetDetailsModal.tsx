import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Code2, ExternalLink, LockKeyhole, X } from 'lucide-react';
import { AssetIcon } from '@/components/AssetIcon';
import { PricingModal } from '@/components/PricingModal';
import { AssetChart } from '@/components/AssetChart';
import { PineScriptModal } from '@/components/PineScriptModal';
import { InsufficientDataBadge } from '@/components/InsufficientDataBadge';
import { formatPrice, getAssetClass, type Asset } from '@/lib/assets';
import { REGIME_LABELS } from '@/lib/canonicalModel';
import { formatShares, recommendPositionSize } from '@/lib/risk';
import { useCanonicalScores } from '@/hooks/useCanonicalScores';
import { getBrokerUrl } from '@/lib/tradeRouter';
import { useAuth } from '@/lib/authStore';
import { cn, closeOnBackdrop } from '@/lib/utils';

const CLOSE_MS = 260;

/** Reference account the ATR position size is quoted against. */
const REFERENCE_CAPITAL = 10_000;

const QUANT_FACTORS = [
  { label: 'Mean Reversion', source: 'RSI', score: 'rsiScore', weight: 'rsi' },
  { label: 'Momentum', source: 'MACD', score: 'momentumScore', weight: 'momentum' },
  { label: 'Volatility Regime', source: 'ATR', score: 'volatilityScore', weight: 'volatility' },
] as const;

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
      // A nested Radix layer (e.g. PricingModal) that handled this Escape has
      // already called preventDefault — let it close alone.
      if (e.key === 'Escape' && !e.defaultPrevented) close();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  // Same cached engine result the scanner row shows (undefined while loading).
  const result = useCanonicalScores([asset.ticker]).get(asset.ticker);
  const quant = result?.status === 'OK' ? result : null;
  const livePrice = asset.current_price;
  const sizing = quant
    ? recommendPositionSize({
        capital: REFERENCE_CAPITAL,
        price:
          livePrice !== null && Number.isFinite(livePrice) && livePrice > 0
            ? livePrice
            : quant.close,
        atr: quant.atr,
      })
    : null;

  return (
    <>
      {createPortal(
        <div // NOSONAR(S6819): click-to-close backdrop, not an image; Escape closes it from the keyboard
          role="presentation"
          className={cn('asset-details-overlay', closing && 'is-closing')}
          onClick={closeOnBackdrop(close)}
        >
          <div
            className={cn('asset-details-sheet', closing && 'is-closing')}
            role="dialog"
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
                  Quant Signal Breakdown
                </h4>
              </div>
              <div className="pro-feature-gate asset-quant-gate">
                <div
                  className={cn('pro-feature-content', !isPro && 'is-locked')}
                  aria-hidden={!isPro}
                >
                  {quant && (
                    <div className="quant-insight-summary">
                      <span
                        className="regime-badge"
                        data-regime={quant.regime}
                        title="Detected market regime"
                      >
                        {REGIME_LABELS[quant.regime]}
                      </span>
                      <span className="quant-breakdown-score" title="Signal Score (0–100)">
                        {quant.signal_score}
                      </span>
                    </div>
                  )}
                  {result?.status === 'INSUFFICIENT_DATA' ? (
                    <div className="quant-insight-summary">
                      <InsufficientDataBadge />
                      <p className="quant-breakdown-note">
                        The engine needs {result.required} daily candles to score {asset.ticker} and
                        has {result.received}. No score is shown rather than a guess.
                      </p>
                    </div>
                  ) : !quant ? (
                    <p className="quant-breakdown-note">Computing signal…</p>
                  ) : (
                    <>
                      <p className="quant-rationale">{quant.rationale}</p>
                      <ul className="quant-factors">
                        {QUANT_FACTORS.map((factor) => {
                          const value = quant.components[factor.score];
                          const weight = quant.components.weights[factor.weight];
                          return (
                            <li key={factor.label} className="quant-factor">
                              <span className="quant-factor-label">
                                {factor.label} <span>({factor.source})</span>
                              </span>
                              <span className="quant-factor-track" aria-hidden="true">
                                <span className="quant-factor-bar" style={{ width: `${value}%` }} />
                              </span>
                              <span className="quant-factor-value">{Math.round(value)}</span>
                              <span className="quant-factor-weight" title="Applied weight">
                                {Math.round(weight * 100)}%
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                      <p className="quant-sizing">
                        ATR position size · ${REFERENCE_CAPITAL.toLocaleString('en-US')} account, 2%
                        risk:{' '}
                        {sizing && sizing.shares > 0 ? (
                          <strong>
                            {formatShares(sizing.shares)} shares ≈ {formatPrice(sizing.notional)} ·
                            stop {formatPrice(sizing.stopPrice)}
                          </strong>
                        ) : (
                          <strong>— (no price/ATR data)</strong>
                        )}
                      </p>
                    </>
                  )}
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
          </div>
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
