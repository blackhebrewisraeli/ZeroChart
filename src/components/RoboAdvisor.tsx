import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Gauge,
  LockKeyhole,
  RefreshCw,
  Rocket,
  Shield,
  X,
} from 'lucide-react';
import { formatPrice, type Asset } from '@/lib/assets';
import { PricingModal } from '@/components/PricingModal';
import { type Allocation, type RiskProfile } from '@/lib/portfolioBuilder';
import { useAuth } from '@/lib/authStore';
import { recordHeavyAction } from '@/lib/adManager';
import { buildQuantPortfolio } from '@/lib/roboAdvisor';
import { formatShares } from '@/lib/risk';
import { MIN_CANDLES, REGIME_LABELS } from '@/lib/canonicalModel';
import { ANNUAL_RETURN_BY_RISK, projectWealth } from '@/lib/dca';
import { usePortfolio } from '@/lib/portfolioStore';
import { useProposalExecution } from '@/hooks/useProposalExecution';
import { cn, closeOnBackdrop } from '@/lib/utils';

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

/** Compact sub-score chips: label, component score key, applied weight key. */
const FACTOR_CHIPS = [
  { label: 'RSI', name: 'Mean reversion', score: 'rsiScore', weight: 'rsi' },
  { label: 'MACD', name: 'Momentum', score: 'momentumScore', weight: 'momentum' },
  { label: 'ATR', name: 'Volatility regime', score: 'volatilityScore', weight: 'volatility' },
] as const;

function formatWeight(weight: number) {
  return `${(weight * 100).toFixed(1)}%`;
}

function scoreTone(score: number | null) {
  if (score === null) return '';
  return score > 85 ? 'score-high' : score >= 70 ? 'score-mid' : 'score-low';
}

type Proposal = ReturnType<typeof useProposalExecution>;

