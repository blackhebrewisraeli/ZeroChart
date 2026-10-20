import { memo, useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, type Transition } from 'framer-motion';
import {
  Activity,
  Briefcase,
  CheckCircle2,
  ChevronDown,
  CloudUpload,
  Download,
  ExternalLink,
  Gauge,
  Layers,
  Pencil,
  Share2,
  Trash2,
  TrendingDown,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  formatPnl,
  formatPrice,
  formatSignedPercent,
  generateTrendData,
  pnlTone,
  type Asset,
} from '@/lib/assets';
import { calculatePortfolioStats, type Position } from '@/lib/portfolioManager';
import type { CanonicalResult } from '@/lib/canonicalModel';
import { useCanonicalScores } from '@/hooks/useCanonicalScores';
import { usePortfolio } from '@/lib/portfolioStore';
import {
  computePortfolioValuation,
  positionCostBasis,
  type PortfolioTransaction,
} from '@/lib/portfolioAccounting';
import {
  INTENT_LABELS,
  LEDGER_SIDE_LABELS,
  downloadCsv,
  executionCost,
  executionDrag,
  frictionBps,
  tradeLedgerCsv,
} from '@/lib/tradeLedger';
import { formatShares } from '@/lib/risk';
import { useAuth } from '@/lib/authStore';
import {
  mergeLivePrices,
  useConnectionState,
  useLivePrice,
  useLivePrices,
} from '@/lib/livePriceStore';
import { assetFreshness } from '@/lib/freshness';
import { FreshnessBadge } from '@/components/FreshnessBadge';
import { PortfolioNotHydratedError, savePortfolioStateV3 } from '@/lib/db';
import { useHydrationState } from '@/lib/hydrationStore';
import { AddPositionModal } from '@/components/AddPositionModal';
import { AuthModal } from '@/components/AuthModal';
import { AssetIcon } from '@/components/AssetIcon';
import { InsufficientDataBadge } from '@/components/InsufficientDataBadge';
import { Segmented } from '@/components/Segmented';
import { Sparkline } from '@/components/Sparkline';
import { AllocationChart } from '@/components/AllocationChart';
import { BacktestChart } from '@/components/BacktestChart';
import { PriceAlerts } from '@/components/PriceAlerts';
import { FEE_RATE } from '@/components/TradeTicket';
import { RebalancePanel } from '@/components/RebalancePanel';
import { usePriceFlash } from '@/hooks/usePriceFlash';
import { cn } from '@/lib/utils';
import { isBinanceCrypto, toBinanceSymbol } from '@/lib/binance';
import { getBrokerUrl } from '@/lib/tradeRouter';
import {
  buildSharedPortfolioSnapshot,
  createSharedPortfolioId,
  publishSharedPortfolio,
} from '@/lib/sharedPortfolio';

type PortfolioMode = 'simulation' | 'live';
type AnalyticsTab = 'backtest' | 'ledger';

const SPRING: Transition = { type: 'spring', stiffness: 300, damping: 30 };

function KpiCard({
  label,
  value,
  sub,
  icon,
  accent = 'blue',
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: ReactNode;
  accent?: 'blue' | 'green' | 'red';
  tone?: 'pnl-up' | 'pnl-down' | undefined;
}) {
  return (
    <div className={cn('kpi-card', `is-${accent}`)}>
      <div className="kpi-card-head">
        <span className="overview-label">{label}</span>
        {icon && <span className="kpi-card-icon">{icon}</span>}
      </div>
      <span className={cn('overview-value', tone)}>{value}</span>
      {sub && <span className={cn('overview-sub', tone)}>{sub}</span>}
    </div>
  );
}

function TelemetryItem({
  label,
  value,
  sub,
  icon,
  accent,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  icon: ReactNode;
  accent: 'violet' | 'green' | 'amber';
  tone?: 'pnl-up' | 'pnl-down' | undefined;
}) {
  return (
    <div className={cn('portfolio-telemetry-item', `is-${accent}`)}>
      <span className="portfolio-telemetry-icon">{icon}</span>
      <span className="portfolio-telemetry-copy">
        <span className="overview-label">{label}</span>
        <span className={cn('portfolio-telemetry-value', tone)}>{value}</span>
        <span className="portfolio-telemetry-sub">{sub}</span>
      </span>
    </div>
  );
}

