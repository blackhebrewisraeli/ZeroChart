import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { UTCTimestamp } from 'lightweight-charts';
import { ExternalLink, LineChart, LockKeyhole, X } from 'lucide-react';
import { AssetIcon } from '@/components/AssetIcon';
import { PricingModal } from '@/components/PricingModal';
import {
  CandlestickChart,
  type CandlePoint,
  type IndicatorToggles,
} from '@/components/LightweightChart';
import { formatPrice, getAssetClass, type Asset } from '@/lib/assets';
import { fetchHistoricalCandles, isBinanceCrypto, type Candle } from '@/lib/binance';
import { REGIME_LABELS } from '@/lib/multiFactor';
import { formatShares, recommendPositionSize } from '@/lib/risk';
import { scoreAsset, type ScoredAsset } from '@/lib/roboAdvisor';
import { getBrokerUrl } from '@/lib/tradeRouter';
import { useAuth } from '@/lib/authStore';
import { cn } from '@/lib/utils';

const CLOSE_MS = 260;

const INDICATOR_OPTIONS = [
  { key: 'sma50', label: 'SMA 50' },
  { key: 'sma200', label: 'SMA 200' },
  { key: 'rsi', label: 'RSI' },
] as const;

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
export function AssetDetailsModal({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const { isPro } = useAuth();
  const [pricingOpen, setPricingOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [candles, setCandles] = useState<Candle[]>([]);
  const [indicators, setIndicators] = useState<IndicatorToggles>({
    sma50: true,
    sma200: false,
    rsi: false,
  });

  function toggleIndicator(key: 'sma50' | 'sma200' | 'rsi') {
    setIndicators((prev) => ({ ...prev, [key]: !prev[key] }));
  }

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

  const [quant, setQuant] = useState<ScoredAsset | null>(null);

  useEffect(() => {
    let cancelled = false;
    setQuant(null);
    // Same pipeline as the Robo-Advisor (worker indicators for crypto, static
    // proxies otherwise); scoreAsset never rejects.
    void scoreAsset(asset).then((result) => {
      if (!cancelled) setQuant(result);
    });
    return () => {
      cancelled = true;
    };
  }, [asset]);

  const sizing =
    quant && quant.price !== null && quant.atr !== null
      ? recommendPositionSize({ capital: REFERENCE_CAPITAL, price: quant.price, atr: quant.atr })
      : null;

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

  return (
    <>
      {createPortal(
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

            {isCrypto && status === 'success' && (
              <div className="indicator-toggles" role="group" aria-label="Technical indicators">
                {INDICATOR_OPTIONS.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    className={cn('indicator-pill', indicators[option.key] && 'is-active')}
                    aria-pressed={indicators[option.key]}
                    onClick={() => toggleIndicator(option.key)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}

            <section
              className="asset-details-chart"
              aria-label={`${asset.ticker} historical chart`}
            >
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
                <CandlestickChart data={candleData} height={276} indicators={indicators} />
              )}
            </section>

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
                        data-regime={quant.breakdown.regime}
                        title="Detected market regime"
                      >
                        {REGIME_LABELS[quant.breakdown.regime]}
                      </span>
                      <span className="quant-breakdown-score" title="Multi-Factor Score (0–100)">
                        {quant.breakdown.score}
                      </span>
                    </div>
                  )}
                  {!quant ? (
                    <p className="quant-breakdown-note">Computing signal…</p>
                  ) : (
                    <>
                      <p className="quant-rationale">{quant.breakdown.rationale}</p>
                      <ul className="quant-factors">
                        {QUANT_FACTORS.map((factor) => {
                          const value = quant.breakdown.components[factor.score];
                          const weight = quant.breakdown.components.weights[factor.weight];
                          return (
                            <li key={factor.label} className="quant-factor">
                              <span className="quant-factor-label">
                                {factor.label} <span>({factor.source})</span>
                              </span>
                              <span className="quant-factor-track" aria-hidden="true">
                                <span
                                  className="quant-factor-bar"
                                  style={{ width: `${value ?? 0}%` }}
                                />
                              </span>
                              <span className="quant-factor-value">
                                {value === null ? '—' : Math.round(value)}
                              </span>
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

            <footer className="asset-details-footer">
              <span>Data: Binance public REST API · Daily candles (30 days)</span>
            </footer>
          </div>
        </div>,
        document.body,
      )}
      <PricingModal open={pricingOpen} onOpenChange={setPricingOpen} />
    </>
  );
}
