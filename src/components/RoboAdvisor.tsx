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
import { toast } from 'sonner';
import { formatPrice, type Asset } from '@/lib/assets';
import { PricingModal } from '@/components/PricingModal';
import { type Allocation, type RiskProfile } from '@/lib/portfolioBuilder';
import { useAuth } from '@/lib/authStore';
import { recordHeavyAction } from '@/lib/adManager';
import { buildQuantPortfolio } from '@/lib/roboAdvisor';
import { formatShares } from '@/lib/risk';
import { MIN_CANDLES, REGIME_LABELS } from '@/lib/canonicalModel';
import { ANNUAL_RETURN_BY_RISK, projectWealth } from '@/lib/dca';
import { applyBuyTransaction } from '@/lib/portfolioAccounting';
import { usePortfolio } from '@/lib/portfolioStore';
import {
  executePaperPortfolio,
  loadPaperTransactions,
  PortfolioRejectedError,
  type PortfolioHolding,
  type PortfolioReceipt,
} from '@/lib/db';
import { FEE_RATE } from '@/components/TradeTicket';
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

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Where booking the shown proposal stands. `uncertain` means the request may
 * have committed (the connection dropped): it is reconciled by request ID
 * before anything else can be tried.
 */
type Execution =
  | { state: 'idle' }
  | { state: 'pending' }
  | { state: 'failed'; reason: string }
  | { state: 'uncertain'; checking: boolean }
  | { state: 'completed'; receipt: PortfolioReceipt };

/** What the server needs from a proposal: it prices and sizes each holding itself. */
function toHoldings(result: Allocation[]): PortfolioHolding[] {
  return result.map((allocation) => ({
    ticker: allocation.ticker,
    amount: allocation.allocatedAmount,
    score: allocation.score ?? null,
  }));
}

/**
 * A signed-out proposal priced in the browser, the way the guest ledger books
 * it: live price, ATR suggested shares capped at the allocation. It has no
 * server risk book, so its risk fields are NaN and stay hidden.
 */