function healthTone(score: number | null) {
  if (score === null) return 'health-none';
  return score >= 80 ? 'health-green' : score >= 50 ? 'health-yellow' : 'health-red';
}

/** `score` is null when no holding has a canonical score yet — shown as "—", never 0. */
function HealthRing({ score }: { score: number | null }) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(100, Math.max(0, score ?? 0));
  const offset = circumference * (1 - clamped / 100);
  return (
    <div
      className={cn('health-ring', healthTone(score))}
      role="img"
      aria-label={
        score === null
          ? 'Portfolio health: not enough data'
          : `Portfolio health ${Math.round(score)} out of 100`
      }
    >
      <svg className="health-ring-svg" viewBox="0 0 100 100" aria-hidden="true">
        <circle className="health-ring-track" cx="50" cy="50" r={radius} />
        <circle
          className="health-ring-progress"
          cx="50"
          cy="50"
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="health-ring-center">
        <span className="health-ring-value">{score === null ? '—' : Math.round(score)}</span>
        <span className="health-ring-label">HEALTH</span>
      </div>
    </div>
  );
}

function HoldingRow({
  position,
  assets,
  result,
  onClose,
  onUpdate,
}: {
  position: Position;
  assets: Asset[];
  result: CanonicalResult | undefined;
  onClose: (position: Position, livePrice: number | undefined) => void;
  onUpdate: (id: string, updates: Partial<Pick<Position, 'shares' | 'buyPrice'>>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftShares, setDraftShares] = useState(String(position.shares));
  const [draftPrice, setDraftPrice] = useState(String(position.buyPrice));

  const asset = assets.find((a) => a.ticker === position.ticker);
  // Explicit per-asset freshness (M1-T4, F-3.2b): `assets` is live-merged, so
  // look up the raw tick separately to know whether the price is real-time.
  const liveTick = useLivePrice(toBinanceSymbol(position.ticker));
  const streamConnected = useConnectionState() === 'connected';
  const freshness = assetFreshness(asset ?? { current_price: null }, liveTick, {
    streamConnected,
  });
  const livePrice = asset?.current_price;
  const hasLivePrice = typeof livePrice === 'number' && Number.isFinite(livePrice) && livePrice > 0;
  // Without a live price the totals fall back to cost basis (no phantom P&L),
  // but the row must NOT imply the price is unchanged — show '—' instead
  // (M1-T3, F-1.3b).
  const currentPrice = hasLivePrice ? livePrice : position.buyPrice;
  const marketValue = currentPrice * position.shares;
  // Fees are part of what the holding cost, as in the Invested and P&L cards above.
  const costBasis = positionCostBasis(position);
  const pnl = marketValue - costBasis;
  const pnlPct = costBasis > 0 ? (pnl / costBasis) * 100 : 0;
  const tone = !hasLivePrice ? undefined : pnl >= 0 ? 'pnl-up' : 'pnl-down';
  const priceFlash = usePriceFlash(currentPrice);
  // A simulated close is a sell at the live price; with no price there is nothing to fill at.
  const closeBlocked = position.isSimulation && !hasLivePrice;

  function startEdit() {
    setDraftShares(String(position.shares));
    setDraftPrice(String(position.buyPrice));
    setEditing(true);
  }

  function saveEdit() {
    const shares = Number(draftShares);
    const price = Number(draftPrice);
    if (Number.isFinite(shares) && shares >= 0 && Number.isFinite(price) && price >= 0) {
      onUpdate(position.id, { shares, buyPrice: price });
    }
    setEditing(false);
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0, scale: 0.95 }}
      transition={SPRING}
      className="holding"
    >
      <button
        type="button"
        className="holding-summary"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <div className="holding-asset">
          <div className="holding-asset-head">
            <AssetIcon symbol={position.ticker} name={asset?.name ?? null} size="md" />
            <span className="holding-ticker">{position.ticker}</span>
            <FreshnessBadge state={freshness} />
          </div>
          <span className="holding-name">{asset?.name ?? position.ticker}</span>
        </div>
        <div className="holding-cell holding-cell-secondary">
          <span className="holding-cell-value">{formatShares(position.shares)}</span>
          <span className="holding-cell-label">Shares</span>
        </div>
        <div className="holding-cell holding-cell-secondary">
          <span
            className={cn('holding-cell-value', priceFlash)}
            title={hasLivePrice ? undefined : 'No live price — totals use cost basis'}
          >
            {hasLivePrice ? formatPrice(marketValue) : '—'}
          </span>
          <span className="holding-cell-label">Value</span>
        </div>
        <Sparkline
          data={generateTrendData(
            asset?.current_price ?? position.buyPrice,
            asset?.change_24h ?? null,
          )}
          change={asset?.change_24h ?? null}
        />
        <div className="holding-cell">
          <span className={cn('holding-cell-value', tone)}>
            {hasLivePrice ? formatPnl(pnl) : '—'}
          </span>
          <span className={cn('holding-cell-label', tone)}>
            {hasLivePrice ? formatSignedPercent(pnlPct) : '—'}
          </span>
        </div>
        <ChevronDown size={18} className={cn('holding-chevron', open && 'is-open')} />
      </button>

      <div className={cn('holding-details', open && 'is-open')}>
        <div className="holding-details-inner">
          <div className="holding-metrics">
            <div className="holding-metric">
              <span className="holding-metric-label">Buy price</span>
              <span className="holding-metric-value">{formatPrice(position.buyPrice)}</span>
            </div>
            <div className="holding-metric">
              <span className="holding-metric-label">Market price</span>
              <span
                className={cn('holding-metric-value', priceFlash)}
                title={
                  hasLivePrice
                    ? undefined
                    : 'No live price available — position totals use cost basis'
                }
              >
                {hasLivePrice ? formatPrice(currentPrice) : '—'}
              </span>
            </div>
            <div className="holding-metric">
              <span className="holding-metric-label">Invested</span>
              <span className="holding-metric-value">{formatPrice(costBasis)}</span>
            </div>
            <div className="holding-metric">
              <span className="holding-metric-label">Signal</span>
              <span className="holding-metric-value">
                {result?.status === 'OK' ? (
                  result.signal_score
                ) : result?.status === 'INSUFFICIENT_DATA' ? (
                  <InsufficientDataBadge />
                ) : (
                  '—'
                )}
              </span>
            </div>
            <div className="holding-metric">
              <span className="holding-metric-label">Date added</span>
              {/* Engine fills store a full ISO timestamp; older rows a bare date. */}
              <span className="holding-metric-value">{position.dateAdded.slice(0, 10)}</span>
            </div>
          </div>

          {editing && (
            <div className="holding-edit">
              <label className="holding-edit-field">
                <span className="holding-edit-label">Shares</span>
                <input
                  className="holding-edit-input"
                  name={`shares-${position.id}`}
                  type="number"
                  min="0"
                  step="any"
                  value={draftShares}
                  onChange={(e) => setDraftShares(e.target.value)}
                />
              </label>
              <label className="holding-edit-field">
                <span className="holding-edit-label">Buy price</span>
                <input
                  className="holding-edit-input"
                  name={`buy-price-${position.id}`}
                  type="number"
                  min="0"
                  step="any"
                  value={draftPrice}
                  onChange={(e) => setDraftPrice(e.target.value)}
                />
              </label>
              <div className="holding-edit-actions">
                <button
                  type="button"
                  className="holding-action holding-action-primary"
                  onClick={saveEdit}
                >
                  Save
                </button>
                <button type="button" className="holding-action" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className="holding-actions">
            <a
              className="trade-now-button"
              href={getBrokerUrl(
                position.ticker,
                isBinanceCrypto(position.ticker) ? 'crypto' : 'stock',
              )}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink size={15} /> Trade
            </a>
            <button
              type="button"
              className="holding-action holding-action-danger"
              disabled={closeBlocked}
              title={closeBlocked ? 'No live price to close at yet' : undefined}
              onClick={() => onClose(position, hasLivePrice ? livePrice : undefined)}
            >
              <Trash2 size={15} /> Close Position
            </button>
            <button type="button" className="holding-action" onClick={startEdit}>
              <Pencil size={15} /> Edit
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function formatLedgerTime(timestamp: string) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? timestamp
    : date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

export function TradeLedger({
  transactions,
  filename,
  title = 'Trade Ledger',
  defaultOpen = false,
  embedded = false,
}: {
  transactions: PortfolioTransaction[];
  filename: string;
  title?: string;
  defaultOpen?: boolean;
  embedded?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const newestFirst = [...transactions].reverse();

  return (
    <section
      className={cn('portfolio-section', embedded && 'portfolio-section-embedded')}
      aria-label={title}
    >
      {!embedded && (
        <div className="portfolio-section-head">
          <h3 className="portfolio-section-title">
            <button
              type="button"
              className="ledger-toggle"
              aria-expanded={open}
              aria-controls="trade-ledger-panel"
              onClick={() => setOpen((value) => !value)}
            >
              {title}
              <ChevronDown size={18} className={cn('holding-chevron', open && 'is-open')} />
            </button>
          </h3>
          <div className="portfolio-section-actions">
            <span className="portfolio-count">
              {transactions.length} ENTR{transactions.length === 1 ? 'Y' : 'IES'}
            </span>
            <button
              type="button"
              className="portfolio-cash-btn ledger-export"
              disabled={transactions.length === 0}
              onClick={() => downloadCsv(filename, tradeLedgerCsv(transactions))}
            >
              <Download size={13} /> Export CSV
            </button>
          </div>
        </div>
      )}
      {(embedded || open) && (
        <div id="trade-ledger-panel">
          {newestFirst.length > 0 ? (
            <div className="ledger-scroll">
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Side</th>
                    <th scope="col">Ticker</th>
                    <th scope="col">Qty</th>
                    <th scope="col">Price</th>
                    <th scope="col">Fee + Slip</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Realized P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  {newestFirst.map((transaction) => {
                    const bps = frictionBps(transaction);
                    const realized = transaction.realizedPnl;
                    return (
                      <tr key={transaction.id}>
                        <td>{formatLedgerTime(transaction.timestamp)}</td>
                        <td>
                          <span className="ledger-side" data-side={transaction.type}>
                            {LEDGER_SIDE_LABELS[transaction.type]}
                          </span>
                          {transaction.intent && INTENT_LABELS[transaction.intent] && (
                            <span className="ledger-intent">
                              {INTENT_LABELS[transaction.intent]}
                            </span>
                          )}
                        </td>
                        <td>{transaction.ticker ?? '—'}</td>
                        <td>
                          {transaction.shares !== undefined
                            ? formatShares(transaction.shares)
                            : '—'}
                        </td>
                        <td>
                          {transaction.price !== undefined ? formatPrice(transaction.price) : '—'}
                        </td>
                        <td>
                          {bps === null
                            ? '—'
                            : `${formatPrice(executionCost(transaction))} · ${bps.toFixed(1)} bps`}
                        </td>
                        <td>{formatPrice(transaction.amount)}</td>
                        <td
                          className={cn(
                            realized !== undefined && realized > 0 && 'pnl-up',
                            realized !== undefined && realized < 0 && 'pnl-down',
                          )}
                        >
                          {realized !== undefined ? formatPnl(realized) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="holdings-empty">
              <Layers size={26} />
              <span className="holdings-empty-title">No ledger activity yet</span>
              <span className="holdings-empty-sub">
                Buys, sells and cash movements recorded by the accounting engine appear here.
              </span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export const PortfolioDashboard = memo(function PortfolioDashboard({
  assets: baseAssets,
}: {
  assets: Asset[];
}) {
  const [authOpen, setAuthOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [cashAmount, setCashAmount] = useState('');
  const [analyticsTab, setAnalyticsTab] = useState<AnalyticsTab>('backtest');
  const { user } = useAuth();
  const {
    removePosition,
    updatePosition,
    executeSell,
    depositPortfolioCash,
    withdrawPortfolioCash,
    activePortfolioType,
    setActivePortfolioType,
    portfolios,
  } = usePortfolio();
  // Core shows Simulation or Live Tracking; tactical trades book into Paper Trading.
  const ledgerType = activePortfolioType;
  const mode: PortfolioMode = ledgerType === 'real_tracking' ? 'live' : 'simulation';
  const setMode = (next: PortfolioMode) =>
    setActivePortfolioType(next === 'live' ? 'real_tracking' : 'long_term_sim');
  const hydration = useHydrationState();

  // Cloud saves stay disabled until this user's cloud hydration settled —
  // never overwrite a row that is still loading (M1-T1, F-4.1b).
  const saveBlocked =
    user !== null &&
    !(
      hydration.userId === user.id &&
      (hydration.status === 'ready' || hydration.status === 'error')
    );

  const livePrices = useLivePrices();
  const assets = useMemo(() => mergeLivePrices(baseAssets, livePrices), [baseAssets, livePrices]);

  // Every Core view (KPIs, allocation, backtest, rebalancing) reads the mode's own portfolio.
  const ledger = portfolios[ledgerType];
  const visible = ledger.positions;
  const scores = useCanonicalScores(visible.map((position) => position.ticker));
  const stats = calculatePortfolioStats(visible, assets, scores);
  const cashBalance = ledger.cashBalance;
  const valuation = computePortfolioValuation(
    ledger,
    Object.fromEntries(assets.map((asset) => [asset.ticker.toUpperCase(), asset.current_price])),
  );
  const drag = executionDrag(ledger.transactions);
  const tradeCount = ledger.transactions.filter(
    (transaction) => transaction.type === 'buy' || transaction.type === 'sell',
  ).length;
  const closedCount = ledger.transactions.filter(
    (transaction) => transaction.type === 'sell',
  ).length;

  let dayChange = 0;
  let hasDayChange = false;
  for (const position of visible) {
    const asset = assets.find((candidate) => candidate.ticker === position.ticker);
    const change = asset?.change_24h;
    if (change == null || !Number.isFinite(change)) continue;
    const price = asset?.current_price ?? position.buyPrice;
    dayChange += price * position.shares * change;
    hasDayChange = true;
  }
  const dayChangePct = stats.totalValue > 0 ? (dayChange / stats.totalValue) * 100 : 0;
  const dayTone: 'pnl-up' | 'pnl-down' | undefined = hasDayChange
    ? dayChange >= 0
      ? 'pnl-up'
      : 'pnl-down'
    : undefined;
  let dayIcon = <Activity size={18} />;
  if (dayTone === 'pnl-up') dayIcon = <TrendingUp size={18} />;
  else if (dayTone === 'pnl-down') dayIcon = <TrendingDown size={18} />;

  async function handleShare() {
    if (!user) {
      setAuthOpen(true);
      toast.info('Sign in to create a public portfolio link.');
      return;
    }

    setSharing(true);
    const id = createSharedPortfolioId();
    try {
      await publishSharedPortfolio({
        id,
        userId: user.id,
        snapshot: await buildSharedPortfolioSnapshot(visible, assets),
      });
    } catch {
      toast.error("Couldn't create a public link. Please try again.");
      return;
    } finally {
      setSharing(false);
    }

    const publicUrl = new URL(`/p/${id}`, window.location.origin).toString();
    try {
      await navigator.clipboard.writeText(publicUrl);
      toast.success('Public link copied to clipboard!');
    } catch {
      // Safari drops clipboard access once the publish request has been awaited.
      // The link exists, so keep it on screen with a Copy button (a fresh user
      // gesture) until it is copied or closed.
      toast.success('Public link created', {
        id: publicUrl,
        description: publicUrl,
        duration: Infinity,
        closeButton: true,
        action: {
          label: 'Copy',
          onClick: (event) => {
            // Sonner dismisses on action click unless prevented; keep the link
            // visible until the copy actually succeeds.
            event.preventDefault();
            // The async wrapper still calls writeText synchronously (keeping the
            // click's user activation) but turns a missing Clipboard API — a
            // sync TypeError in insecure contexts — into a handled rejection.
            (async () => navigator.clipboard.writeText(publicUrl))().then(
              () => {
                toast.dismiss(publicUrl);
                toast.success('Public link copied to clipboard!');
              },
              () => toast.error("Couldn't copy. Select the link above and copy it manually."),
            );
          },
        },
      });
    }
  }

  function handleCashAction(type: 'deposit' | 'withdrawal') {
    const amount = Number(cashAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error('Enter an amount greater than $0.');
      return;
    }
    const applied =
      type === 'deposit'
        ? depositPortfolioCash(ledgerType, amount)
        : withdrawPortfolioCash(ledgerType, amount);
    if (!applied) {
      toast.error('Cannot withdraw more than your available cash.');
      return;
    }
    toast.success(`${type === 'deposit' ? 'Deposited' : 'Withdrew'} ${formatPrice(amount)}`);
    setCashAmount('');
  }

  function handleClosePosition(position: Position, livePrice: number | undefined) {
    // Live Tracking mirrors a real account, so closing only stops tracking the row.
    if (!position.isSimulation) {
      removePosition(position.id);
      return;
    }
    if (livePrice === undefined) return; // HoldingRow disables close without a live price
    const result = executeSell('long_term_sim', {
      ticker: position.ticker,
      shares: position.shares,
      price: livePrice,
      fee: position.shares * livePrice * FEE_RATE,
      timestamp: new Date().toISOString(),
    });
    if (!result.ok) {
      toast.error(result.error ?? 'Close rejected');
      return;
    }
    toast.success(`Closed ${position.ticker}`, {
      description: `Realized ${formatPnl(result.realizedPnl ?? 0)} — simulated fill, recorded in the ledger.`,
    });
  }

  async function handleSaveToCloud() {
    if (!user) {
      setAuthOpen(true);
      return;
    }
    if (saveBlocked) {
      toast.error('Portfolio is still syncing — try again in a moment.');
      return;
    }
    try {
      // Full v3 envelope: the legacy array would drop cash, ledgers and paper state.
      await savePortfolioStateV3(user.id, { version: 3, activePortfolioType, portfolios });
      toast.success('Portfolio saved to cloud');
    } catch (error) {
      if (error instanceof PortfolioNotHydratedError) {
        toast.error('Portfolio is still syncing — try again in a moment.');
        return;
      }
      toast.error("Couldn't save portfolio");
    }
  }

  return (
    <section className="portfolio" aria-label="Portfolio dashboard">
      <header className="portfolio-head" data-tour="wealth">
        <div>
          <h2 className="portfolio-title">Wealth Management</h2>
          <p className="portfolio-subtitle">
            Simulate strategies or track live holdings — one engine, zero noise.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="share-portfolio-button"
            onClick={handleShare}
            disabled={sharing}
            title="Creates a public link with allocation %, returns %, max drawdown, alpha vs BTC, and quant scores only. No balances or share counts are shared."
          >
            <Share2 size={15} />
            {sharing ? 'Creating link…' : 'Share Portfolio'}
          </button>
          <button
            type="button"
            className="save-cloud-button"
            onClick={handleSaveToCloud}
            disabled={saveBlocked}
            title={
              saveBlocked ? 'Portfolio is syncing — save is temporarily unavailable' : undefined
            }
          >
            <CloudUpload size={15} />
            Save to Cloud
          </button>
          <Segmented
            value={mode}
            ariaLabel="Portfolio mode"
            onChange={setMode}
            options={[
              { value: 'simulation', label: 'Simulation' },
              { value: 'live', label: 'Live Tracking' },
            ]}
          />
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Invested"
          value={formatPrice(valuation.investedCostBasis)}
          sub={`Cost basis · ${visible.length} ${visible.length === 1 ? 'holding' : 'holdings'}`}
          icon={<Wallet size={18} />}
        />
        <KpiCard
          label="Current Value"
          value={formatPrice(valuation.marketValue)}
          sub={hasDayChange ? `24h ${formatPnl(dayChange)}` : 'Live prices'}
          icon={dayIcon}
          accent={dayTone === 'pnl-up' ? 'green' : dayTone === 'pnl-down' ? 'red' : 'blue'}
          tone={dayTone}
        />
        <KpiCard
          label="Profit / Loss"
          value={formatPnl(valuation.unrealizedPnl)}
          sub={formatSignedPercent(valuation.unrealizedPnlPct)}
          icon={<Briefcase size={18} />}
          accent={valuation.unrealizedPnl >= 0 ? 'green' : 'red'}
          tone={valuation.unrealizedPnl >= 0 ? 'pnl-up' : 'pnl-down'}
        />
        <div className={cn('kpi-card kpi-card-health', healthTone(stats.healthScore))}>
          <span className="overview-label">Signal Health</span>
          <HealthRing score={stats.healthScore} />
        </div>
      </div>

      <section
        className="portfolio-telemetry"
        aria-label="P&L attribution"
        data-tour="pnl-attribution"
      >
        <TelemetryItem
          label="Unrealized P&L"
          value={formatPnl(valuation.unrealizedPnl)}
          sub={`${formatSignedPercent(valuation.unrealizedPnlPct)} · open lots, net of fees`}
          icon={<TrendingUp size={16} />}
          accent="violet"
          tone={pnlTone(valuation.unrealizedPnl)}
        />
        <TelemetryItem
          label="Realized P&L"
          value={formatPnl(valuation.realizedPnl)}
          sub={`${closedCount} closed ${closedCount === 1 ? 'trade' : 'trades'} · FIFO lots`}
          icon={<CheckCircle2 size={16} />}
          accent="green"
          tone={pnlTone(valuation.realizedPnl)}
        />
        <TelemetryItem
          label="Execution Drag"
          value={formatPrice(drag)}
          sub={`Fees + slippage · ${tradeCount} ${tradeCount === 1 ? 'fill' : 'fills'}`}
          icon={<Gauge size={16} />}
          accent="amber"
        />
      </section>

      <div className="portfolio-workspace-grid">
        <section
          className="portfolio-section portfolio-workspace-card portfolio-holdings-pane"
          aria-label="Holdings"
        >
          <div className="portfolio-workspace-head">
            <div className="portfolio-section-head portfolio-section-head-compact">
              <h3 className="portfolio-section-title">Holdings</h3>
              <div className="portfolio-section-actions">
                <span className="portfolio-count">
                  {visible.length} POSITION{visible.length === 1 ? '' : 'S'}
                </span>
                {mode === 'live' && <AddPositionModal />}
              </div>
            </div>
            <div className="portfolio-cash-bar" aria-label="Cash controls">
              <span className="portfolio-cash">
                <Wallet size={14} /> {formatPrice(cashBalance)} available
              </span>
              <div className="portfolio-cash-controls">
                <input
                  className="portfolio-cash-input"
                  name="portfolio-cash-amount"
                  type="number"
                  min="0"
                  step="any"
                  inputMode="decimal"
                  placeholder="Amount"
                  aria-label="Cash amount"
                  value={cashAmount}
                  onChange={(event) => setCashAmount(event.target.value)}
                />
                <button
                  type="button"
                  className="portfolio-cash-btn"
                  onClick={() => handleCashAction('deposit')}
                >
                  Deposit
                </button>
                <button
                  type="button"
                  className="portfolio-cash-btn"
                  onClick={() => handleCashAction('withdrawal')}
                >
                  Withdraw
                </button>
              </div>
            </div>
          </div>
          {visible.length > 0 ? (
            <div className="holdings-list">
              <AnimatePresence>
                {visible.map((position) => (
                  <HoldingRow
                    key={position.id}
                    position={position}
                    assets={assets}
                    result={scores.get(position.ticker)}
                    onClose={handleClosePosition}
                    onUpdate={updatePosition}
                  />
                ))}
              </AnimatePresence>
            </div>
          ) : (
            <div className="holdings-empty">
              <Briefcase size={26} />
              <span className="holdings-empty-title">
                {mode === 'simulation' ? 'No simulation positions' : 'No live positions yet'}
              </span>
              <span className="holdings-empty-sub">
                {mode === 'simulation'
                  ? 'Your paper portfolio is empty. Add a position to start simulating.'
                  : 'Connect your broker to start tracking real holdings.'}
              </span>
            </div>
          )}
        </section>

        <aside className="portfolio-side-stack" aria-label="Allocation and rebalancing">
          <section
            className="portfolio-section portfolio-workspace-card portfolio-allocation-card"
            aria-label="Allocation"
          >
            <div className="portfolio-section-head">
              <h3 className="portfolio-section-title">Allocation</h3>
            </div>
            <AllocationChart positions={visible} assets={assets} />
          </section>
          <section
            className="portfolio-section portfolio-workspace-card portfolio-rebalance-card"
            aria-label="Rebalancing"
          >
            <div className="portfolio-section-head">
              <h3 className="portfolio-section-title">Rebalancing</h3>
            </div>
            <RebalancePanel portfolioType={ledgerType} assets={assets} />
          </section>
        </aside>
      </div>

      <section className="portfolio-section analytics-workspace" aria-label="Portfolio analytics">
        <div className="analytics-workspace-tabs" aria-label="Portfolio analytics views">
          <button
            type="button"
            className={cn('analytics-workspace-tab', analyticsTab === 'backtest' && 'is-active')}
            aria-pressed={analyticsTab === 'backtest'}
            onClick={() => setAnalyticsTab('backtest')}
          >
            Strategy Backtest
          </button>
          <button
            type="button"
            className={cn('analytics-workspace-tab', analyticsTab === 'ledger' && 'is-active')}
            aria-expanded={analyticsTab === 'ledger'}
            aria-controls="portfolio-ledger-workspace"
            onClick={() => setAnalyticsTab('ledger')}
          >
            Trade Ledger ({ledger.transactions.length})
          </button>
          <span className="portfolio-count analytics-entry-count">
            {ledger.transactions.length} ENTR{ledger.transactions.length === 1 ? 'Y' : 'IES'}
          </span>
          <button
            type="button"
            className="portfolio-cash-btn ledger-export analytics-export"
            disabled={ledger.transactions.length === 0}
            onClick={() =>
              downloadCsv(
                `zerochart-ledger-${mode === 'simulation' ? 'simulation' : 'live'}.csv`,
                tradeLedgerCsv(ledger.transactions),
              )
            }
          >
            <Download size={13} /> Export CSV
          </button>
        </div>
        <div className="analytics-workspace-panel">
          {analyticsTab === 'backtest' ? (
            <div aria-label="Historical simulation">
              {/* Keyed so one portfolio's result never shows under another. */}
              <BacktestChart key={ledgerType} positions={visible} assets={assets} />
            </div>
          ) : (
            <div id="portfolio-ledger-workspace">
              <TradeLedger
                embedded
                transactions={ledger.transactions}
                filename={`zerochart-ledger-${mode === 'simulation' ? 'simulation' : 'live'}.csv`}
              />
            </div>
          )}
        </div>
      </section>

      <section className="portfolio-section" aria-label="Price alerts">
        <PriceAlerts assets={assets} user={user} />
      </section>

      <AuthModal open={authOpen} onOpenChange={setAuthOpen} />
    </section>
  );
});
