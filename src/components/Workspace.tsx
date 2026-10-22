import { useMatch, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { lazy, memo, Suspense, useEffect, useState, type ReactNode } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowUpRight,
  CandlestickChart,
  Flame,
  LogOut,
  Radio,
  RefreshCw,
  Search,
  TrendingDown,
  TrendingUp,
  UserRound,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { AssetIcon } from '@/components/AssetIcon';
import { BrokerModal } from '@/components/BrokerModal';
import { PriceAlerts } from '@/components/PriceAlerts';
import { LandingPage } from '@/components/LandingPage';
import { TourGuide } from '@/components/TourGuide';
import { Segmented } from '@/components/Segmented';
import { SetAlertButton } from '@/components/SetAlertModal';
import { FreshnessBadge } from '@/components/FreshnessBadge';
import { ThemeToggle } from '@/components/ThemeToggle';
import { TradeTicket } from '@/components/TradeTicket';
import { TacticalSignals } from '@/components/TacticalSignals';
import { TradingViewWidget } from '@/components/TradingViewWidget';
import { InsufficientDataBadge } from '@/components/InsufficientDataBadge';
import {
  fetchAssets,
  formatChange,
  formatPrice,
  formatReward,
  formatRisk,
  formatTradingViewSymbol,
  generateTrendData,
  getAssetClass,
  sampleAssets,
  scoreTone,
  type Asset,
  type AssetClass,
} from '@/lib/assets';
import { cn } from '@/lib/utils';
import { toBinanceSymbol } from '@/lib/binance';
import { scoreOf, type CanonicalResult } from '@/lib/canonicalModel';
import { useCanonicalScores } from '@/hooks/useCanonicalScores';
import { assetFreshness } from '@/lib/freshness';
import { useConnectionState, useLivePrice } from '@/lib/livePriceStore';
import type { User } from '@supabase/supabase-js';
import { useAuth } from '@/lib/authStore';
import { usePortfolio } from '@/lib/portfolioStore';
import { useHydrationState } from '@/lib/hydrationStore';
import { CLOSED_BETA } from '@/lib/closedBeta';
import { recordWalkForward } from '@/lib/engine/walkForwardLogger';
import { computePortfolioValuation } from '@/lib/portfolioAccounting';
import { useBinanceWebSocket } from '@/hooks/useBinanceWebSocket';
import { useAlertEngine } from '@/hooks/useAlertEngine';
import { usePriceFlash } from '@/hooks/usePriceFlash';

// Loaded on demand so the zone panels, modals, recharts and lightweight-charts stay out of
// the Workspace chunk. SSR is unaffected: the server always renders the auth-loading shell.
const AssetDetailsModal = lazy(() =>
  import('@/components/AssetDetailsModal').then((m) => ({ default: m.AssetDetailsModal })),
);
const AuthModal = lazy(() =>
  import('@/components/AuthModal').then((m) => ({ default: m.AuthModal })),
);
const RoboAdvisor = lazy(() =>
  import('@/components/RoboAdvisor').then((m) => ({ default: m.RoboAdvisor })),
);
const PortfolioDashboard = lazy(() =>
  import('@/components/PortfolioDashboard').then((m) => ({ default: m.PortfolioDashboard })),
);
const PaperTradingTerminal = lazy(() =>
  import('@/components/PaperTradingTerminal').then((m) => ({ default: m.PaperTradingTerminal })),
);
const AccountPanel = lazy(() =>
  import('@/components/AccountPanel').then((m) => ({ default: m.AccountPanel })),
);
const Sparkline = lazy(() =>
  import('@/components/Sparkline').then((m) => ({ default: m.Sparkline })),
);

/** Holds the sparkline's grid cell while recharts loads. */
const sparklineFallback = <div className="sparkline" style={{ height: 30 }} aria-hidden="true" />;
const zoneFallback = <div aria-busy="true" className="skeleton h-96 w-full" />;

function ScoreRing({ result }: Readonly<{ result: CanonicalResult | undefined }>) {
  const score = scoreOf(result);
  if (score === null) {
    const insufficient = result?.status === 'INSUFFICIENT_DATA';
    return (
      <div
        className="score-ring score-none"
        role="img"
        aria-label={insufficient ? 'Signal score: not enough data' : 'Signal score loading'}
      >
        {insufficient ? <InsufficientDataBadge /> : <span className="score-ring-value">—</span>}
        <span className="score-ring-label">SIGNAL</span>
      </div>
    );
  }
  return (
    <div
      className={cn('score-ring', scoreTone(score))}
      role="img"
      aria-label={`Signal score ${score} out of 100`}
    >
      <span className="score-ring-value">{score}</span>
      <span className="score-ring-label">SIGNAL</span>
    </div>
  );
}

function Hero({ asset, result }: Readonly<{ asset: Asset; result: CanonicalResult | undefined }>) {
  const surging = asset.volume_spike !== null && asset.volume_spike > 1;
  return (
    <section className="hero" data-tour="hero" aria-label="Top signal">
      <div className="hero-glow" aria-hidden="true" />
      <div className="hero-content">
        <span className="hero-badge">
          <Flame size={14} /> TOP SIGNAL RIGHT NOW
        </span>
        <div className="hero-headline">
          <div>
            <div className="hero-ticker-row">
              <AssetIcon symbol={asset.ticker} name={asset.name} size="lg" />
              <h2 className="hero-ticker">{asset.ticker}</h2>
            </div>
            <div className="hero-price">{formatPrice(asset.current_price)}</div>
          </div>
          <ScoreRing result={result} />
        </div>
        <p className="hero-name">{asset.name || 'Asset'}</p>
        <div className="hero-stats">
          <div className="hero-stat">
            <span className="hero-stat-label">Upside Potential</span>
            <span className="hero-stat-value">{formatReward(asset.reward_pct)}</span>
          </div>
          <div className="hero-stat">
            <span className="hero-stat-label">Risk</span>
            <span className="hero-stat-value hero-stat-risk">{formatRisk(asset.risk_pct)}</span>
          </div>
          {surging && (
            <span className="volume-badge">
              <TrendingUp size={15} /> Volume is surging
            </span>
          )}
        </div>
        <div className="hero-action">
          <TradeTicket
            asset={asset}
            variant="hero"
            portfolioType="paper_trading"
            intent="tactical"
          />
          <BrokerModal asset={asset} variant="hero" />
        </div>
      </div>
      <div className="hero-chart">
        <TradingViewWidget symbol={formatTradingViewSymbol(asset.ticker)} />
      </div>
    </section>
  );
}

type MarketView = 'signals' | 'gainers' | 'losers';
type AssetClassFilter = 'All' | AssetClass;

const MARKET_VIEWS: { id: MarketView; label: ReactNode }[] = [
  {
    id: 'signals',
    label: (
      <>
        <Flame size={14} /> Top Signals
      </>
    ),
  },
  {
    id: 'gainers',
    label: (
      <>
        <TrendingUp size={14} /> Top Gainers
      </>
    ),
  },
  {
    id: 'losers',
    label: (
      <>
        <TrendingDown size={14} /> Top Losers
      </>
    ),
  },
];

// Crypto spot (Binance) leads: the closed beta evaluates it first.
const ASSET_CLASS_FILTERS: AssetClassFilter[] = ['Crypto', 'Stocks', 'Forex', 'All'];

/** Canonical score for ranking; unscored assets (loading or not enough data) sink last. */
function rankScore(scores: ReadonlyMap<string, CanonicalResult>, asset: Asset): number {
  return scoreOf(scores.get(asset.ticker)) ?? -1;
}

function sortMarkets(
  assets: Asset[],
  view: MarketView,
  scores: ReadonlyMap<string, CanonicalResult>,
): Asset[] {
  const list = [...assets];
  if (view === 'signals') return list.sort((a, b) => rankScore(scores, b) - rankScore(scores, a));
  if (view === 'gainers')
    return list.sort((a, b) => (b.change_24h ?? -Infinity) - (a.change_24h ?? -Infinity));
  return list.sort((a, b) => (a.change_24h ?? Infinity) - (b.change_24h ?? Infinity));
}

function MarketScore({
  score,
  result,
}: Readonly<{ score: number | null; result: CanonicalResult | undefined }>) {
  if (score !== null) {
    return <span className={cn('markets-score', scoreTone(score))}>{score}</span>;
  }
  if (result?.status === 'INSUFFICIENT_DATA') return <InsufficientDataBadge compact />;
  return (
    <span className="markets-score score-none" aria-label="Signal score loading">
      —
    </span>
  );
}

const MarketRow = memo(function MarketRow({
  asset,
  result,
  rank,
  onSelect,
}: {
  asset: Asset;
  result: CanonicalResult | undefined;
  rank: number;
  onSelect: (asset: Asset) => void;
}) {
  const live = useLivePrice(toBinanceSymbol(asset.ticker));
  const currentPrice = live?.price ?? asset.current_price;
  const change = live?.change ?? asset.change_24h ?? null;
  const score = scoreOf(result);
  const priceFlash = usePriceFlash(currentPrice);
  const streamConnected = useConnectionState() === 'connected';
  const freshness = assetFreshness(asset, live, { streamConnected });
  return (
    <div
      className="markets-row markets-row-clickable"
      role="button"
      tabIndex={0}
      aria-label={`View ${asset.ticker} details`}
      onClick={() => onSelect(asset)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(asset);
        }
      }}
    >
      <span className="markets-rank">#{rank}</span>
      <span className="markets-ticker" title={asset.name || asset.ticker}>
        <AssetIcon symbol={asset.ticker} name={asset.name} size="sm" />
        <span className="markets-ticker-label">{asset.ticker}</span>
        <SetAlertButton asset={asset} />
      </span>
      <span className="markets-price-cell">
        <span className={cn('markets-price', priceFlash)}>{formatPrice(currentPrice)}</span>
        <FreshnessBadge state={freshness} />
      </span>
      <Suspense fallback={sparklineFallback}>
        <Sparkline data={generateTrendData(currentPrice, change)} change={change} />
      </Suspense>
      <span
        className={cn(
          'markets-change',
          change != null && change > 0 && 'markets-change-up',
          change != null && change < 0 && 'markets-change-down',
        )}
      >
        {change != null && change > 0 && <TrendingUp size={13} />}
        {change != null && change < 0 && <TrendingDown size={13} />}
        {formatChange(change)}
      </span>
      <span className="markets-score-cell">
        <MarketScore score={score} result={result} />
      </span>
      <span // NOSONAR(S6819): keeps Trade clicks (and its modal's) from selecting the row
        role="presentation"
        className="markets-trade"
        onClick={(e) => e.stopPropagation()}
      >
        <BrokerModal asset={asset} />
      </span>
    </div>
  );
});