function guestPlan(
  result: Allocation[],
  assetByTicker: ReadonlyMap<string, Asset>,
  cash: number,
  budget: number,
  requestId: string,
): PortfolioReceipt {
  const orders = result.flatMap((allocation) => {
    const price = assetByTicker.get(allocation.ticker)?.current_price;
    const atrLimit = allocation.suggestedShares;
    if (!price || !Number.isFinite(price) || price <= 0 || !atrLimit || atrLimit <= 0) return [];
    const budgetShares = allocation.allocatedAmount / (price * (1 + FEE_RATE));
    const quantity = Math.floor(Math.min(atrLimit, budgetShares) * 1e8) / 1e8;
    if (quantity <= 0) return [];
    const fees = quantity * price * FEE_RATE;
    return [
      {
        ticker: allocation.ticker,
        quantity,
        price,
        fees,
        cost: quantity * price + fees,
        stop_price: Number.NaN,
        atr: Number.NaN,
        planned_risk: Number.NaN,
      },
    ];
  });
  if (orders.length === 0) {
    throw new PortfolioRejectedError(
      'No holding has a live price and an ATR-sized quantity to buy right now.',
    );
  }
  const spent = orders.reduce((sum, order) => sum + order.cost, 0);
  return {
    request_id: requestId,
    status: 'planned',
    replayed: false,
    policy_version: 'browser',
    risk_profile: '',
    budget,
    cash_before: cash,
    spent,
    fees: orders.reduce((sum, order) => sum + order.fees, 0),
    cash_after: cash - spent,
    equity: Number.NaN,
    open_risk_before: Number.NaN,
    planned_risk: Number.NaN,
    max_open_risk: Number.NaN,
    orders,
    executed_at: null,
  };
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
  const {
    executePaperTrade,
    getPortfolio,
    replacePaperLedger,
    scopeUserId: userId,
  } = usePortfolio();
  // One request ID per proposal, shared by its preview and every retry, so the
  // server books it at most once however often Confirm reaches it.
  const [requestId, setRequestId] = useState('');
  const [plan, setPlan] = useState<PortfolioReceipt | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [execution, setExecution] = useState<Execution>({ state: 'idle' });
  const executingRef = useRef(false);

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

  // A new proposal gets a new request ID and, signed in, a server price check:
  // the quantities, fees and cash shown are the ones Confirm will book.
  useEffect(() => {
    if (phase !== 'results' || !result || result.length === 0) return;
    const id = crypto.randomUUID();
    setRequestId(id);
    setPlan(null);
    setPlanError(null);
    setExecution({ state: 'idle' });
    if (userId === null) return;
    let live = true;
    executePaperPortfolio({
      requestId: id,
      riskProfile,
      budget: total,
      holdings: toHoldings(result),
      dryRun: true,
    })
      .then((priced) => {
        if (live) setPlan(priced);
      })
      .catch((error: unknown) => {
        if (live) setPlanError(errorMessage(error));
      });
    return () => {
      live = false;
    };
  }, [phase, result, total, riskProfile, userId]);

  const guest = useMemo(() => {
    if (userId !== null || !result || result.length === 0) return null;
    try {
      const cash = getPortfolio('paper_trading').cashBalance;
      return { plan: guestPlan(result, assetByTicker, cash, total, requestId), error: null };
    } catch (error) {
      return { plan: null, error: errorMessage(error) };
    }
  }, [userId, result, assetByTicker, getPortfolio, total, requestId]);

  const shownPlan =
    execution.state === 'completed' ? execution.receipt : userId === null ? guest?.plan : plan;
  const shownPlanError = userId === null ? (guest?.error ?? null) : planError;
  const busy = execution.state === 'pending' || execution.state === 'uncertain';

  async function settle(receipt: PortfolioReceipt, account: string) {
    setExecution({ state: 'completed', receipt });
    try {
      replacePaperLedger(await loadPaperTransactions(account));
    } catch {
      toast.warning('Orders booked; Paper Trading is still syncing');
    }
  }

  /** After a lost response: asks the server whether this request ID booked. */
  async function reconcile(account: string) {
    if (!result) return;
    setExecution({ state: 'uncertain', checking: true });
    try {
      const found = await executePaperPortfolio({
        requestId,
        riskProfile,
        budget: total,
        holdings: toHoldings(result),
        dryRun: true,
      });
      if (found.status === 'executed') {
        await settle(found, account);
      } else {
        setExecution({
          state: 'failed',
          reason:
            'The server has no record of this request, so nothing was booked. Trying again is safe: one request can only book once.',
        });
      }
    } catch (error) {
      setExecution(
        error instanceof PortfolioRejectedError
          ? { state: 'failed', reason: error.message }
          : { state: 'uncertain', checking: false },
      );
    }
  }

  /** Signed out there is no server ledger: book the browser plan, all or nothing. */
  async function investAsGuest(guestOrders: PortfolioReceipt) {
    const timestamp = new Date().toISOString();
    const orders = guestOrders.orders.map((order) => {
      const name = assetByTicker.get(order.ticker)?.name;
      return {
        side: 'buy' as const,
        ticker: order.ticker,
        ...(name ? { name } : {}),
        shares: order.quantity,
        price: order.price,
        fee: order.fees,
      };
    });
    // Check the whole batch against the account before booking its first row.
    let preview = getPortfolio('paper_trading');
    for (const order of orders) {
      const bought = applyBuyTransaction(preview, { ...order, timestamp });
      if (!bought.ok) {
        setExecution({ state: 'failed', reason: bought.error });
        return;
      }
      preview = bought.container;
    }
    for (const order of orders) {
      const booked = await executePaperTrade(order);
      if (!booked.ok) {
        setExecution({ state: 'failed', reason: booked.error ?? 'Order rejected' });
        return;
      }
    }
    setExecution({
      state: 'completed',
      receipt: { ...guestOrders, status: 'executed', executed_at: timestamp },
    });
  }

  async function handleConfirmInvest() {
    // A second click (or Enter) while a request is out must not send another.
    if (executingRef.current || closingRef.current || !result || result.length === 0) return;
    if (busy || execution.state === 'completed') return;
    executingRef.current = true;
    try {
      if (userId === null) {
        if (guest?.plan) await investAsGuest(guest.plan);
        return;
      }
      if (!plan) return;
      setExecution({ state: 'pending' });
      try {
        const receipt = await executePaperPortfolio({
          requestId,
          riskProfile,
          budget: total,
          holdings: toHoldings(result),
          dryRun: false,
        });
        await settle(receipt, userId);
      } catch (error) {
        if (error instanceof PortfolioRejectedError) {
          setExecution({ state: 'failed', reason: error.message });
        } else {
          await reconcile(userId);
        }
      }
    } finally {
      executingRef.current = false;
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
                                      !canSwapMore || busy || execution.state === 'completed'
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

                        <section className="robo-plan" aria-labelledby="robo-plan-title">
                          <h3 id="robo-plan-title" className="robo-plan-title">
                            {execution.state === 'completed' ? 'Receipt' : 'Orders'}
                          </h3>
                          {shownPlanError ? (
                            <p className="robo-error" role="alert">
                              Can't book this proposal: {shownPlanError}
                            </p>
                          ) : !shownPlan ? (
                            <p className="robo-hint" role="status">
                              Checking prices and Paper Cash on the server…
                            </p>
                          ) : (
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
                                    {shownPlan.orders.map((order) => (
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
                                  <dd>{formatPrice(shownPlan.cash_before)}</dd>
                                </div>
                                <div>
                                  <dt>
                                    {execution.state === 'completed' ? 'Spent' : 'Planned spend'}
                                  </dt>
                                  <dd>{formatPrice(shownPlan.spent)}</dd>
                                </div>
                                <div>
                                  <dt>Cash after</dt>
                                  <dd>{formatPrice(shownPlan.cash_after)}</dd>
                                </div>
                                {Number.isFinite(shownPlan.planned_risk) && (
                                  <div>
                                    <dt>Risk at planned stops</dt>
                                    <dd>
                                      {formatPrice(
                                        shownPlan.open_risk_before + shownPlan.planned_risk,
                                      )}{' '}
                                      of {formatPrice(shownPlan.max_open_risk)} cap
                                    </dd>
                                  </div>
                                )}
                              </dl>
                              {Number.isFinite(shownPlan.planned_risk) && (
                                <p className="robo-hint">
                                  Units are sized against a 2×ATR planned stop. Paper Trading places
                                  no stop orders: nothing sells automatically.
                                </p>
                              )}
                            </>
                          )}
                          {execution.state === 'failed' && (
                            <p className="robo-error" role="alert">
                              Not booked: {execution.reason}
                            </p>
                          )}
                          {execution.state === 'uncertain' && (
                            <div className="robo-plan-uncertain" role="status">
                              <p>
                                {execution.checking
                                  ? 'The connection dropped before the server answered. Checking whether this request was booked…'
                                  : "Couldn't reach the server to check whether this request was booked."}
                              </p>
                              {!execution.checking && userId !== null && (
                                <button
                                  type="button"
                                  className="robo-back"
                                  onClick={() => void reconcile(userId)}
                                >
                                  <RefreshCw size={14} /> Check again
                                </button>
                              )}
                            </div>
                          )}
                          {execution.state === 'completed' && (
                            <p className="robo-plan-receipt" role="status">
                              Booked {execution.receipt.orders.length} orders in one transaction ·
                              receipt {execution.receipt.request_id.slice(0, 8)}
                            </p>
                          )}
                        </section>
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

                  <footer className="robo-footer">
                    {execution.state === 'completed' ? (
                      <>
                        <button type="button" className="robo-back" onClick={closeModal}>
                          Done
                        </button>
                        <button
                          type="button"
                          className="robo-submit robo-submit-invest"
                          onClick={viewLedger}
                        >
                          View in Paper Trading <ArrowRight size={16} />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="robo-back"
                          disabled={busy}
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
                          disabled={!shownPlan || !!shownPlanError || busy}
                          aria-busy={execution.state === 'pending'}
                        >
                          {execution.state === 'pending'
                            ? 'Booking orders…'
                            : 'Simulate on Paper Desk'}{' '}
                          <Rocket size={16} />
                        </button>
                      </>
                    )}
                  </footer>
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
