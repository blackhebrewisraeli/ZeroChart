import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  ExternalLink,
  Gauge,
  RefreshCw,
  Rocket,
  Shield,
  X,
} from 'lucide-react';
import { calculateSignalScore, formatPrice, type Asset } from '@/lib/assets';
import { type Allocation, type RiskProfile } from '@/lib/portfolioBuilder';
import { buildQuantPortfolio } from '@/lib/roboAdvisor';
import { ANNUAL_RETURN_BY_RISK, projectWealth } from '@/lib/dca';
import { type Position } from '@/lib/portfolioManager';
import { usePortfolio } from '@/lib/portfolioStore';
import { isBinanceCrypto } from '@/lib/binance';
import { getBrokerUrl } from '@/lib/tradeRouter';
import { cn } from '@/lib/utils';

const RISK_OPTIONS: {
  id: RiskProfile;
  label: string;
  description: string;
  holdings: number;
  Icon: typeof Shield;
}[] = [
  {
    id: 'conservative',
    label: 'Conservative',
    description: 'Broad, defensive spread',
    holdings: 8,
    Icon: Shield,
  },
  {
    id: 'moderate',
    label: 'Moderate',
    description: 'Balanced risk & growth',
    holdings: 5,
    Icon: Gauge,
  },
  {
    id: 'aggressive',
    label: 'Aggressive',
    description: 'Concentrated upside',
    holdings: 3,
    Icon: Rocket,
  },
];

const CLOSE_MS = 300;

function formatWeight(weight: number) {
  return `${(weight * 100).toFixed(1)}%`;
}

function scoreTone(score: number | null) {
  if (score === null) return '';
  return score > 85 ? 'score-high' : score >= 70 ? 'score-mid' : 'score-low';
}