type WorkspaceView = 'research' | 'paper' | 'account';

const VIEW_PATHS = {
  research: '/',
  paper: '/paper-trading',
  account: '/account',
} as const satisfies Record<WorkspaceView, string>;

/** The feed status pill: the connection first, then where the prices come from. */
function feedStatusLabel(
  reconnecting: boolean,
  preview: boolean,
  query: { isPending: boolean; isError: boolean },
): string {
  if (reconnecting) return 'Reconnecting…';
  if (preview) return 'Sample data';
  if (query.isPending) return 'Connecting';
  if (query.isError) return 'Offline';
  return 'Live';
}

function HeaderProfile({ user, onSignOut }: Readonly<{ user: User; onSignOut: () => void }>) {
  return (
    <>
      <span className="header-divider" aria-hidden="true" />
      <div className="header-profile flex items-center gap-1.5">
        <Avatar className="header-avatar h-8 w-8 border border-border">
          <AvatarFallback className="text-[11px] font-semibold">
            {(user.email ?? '?').slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <Button
          variant="ghost"
          size="icon"
          className="header-logout h-9 w-9 flex-shrink-0 text-muted-foreground hover:text-foreground"
          aria-label="Log out"
          title="Log out"
          onClick={onSignOut}
        >
          <LogOut size={15} />
        </Button>
      </div>
    </>
  );
}

function MarketsSkeleton() {
  return (
    <div aria-busy="true">
      <div className="hero skeleton-hero">
        <div className="skeleton h-7 w-56" />
        <div className="skeleton mt-5 h-14 w-44" />
        <div className="skeleton mt-6 h-9 w-64" />
        <div className="skeleton mt-6 h-4 w-full max-w-md" />
      </div>
      <div className="markets-table mt-14">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="markets-row markets-row-skeleton">
            <div className="skeleton markets-skeleton" />
          </div>
        ))}
      </div>
    </div>
  );
}