/** The orders the server will book, or the receipt once it has. */
function PlanDetails({ proposal }: Readonly<{ proposal: Proposal }>) {
  const { plan, planError, execution } = proposal;
  if (planError) {
    return (
      <p className="robo-error" role="alert">
        Can't book this proposal: {planError}
      </p>
    );
  }
  if (!plan) {
    return <output className="robo-hint">Checking prices and Paper Cash on the server…</output>;
  }
  const sized = Number.isFinite(plan.planned_risk);
  return (
    <>
      <div className="robo-plan-scroll">
        <table className="robo-plan-table">
          <thead>
            <tr>
              <th scope="col">Asset</th>
              <th scope="col">Units</th>
              <th scope="col">Price</th>
              <th scope="col">Fee</th>
              <th scope="col">Cost</th>
            </tr>
          </thead>
          <tbody>
            {plan.orders.map((order) => (
              <tr key={order.ticker}>
                <th scope="row">{order.ticker}</th>
                <td>{formatShares(order.quantity)}</td>
                <td>{formatPrice(order.price)}</td>
                <td>{formatPrice(order.fees)}</td>
                <td>{formatPrice(order.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="robo-plan-totals">
        <div>
          <dt>Paper Cash</dt>
          <dd>{formatPrice(plan.cash_before)}</dd>
        </div>
        <div>
          <dt>{execution.state === 'completed' ? 'Spent' : 'Planned spend'}</dt>
          <dd>{formatPrice(plan.spent)}</dd>
        </div>
        <div>
          <dt>Cash after</dt>
          <dd>{formatPrice(plan.cash_after)}</dd>
        </div>
        {sized && (
          <div>
            <dt>Risk at planned stops</dt>
            <dd>
              {formatPrice(plan.open_risk_before + plan.planned_risk)} of{' '}
              {formatPrice(plan.max_open_risk)} cap
            </dd>
          </div>
        )}
      </dl>
      {sized && (
        <p className="robo-hint">
          Units are sized against a 2×ATR planned stop. Paper Trading places no stop orders: nothing
          sells automatically.
        </p>
      )}
    </>
  );
}

/** What happened to the last Confirm, when anything did. */
function ExecutionNote({ proposal }: Readonly<{ proposal: Proposal }>) {
  const { execution, checkAgain } = proposal;
  switch (execution.state) {
    case 'failed':
      return (
        <p className="robo-error" role="alert">
          Not booked: {execution.reason}
        </p>
      );
    case 'uncertain':
      return (
        <output className="robo-plan-uncertain">
          <span>
            {execution.checking
              ? 'The connection dropped before the server answered. Checking whether this request was booked…'
              : "Couldn't reach the server to check whether this request was booked."}
          </span>
          {checkAgain && (
            <button type="button" className="robo-back" onClick={checkAgain}>
              <RefreshCw size={14} /> Check again
            </button>
          )}
        </output>
      );
    case 'completed': {
      const count = execution.receipt.orders.length;
      return (
        <output className="robo-plan-receipt">
          Booked {count} {count === 1 ? 'order' : 'orders'} in one transaction · receipt{' '}
          {execution.receipt.request_id.slice(0, 8)}
        </output>
      );
    }
    default:
      return null;
  }
}

function ProposalOrders({ proposal }: Readonly<{ proposal: Proposal }>) {
  return (
    <section className="robo-plan" aria-labelledby="robo-plan-title">
      <h3 id="robo-plan-title" className="robo-plan-title">
        {proposal.execution.state === 'completed' ? 'Receipt' : 'Orders'}
      </h3>
      <PlanDetails proposal={proposal} />
      <ExecutionNote proposal={proposal} />
    </section>
  );
}

function ProposalFooter({
  proposal,
  onAdjust,
  onDone,
  onViewLedger,
}: Readonly<{
  proposal: Proposal;
  onAdjust: () => void;
  onDone: () => void;
  onViewLedger: () => void;
}>) {
  const { plan, planError, execution, busy, confirm } = proposal;
  if (execution.state === 'completed') {
    return (
      <footer className="robo-footer">
        <button type="button" className="robo-back" onClick={onDone}>
          Done
        </button>
        <button type="button" className="robo-submit robo-submit-invest" onClick={onViewLedger}>
          View in Paper Trading <ArrowRight size={16} />
        </button>
      </footer>
    );
  }
  const pending = execution.state === 'pending';
  return (
    <footer className="robo-footer">
      <button type="button" className="robo-back" disabled={busy} onClick={onAdjust}>
        <ArrowLeft size={16} /> Adjust
      </button>
      <button
        type="button"
        className="robo-submit robo-submit-invest"
        onClick={() => void confirm()}
        disabled={!plan || !!planError || busy}
        aria-busy={pending}
      >
        {pending ? 'Booking orders…' : 'Simulate on Paper Desk'} <Rocket size={16} />
      </button>
    </footer>
  );
}

export function RoboAdvisor({ assets, onInvest }: { assets: Asset[]; onInvest?: () => void }) {
  const { isPro } = useAuth();
  const [open, setOpen] = useState(false);
  const [pricingOpen, setPricingOpen] = useState(false);
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
  const { getPortfolio } = usePortfolio();
  const proposal = useProposalExecution({
    phase,
    result,
    budget: total,
    riskProfile,
    assetByTicker,
    closingRef,
  });

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
      // A nested Radix layer (e.g. PricingModal) that handled this Escape has
      // already called preventDefault — let it close alone.
      if (e.key === 'Escape' && !e.defaultPrevented) closeModal();
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
    // Enter in either input bypasses the disabled button; one build at a time.
    if (building) return;
    const value = Number(amount.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(value) || value <= 0) {
      setError('Enter an investment amount greater than $0.');
      return;
    }
    const paperCash = getPortfolio('paper_trading').cashBalance;
    if (value > paperCash) {
      setError(`Available Paper Cash is ${formatPrice(paperCash)}.`);
      return;
    }
    const monthlyRaw = monthlyDeposit.replace(/[^0-9.]/g, '');
    const monthlyValue = monthlyRaw === '' ? 0 : Number(monthlyRaw);
    if (!Number.isFinite(monthlyValue) || monthlyValue < 0) {
      setError('Enter a valid monthly deposit.');
      return;
    }
    setError(null);
    recordHeavyAction(isPro);
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

  function viewLedger() {
    closeModal();
    if (onInvest) window.setTimeout(onInvest, CLOSE_MS);
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
          <div // NOSONAR(S6819): click-to-close backdrop, not an image; Escape closes it from the keyboard
            role="presentation"
            className={cn('robo-overlay', closing && 'is-closing')}
            onClick={closeOnBackdrop(closeModal)}
          >
            <div
              className={cn('robo-panel', closing && 'is-closing')}
              role="dialog"
              aria-modal="true"
              aria-labelledby="robo-title"
            >
              <header className="robo-header">
                <div className="robo-brand">
                  <span className="robo-brand-icon">
                    <Bot size={18} />
                  </span>
                  <div>
                    <h2 id="robo-title" className="robo-title">
                      Quant Analyzer
                    </h2>
                    <p className="robo-subtitle">Quantitative Multi-Factor Engine</p>
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
                            if (e.key === 'Enter') void handleSubmit();
                          }}
                          placeholder="10,000"
                          aria-invalid={!!error}
                          aria-describedby="robo-amount-hint"
                        />
                      </div>
                      <p id="robo-amount-hint" className="robo-hint">
                        Multi-factor scored on RSI, MACD momentum, and ATR volatility
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
                            if (e.key === 'Enter') void handleSubmit();
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
                            <span className="robo-summary-label">Simulated capital</span>
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
                            <span className="robo-projection-title">Growth Projection</span>
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
                          Regime-weighted Multi-Factor Score (RSI · MACD · ATR) · Assets with fewer
                          than {MIN_CANDLES} daily candles are skipped (Not Enough Data) · Suggested
                          size risks up to 2% of capital at a 2×ATR stop, capped at the allocation ·
                          Swap any holding to replace it
                        </p>
                        <ul className="robo-allocation-list">
                          {result.map((allocation, index) => {
                            const asset = assetByTicker.get(allocation.ticker);
                            const score = allocation.score ?? null;
                            const shares = allocation.suggestedShares ?? null;
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
                                    <span
                                      className={cn('robo-score', scoreTone(score))}
                                      title="Multi-Factor Score — RSI · MACD · ATR"
                                    >
                                      {score ?? '—'}
                                    </span>
                                  </div>
                                  <span className="robo-name">{asset?.name ?? 'Asset'}</span>
                                  {(allocation.regime ||
                                    allocation.rationale ||
                                    allocation.components) && (
                                    <div className="pro-feature-gate robo-quant-gate">
                                      <div
                                        className={cn('pro-feature-content', !isPro && 'is-locked')}
                                        aria-hidden={!isPro}
                                      >
                                        {allocation.regime && (
                                          <div className="robo-insight-badges">
                                            <span
                                              className="regime-badge"
                                              data-regime={allocation.regime}
                                              title="Detected market regime"
                                            >
                                              {REGIME_LABELS[allocation.regime]}
                                            </span>
                                          </div>
                                        )}
                                        {allocation.rationale && (
                                          <p className="robo-rationale">{allocation.rationale}</p>
                                        )}
                                        {allocation.components && (
                                          <span className="robo-factors">
                                            {FACTOR_CHIPS.map((factor) => {
                                              const value = allocation.components?.[factor.score];
                                              const weight =
                                                allocation.components?.weights[factor.weight] ?? 0;
                                              return (
                                                <span
                                                  key={factor.label}
                                                  title={`${factor.name} sub-score · ${Math.round(weight * 100)}% weight`}
                                                >
                                                  {factor.label}{' '}
                                                  <b>
                                                    {value === undefined ? '—' : Math.round(value)}
                                                  </b>
                                                </span>
                                              );
                                            })}
                                          </span>
                                        )}
                                      </div>
                                      {!isPro && (
                                        <button
                                          type="button"
                                          className="pro-feature-unlock robo-quant-unlock"
                                          onClick={() => setPricingOpen(true)}
                                        >
                                          <LockKeyhole size={13} /> Upgrade to unlock Quant Insights
                                        </button>
                                      )}
                                    </div>
                                  )}
                                </div>
                                <div className="robo-metrics">
                                  <span className="robo-weight">
                                    {formatWeight(allocation.weight)}
                                  </span>
                                  <span className="robo-alloc-amount">
                                    {formatPrice(allocation.allocatedAmount)}
                                  </span>
                                  <span
                                    className="robo-size"
                                    title="Suggested position size — risks up to 2% of total capital on a 2×ATR(14) stop, capped at this holding's allocation"
                                  >
                                    <span className="robo-size-label">Suggested size</span>
                                    <span className="robo-size-value">
                                      {shares !== null ? `${formatShares(shares)} shares` : '—'}
                                    </span>
                                  </span>
                                </div>
                                <div className="robo-actions">
                                  <button
                                    type="button"
                                    className="robo-swap"
                                    onClick={() => handleSwap(allocation.ticker)}
                                    disabled={
                                      !canSwapMore ||
                                      proposal.busy ||
                                      proposal.execution.state === 'completed'
                                    }
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

                        <ProposalOrders proposal={proposal} />
                      </>
                    ) : (
                      <div className="robo-empty">
                        <Shield size={28} />
                        <h3>No qualifying assets</h3>
                        <p>
                          No asset in your watchlist has both a Signal Score that clears this
                          profile's minimum and the {MIN_CANDLES} daily candles the engine needs to
                          score it. Assets without enough data are skipped, never guessed, and your
                          Paper Cash stays as it is. Check back later.
                        </p>
                      </div>
                    )}
                  </div>

                  <ProposalFooter
                    proposal={proposal}
                    onAdjust={() => {
                      setPhase('config');
                      setError(null);
                    }}
                    onDone={closeModal}
                    onViewLedger={viewLedger}
                  />
                </>
              )}
            </div>
          </div>,
          document.body,
        )}
      <PricingModal open={pricingOpen} onOpenChange={setPricingOpen} />
    </>
  );
}