export function RoboAdvisor({ assets, onInvest }: { assets: Asset[]; onInvest?: () => void }) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [phase, setPhase] = useState<'config' | 'results'>('config');
  const [amount, setAmount] = useState('10000');
  const [riskProfile, setRiskProfile] = useState<RiskProfile>('moderate');
  const [result, setResult] = useState<Allocation[] | null>(null);
  const [total, setTotal] = useState(0);
  const [rejectedTickers, setRejectedTickers] = useState<Set<string>>(new Set());
  const [monthlyDeposit, setMonthlyDeposit] = useState('250');
  const [monthly, setMonthly] = useState(250);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closingRef = useRef(false);
  const closeTimer = useRef<number | undefined>(undefined);

  const assetByTicker = useMemo(() => new Map(assets.map((a) => [a.ticker, a])), [assets]);
  const { addPositions } = usePortfolio();

  const topAllocation =
    result && result.length > 0
      ? ([...result].sort((a, b) => b.weight - a.weight)[0] ?? null)
      : null;

  function openModal() {
    closingRef.current = false;
    setClosing(false);
    setPhase('config');
    setResult(null);
    setRejectedTickers(new Set());
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
    const focusTimer = window.setTimeout(() => {
      if (phase === 'config') inputRef.current?.focus();
    }, 140);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.clearTimeout(focusTimer);
    };
  }, [open, phase, closeModal]);

  async function handleSubmit() {
    const value = Number(amount.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(value) || value <= 0) {
      setError('Enter an investment amount greater than $0.');
      return;
    }
    const monthlyRaw = monthlyDeposit.replace(/[^0-9.]/g, '');
    const monthlyValue = monthlyRaw === '' ? 0 : Number(monthlyRaw);
    if (!Number.isFinite(monthlyValue) || monthlyValue < 0) {
      setError('Enter a valid monthly deposit.');
      return;
    }
    setError(null);
    setTotal(value);
    setMonthly(monthlyValue);
    setRejectedTickers(new Set());
    setBuilding(true);
    try {
      const allocation = await buildQuantPortfolio({
        preferences: { totalCapital: value, riskProfile },
        availableAssets: assets,
      });
      setResult(allocation);
      setPhase('results');
    } catch {
      setError('Unable to analyze assets. Please try again.');
    } finally {
      setBuilding(false);
    }
  }

  async function handleSwap(ticker: string) {
    const nextRejected = new Set(rejectedTickers);
    nextRejected.add(ticker);
    setRejectedTickers(nextRejected);
    setBuilding(true);
    try {
      const allocation = await buildQuantPortfolio({
        preferences: { totalCapital: total, riskProfile },
        availableAssets: assets,
        excludeTickers: nextRejected,
      });
      setResult(allocation);
    } finally {
      setBuilding(false);
    }
  }

  function handleConfirmInvest() {
    if (closingRef.current || !result || result.length === 0) return;

    const now = new Date();
    const dateAdded = now.toISOString().slice(0, 10);
    const positions: Position[] = [];

    result.forEach((allocation, index) => {
      const asset = assetByTicker.get(allocation.ticker);
      const price = asset?.current_price;
      if (price === null || price === undefined || !Number.isFinite(price) || price <= 0) return;

      positions.push({
        id: `robo-${allocation.ticker.toLowerCase()}-${now.getTime()}-${index}`,
        ticker: allocation.ticker,
        buyPrice: price,
        shares: Number((allocation.allocatedAmount / price).toFixed(4)),
        isSimulation: true,
        dateAdded,
      });
    });

    if (positions.length > 0) {
      addPositions(positions);
    }

    closeModal();
    if (onInvest) {
      window.setTimeout(onInvest, CLOSE_MS);
    }
  }

  const activeRisk = RISK_OPTIONS.find((r) => r.id === riskProfile);

  const canSwapMore =
    result != null &&
    assets.some(
      (asset) =>
        !rejectedTickers.has(asset.ticker) &&
        !result.some((allocation) => allocation.ticker === asset.ticker),
    );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="robo-trigger"
        data-tour="robo"
        onClick={openModal}
        aria-haspopup="dialog"
      >
        <Bot size={16} />
        <span>Build Portfolio</span>
      </button>

      {open &&
        createPortal(
          <div className={cn('robo-overlay', closing && 'is-closing')} onClick={closeModal}>
            <div
              className={cn('robo-panel', closing && 'is-closing')}
              role="dialog"
              aria-modal="true"
              aria-labelledby="robo-title"
              onClick={(e) => e.stopPropagation()}
            >
              <header className="robo-header">
                <div className="robo-brand">
                  <span className="robo-brand-icon">
                    <Bot size={18} />
                  </span>
                  <div>
                    <h2 id="robo-title" className="robo-title">
                      Robo-Advisor
                    </h2>
                    <p className="robo-subtitle">Automated portfolio builder</p>
                  </div>
                </div>
                <button
                  type="button"
                  className="robo-close"
                  onClick={closeModal}
                  aria-label="Close"
                >
                  <X size={18} />
                </button>
              </header>

              {phase === 'config' ? (
                <>
                  <div className="robo-body">
                    <div className="robo-field">
                      <label htmlFor="robo-amount" className="robo-label">
                        Investment amount
                      </label>
                      <div className={cn('robo-amount-field', error && 'robo-amount-invalid')}>
                        <span className="robo-currency">$</span>
                        <input
                          id="robo-amount"
                          ref={inputRef}
                          className="robo-input"
                          type="text"
                          inputMode="decimal"
                          autoComplete="off"
                          value={amount}
                          onChange={(e) => setAmount(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSubmit();
                          }}
                          placeholder="10,000"
                          aria-invalid={!!error}
                          aria-describedby="robo-amount-hint"
                        />
                      </div>
                      <p id="robo-amount-hint" className="robo-hint">
                        Quant-scored across trend, RSI, and volatility
                      </p>
                      {error && (
                        <p className="robo-error" role="alert">
                          {error}
                        </p>
                      )}
                    </div>

                    <div className="robo-field">
                      <label htmlFor="robo-monthly" className="robo-label">
                        Monthly deposit (optional)
                      </label>
                      <div className="robo-amount-field">
                        <span className="robo-currency">$</span>
                        <input
                          id="robo-monthly"
                          className="robo-input"
                          type="text"
                          inputMode="decimal"
                          autoComplete="off"
                          value={monthlyDeposit}
                          onChange={(e) => setMonthlyDeposit(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSubmit();
                          }}
                          placeholder="250"
                        />
                      </div>
                      <p className="robo-hint">Recurring contributions that compound over time</p>
                    </div>

                    <div className="robo-field">
                      <span className="robo-label" id="robo-risk-label">
                        Risk profile
                      </span>
                      <div
                        className="robo-risk-grid"
                        role="radiogroup"
                        aria-labelledby="robo-risk-label"
                      >
                        {RISK_OPTIONS.map((option) => {
                          const selected = riskProfile === option.id;
                          return (
                            <button
                              key={option.id}
                              type="button"
                              role="radio"
                              aria-checked={selected}
                              className={cn('robo-risk-card', selected && 'is-selected')}
                              onClick={() => {
                                setRiskProfile(option.id);
                                setError(null);
                              }}
                            >
                              <option.Icon size={20} className="robo-risk-icon" />
                              <span className="robo-risk-name">{option.label}</span>
                              <span className="robo-risk-desc">{option.description}</span>
                              <span className="robo-risk-holdings">{option.holdings} assets</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  <footer className="robo-footer">
                    <button
                      type="button"
                      className="robo-submit"
                      onClick={handleSubmit}
                      disabled={building}
                    >
                      {building ? 'Analyzing…' : 'Build Portfolio'} <ArrowRight size={16} />
                    </button>
                  </footer>
                </>
              ) : (
                <>
                  <div className="robo-body">
                    {result && result.length > 0 ? (
                      <>
                        <div className="robo-summary">
                          <div className="robo-summary-item">
                            <span className="robo-summary-label">Total invested</span>
                            <span className="robo-summary-value">{formatPrice(total)}</span>
                          </div>
                          <div className="robo-summary-item">
                            <span className="robo-summary-label">Holdings</span>
                            <span className="robo-summary-value">{result.length}</span>
                          </div>
                          <div className="robo-summary-item">
                            <span className="robo-summary-label">Risk</span>
                            <span className="robo-summary-value robo-summary-risk">
                              {activeRisk?.label}
                            </span>
                          </div>
                        </div>

                        <div className="robo-projection">
                          <div className="robo-projection-head">
                            <span className="robo-projection-title">Wealth Projection</span>
                            <span className="robo-projection-rate">
                              {(ANNUAL_RETURN_BY_RISK[riskProfile] * 100).toFixed(0)}% assumed
                              return
                            </span>
                          </div>
                          <div className="robo-projection-grid">
                            <div className="robo-projection-cell">
                              <span className="robo-projection-label">5 years</span>
                              <span className="robo-projection-value">
                                {formatPrice(
                                  projectWealth({
                                    principal: total,
                                    monthlyDeposit: monthly,
                                    annualReturn: ANNUAL_RETURN_BY_RISK[riskProfile],
                                    years: 5,
                                  }).futureValue,
                                )}
                              </span>
                            </div>
                            <div className="robo-projection-cell">
                              <span className="robo-projection-label">10 years</span>
                              <span className="robo-projection-value">
                                {formatPrice(
                                  projectWealth({
                                    principal: total,
                                    monthlyDeposit: monthly,
                                    annualReturn: ANNUAL_RETURN_BY_RISK[riskProfile],
                                    years: 10,
                                  }).futureValue,
                                )}
                              </span>
                            </div>
                            <div className="robo-projection-cell">
                              <span className="robo-projection-label">You invest</span>
                              <span className="robo-projection-value robo-projection-muted">
                                {formatPrice(total + monthly * 12 * 10)}
                              </span>
                            </div>
                          </div>
                          <p className="robo-projection-note">
                            {monthly > 0
                              ? `With ${formatPrice(monthly)} deposited monthly, compounding at the profile's assumed rate.`
                              : 'Add a monthly deposit to see your long-term compounding potential.'}
                          </p>
                        </div>

                        <p className="robo-results-note">
                          Equal-weight allocation · signal score ≥ 70 · Swap any holding to replace
                          it
                        </p>
                        <ul className="robo-allocation-list">
                          {result.map((allocation, index) => {
                            const asset = assetByTicker.get(allocation.ticker);
                            const score = asset ? calculateSignalScore(asset) : null;
                            return (
                              <li
                                key={allocation.ticker}
                                className="robo-allocation"
                                style={{ animationDelay: `${index * 55}ms` }}
                              >
                                <span className="robo-rank">{index + 1}</span>
                                <div className="robo-asset">
                                  <div className="robo-asset-row">
                                    <span className="robo-ticker">{allocation.ticker}</span>
                                    <span className={cn('robo-score', scoreTone(score))}>
                                      {score ?? '—'}
                                    </span>
                                  </div>
                                  <span className="robo-name">{asset?.name ?? 'Asset'}</span>
                                </div>
                                <div className="robo-metrics">
                                  <span className="robo-weight">
                                    {formatWeight(allocation.weight)}
                                  </span>
                                  <span className="robo-alloc-amount">
                                    {formatPrice(allocation.allocatedAmount)}
                                  </span>
                                </div>
                                <div className="robo-actions">
                                  <a
                                    className="robo-trade"
                                    href={getBrokerUrl(
                                      allocation.ticker,
                                      isBinanceCrypto(allocation.ticker) ? 'crypto' : 'stock',
                                    )}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    aria-label={`Trade ${allocation.ticker}`}
                                  >
                                    <ExternalLink size={13} /> Trade
                                  </a>
                                  <button
                                    type="button"
                                    className="robo-swap"
                                    onClick={() => handleSwap(allocation.ticker)}
                                    disabled={!canSwapMore}
                                    aria-label={`Swap ${allocation.ticker} for the next best asset`}
                                    title={
                                      canSwapMore
                                        ? 'Replace with the next best asset'
                                        : 'No more replacements available'
                                    }
                                  >
                                    <RefreshCw size={14} />
                                    <span className="robo-swap-label">Swap</span>
                                  </button>
                                </div>
                                <div className="robo-bar-track" aria-hidden="true">
                                  <div
                                    className="robo-bar"
                                    style={{
                                      width: `${allocation.weight * 100}%`,
                                      animationDelay: `${index * 55 + 150}ms`,
                                    }}
                                  />
                                </div>
                              </li>
                            );
                          })}
                        </ul>

                        {topAllocation && (
                          <a
                            className="robo-buy-portfolio"
                            href={getBrokerUrl(
                              topAllocation.ticker,
                              isBinanceCrypto(topAllocation.ticker) ? 'crypto' : 'stock',
                            )}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <Rocket size={16} /> Buy Portfolio
                          </a>
                        )}
                      </>
                    ) : (
                      <div className="robo-empty">
                        <Shield size={28} />
                        <h3>No qualifying assets</h3>
                        <p>
                          No assets in your watchlist currently clear the 70-point signal threshold.
                          Adjust your inputs or check back later.
                        </p>
                      </div>
                    )}
                  </div>

                  <footer className="robo-footer">
                    <button
                      type="button"
                      className="robo-back"
                      onClick={() => {
                        setPhase('config');
                        setError(null);
                      }}
                    >
                      <ArrowLeft size={16} /> Adjust
                    </button>
                    <button
                      type="button"
                      className="robo-submit robo-submit-invest"
                      onClick={handleConfirmInvest}
                    >
                      Confirm & Invest <Rocket size={16} />
                    </button>
                  </footer>
                </>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