function NoSignals({ onPreview }: Readonly<{ onPreview: () => void }>) {
  return (
    <div className="empty-state">
      <CandlestickChart size={32} className="mx-auto mb-4 text-muted-foreground" />
      <h3>No signals yet</h3>
      <p className="mt-2 text-sm text-muted-foreground">
        Your watchlist is empty. Check back soon, or preview sample data.
      </p>
      <Button variant="outline" className="mt-5" onClick={onPreview}>
        View sample data
      </Button>
    </div>
  );
}

function MarketsSection({
  rows,
  scores,
  assets,
  marketView,
  onMarketView,
  assetClass,
  onAssetClass,
  onSelect,
  onInvest,
}: Readonly<{
  rows: Asset[];
  scores: ReadonlyMap<string, CanonicalResult>;
  assets: Asset[];
  marketView: MarketView;
  onMarketView: (view: MarketView) => void;
  assetClass: AssetClassFilter;
  onAssetClass: (filter: AssetClassFilter) => void;
  onSelect: (asset: Asset) => void;
  onInvest: () => void;
}>) {
  return (
    <section className="markets" data-tour="markets" aria-label="Markets">
      <div className="markets-head">
        <h2 className="markets-title">Markets</h2>
        <div className="markets-head-actions">
          <span className="markets-count font-mono">
            {rows.length} ASSET{rows.length === 1 ? '' : 'S'}
          </span>
          <Suspense fallback={null}>
            <RoboAdvisor assets={assets} onInvest={onInvest} />
          </Suspense>
        </div>
      </div>
      <div className="markets-controls">
        <div className="markets-pills" role="group" aria-label="Market view">
          {MARKET_VIEWS.map((view) => (
            <button
              key={view.id}
              type="button"
              className={cn('markets-pill', marketView === view.id && 'markets-pill-active')}
              aria-pressed={marketView === view.id}
              onClick={() => onMarketView(view.id)}
            >
              {view.label}
            </button>
          ))}
        </div>
        <div className="markets-pills" role="group" aria-label="Asset class">
          {ASSET_CLASS_FILTERS.map((filter) => (
            <button
              key={filter}
              type="button"
              className={cn('markets-pill', assetClass === filter && 'markets-pill-active')}
              aria-pressed={assetClass === filter}
              onClick={() => onAssetClass(filter)}
            >
              {filter}
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="markets-empty">No assets match this filter.</div>
      ) : (
        <div className="markets-table">
          <div className="markets-row markets-row-head" aria-hidden="true">
            <span className="markets-head-cell markets-rank-head">#</span>
            <span className="markets-head-cell">Asset</span>
            <span className="markets-head-cell">Price</span>
            <span />
            <span className="markets-head-cell">24h %</span>
            <span className="markets-head-cell">Signal</span>
            <span />
          </div>
          {rows.map((asset, index) => (
            <MarketRow
              key={asset.ticker}
              asset={asset}
              result={scores.get(asset.ticker)}
              rank={index + 1}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** Research: a loading skeleton, the markets with today's top pick, or an empty watchlist. */
function ResearchZone({
  pending,
  failed,
  topPick,
  scores,
  assets,
  user,
  onPreview,
  markets,
}: Readonly<{
  pending: boolean;
  failed: boolean;
  topPick: Asset | undefined;
  scores: ReadonlyMap<string, CanonicalResult>;
  assets: Asset[];
  user: User | null;
  onPreview: () => void;
  markets: ReactNode;
}>) {
  if (pending) return <MarketsSkeleton />;
  if (!topPick) return failed ? null : <NoSignals onPreview={onPreview} />;
  return (
    <>
      <Hero asset={topPick} result={scores.get(topPick.ticker)} />
      <TacticalSignals assets={assets} />
      {markets}
      <section className="portfolio-section" aria-label="Price alerts">
        <PriceAlerts assets={assets} user={user} />
      </section>
    </>
  );
}

function Terminal() {
  const [source, setSource] = useState<'auto' | 'live' | 'sample'>('auto');
  const [marketView, setMarketView] = useState<MarketView>('signals');
  const [assetClass, setAssetClass] = useState<AssetClassFilter>('Crypto');
  // The URL is the source of truth: / (Research), /paper-trading, /account.
  const navigate = useNavigate();
  const onPaper = useMatch({ from: '/paper-trading', shouldThrow: false }) !== undefined;
  const onAccount = useMatch({ from: '/account', shouldThrow: false }) !== undefined;
  let view: WorkspaceView = 'research';
  if (onPaper) view = 'paper';
  else if (onAccount) view = 'account';
  const setView = (next: WorkspaceView) => void navigate({ to: VIEW_PATHS[next] });
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
  const { user, signOut } = useAuth();
  const { portfolios, activePortfolioType } = usePortfolio();
  const query = useQuery({
    queryKey: ['assets-status'],
    queryFn: fetchAssets,
    refetchInterval: 60000,
    retry: 1,
  });
  const preview =
    source === 'sample' || (source === 'auto' && query.isSuccess && query.data.length === 0);
  const baseAssets = preview ? sampleAssets : query.data || [];
  useBinanceWebSocket(baseAssets);
  // Single unified alert pipeline (M1-T4, F-5.1) — session + cloud alerts.
  useAlertEngine(baseAssets, user);
  // Walk-forward log: today's paper snapshot, once the server ledger has
  // replayed and live prices are in (never sample prices or a half-loaded account).
  const hydration = useHydrationState();
  const paper = portfolios.paper_trading;
  const liveAssets = query.isSuccess && !preview ? query.data : null;
  useEffect(() => {
    if (!user || !liveAssets || hydration.status !== 'ready' || hydration.userId !== user.id)
      return;
    const prices = Object.fromEntries(
      liveAssets.map((asset) => [asset.ticker.toUpperCase(), asset.current_price]),
    );
    recordWalkForward(user.id, paper, prices);
  }, [user, liveAssets, hydration, paper]);
  const connectionState = useConnectionState();
  const reconnecting = connectionState === 'reconnecting';
  const scores = useCanonicalScores(baseAssets.map((asset) => asset.ticker));
  const filtered =
    assetClass === 'All'
      ? baseAssets
      : baseAssets.filter((a) => getAssetClass(a.ticker) === assetClass);
  const best = (list: Asset[]) =>
    [...list].sort((a, b) => rankScore(scores, b) - rankScore(scores, a))[0];
  // The hero follows the asset-class filter, so it opens on the top crypto pick.
  const topPick = best(filtered) ?? best(baseAssets);
  const rows = sortMarkets(filtered, marketView, scores);

  return (
    <div className="min-h-screen text-foreground">
      {CLOSED_BETA && (
        <p className="beta-banner">
          <strong>Closed Beta: Paper Evaluation Period</strong> · Every system runs in simulated
          execution. No real orders, no real money.
        </p>
      )}
      <header className="terminal-header">
        <div className="page-width flex h-full items-center justify-between gap-3 sm:gap-4">
          <a href="/" className="flex shrink-0 items-center gap-2.5" aria-label="ZeroChart home">
            <span className="brand-mark">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
                <path
                  d="M4 6.5h16L4 17.5h16"
                  stroke="currentColor"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="brand-wordmark font-semibold">
              zerochart<span className="text-primary">.</span>
            </span>
            <span className="terminal-tag">SIGNALS</span>
          </a>
          <Segmented
            value={view}
            ariaLabel="Workspace"
            onChange={setView}
            options={[
              {
                value: 'research',
                label: (
                  <>
                    <Search size={14} /> Research
                  </>
                ),
              },
              {
                value: 'paper',
                label: (
                  <>
                    <Activity size={14} /> Paper Desk <span className="segment-tag">Sim</span>
                  </>
                ),
              },
              {
                value: 'account',
                label: (
                  <>
                    <UserRound size={14} /> Account
                  </>
                ),
              },
            ]}
          />
          <div className="header-actions flex shrink-0 items-center gap-3">
            <div className="header-utilities flex items-center gap-2.5">
              <span className="connection-status">
                <span
                  className={cn(
                    'status-dot',
                    reconnecting && 'status-reconnecting',
                    !reconnecting && query.isError && !preview && 'status-error',
                  )}
                />
                {feedStatusLabel(reconnecting, preview, query)}
              </span>
              <Button
                variant="outline"
                size="icon"
                className="header-refresh h-9 w-9 flex-shrink-0"
                aria-label="Refresh signals"
                title="Refresh signals"
                disabled={query.isFetching}
                onClick={() => query.refetch()}
              >
                <RefreshCw size={14} className={cn(query.isFetching && 'animate-spin')} />
              </Button>
              <ThemeToggle />
            </div>
            {user && <HeaderProfile user={user} onSignOut={() => void signOut()} />}
            <TourGuide onViewChange={setView} />
          </div>
        </div>
      </header>
      <main className="page-width w-full mx-auto pb-16 pt-8">
        {preview && (
          <div className="preview-note">
            <span className="flex items-center gap-2">
              <Radio size={13} />
              Sample data · Illustrative prices and signals, not live market data.
            </span>
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              onClick={() => setSource('live')}
            >
              View live data <ArrowUpRight size={12} />
            </Button>
          </div>
        )}
        {query.isError && !preview && (
          <div role="alert" className="error-banner">
            <span>
              {query.data
                ? 'Refresh failed. Showing the last available snapshot.'
                : 'Unable to load signals. Check your connection.'}
            </span>
            <Button variant="outline" size="sm" onClick={() => query.refetch()}>
              Retry
            </Button>
          </div>
        )}
        {view === 'paper' && (
          <Suspense fallback={zoneFallback}>
            <PaperTradingTerminal assets={baseAssets} />
            <hr className="zone-divider" />
            <PortfolioDashboard assets={baseAssets} portfolioType="long_term_sim" />
          </Suspense>
        )}
        {view === 'account' && (
          <Suspense fallback={zoneFallback}>
            <AccountPanel assets={baseAssets} />
          </Suspense>
        )}
        {view === 'research' && (
          <ResearchZone
            pending={query.isPending && !preview}
            failed={query.isError}
            topPick={topPick}
            scores={scores}
            assets={baseAssets}
            user={user}
            onPreview={() => setSource('sample')}
            markets={
              <MarketsSection
                rows={rows}
                scores={scores}
                assets={baseAssets}
                marketView={marketView}
                onMarketView={setMarketView}
                assetClass={assetClass}
                onAssetClass={setAssetClass}
                onSelect={setSelectedAsset}
                onInvest={() => setView('paper')}
              />
            }
          />
        )}
      </main>
      <footer className="terminal-footer page-width">
        <div className="flex items-center gap-2">
          <Zap size={13} />
          <span>Quantitative research and paper trading environment.</span>
        </div>
        <span>Quantitative analysis is informational. Not financial advice.</span>
        <span className="font-mono text-[10px]">
          ZEROCHART
          <ArrowDown size={10} className="ml-1 inline" />
        </span>
      </footer>

      {selectedAsset && (
        <Suspense fallback={null}>
          <AssetDetailsModal
            asset={selectedAsset}
            onClose={() => setSelectedAsset(null)}
            portfolioCapital={
              computePortfolioValuation(
                portfolios[activePortfolioType],
                Object.fromEntries(
                  baseAssets.map((a) => [a.ticker.toUpperCase(), a.current_price]),
                ),
              ).totalEquity
            }
          />
        </Suspense>
      )}
    </div>
  );
}

/** Auth-gated app shell shared by `/` (Research), `/paper-trading` and `/account`. */
export function Workspace() {
  const { user, loading } = useAuth();
  const [authOpen, setAuthOpen] = useState(false);

  if (loading) {
    return (
      <div className="min-h-screen text-foreground">
        <div className="page-width mx-auto flex min-h-screen w-full items-center justify-center">
          <div aria-busy="true" className="landing-loading">
            <span className="landing-loading-cursor" />
            {'Loading your workspace…'}
          </div>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <>
        <LandingPage onSignIn={() => setAuthOpen(true)} onGetStarted={() => setAuthOpen(true)} />
        <Suspense fallback={null}>
          <AuthModal open={authOpen} onOpenChange={setAuthOpen} />
        </Suspense>
      </>
    );
  }

  return <Terminal />;
}
