import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  ArrowDown,
  ArrowUpRight,
  Briefcase,
  CandlestickChart,
  Radio,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RoboAdvisor } from '@/components/RoboAdvisor';
import { BrokerModal } from '@/components/BrokerModal';
import { PortfolioDashboard } from '@/components/PortfolioDashboard';
import { Segmented } from '@/components/Segmented';
import { Sparkline } from '@/components/Sparkline';
import { ThemeToggle } from '@/components/ThemeToggle';
import { TradeTicket } from '@/components/TradeTicket';
import {
  calculateSignalScore,
  fetchAssets,
  formatChange,
  formatPrice,
  formatReward,
  formatRisk,
  formatTradingViewSymbol,
  generateTrendData,
  getAssetClass,
  sampleAssets,
  type Asset,
  type AssetClass,
} from '@/lib/assets';
import { cn } from '@/lib/utils';
import { usePriceFlash } from '@/hooks/usePriceFlash';
import { useSimulatedPrices } from '@/hooks/useSimulatedPrices';
import { AdvancedRealTimeChart } from 'react-ts-tradingview-widgets';

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [
      { title: 'ZeroChart — Signal over noise' },
      {
        name: 'description',
        content:
          'An algorithmic signal terminal with live charts for long-term conviction and asymmetric opportunities. Track clear asset signals with ZeroChart.',
      },
      { property: 'og:title', content: 'ZeroChart — Signal over noise' },
      {
        property: 'og:description',
        content:
          'Stable and radar asset signals in one focused, algorithmic signal terminal with live charts.',
      },
      { property: 'og:type', content: 'website' },
      { name: 'twitter:card', content: 'summary_large_image' },
    ],
  }),
  component: Index,
});

function scoreToneOf(score: number) {
  return score > 85 ? 'score-high' : score >= 70 ? 'score-mid' : 'score-low';
}

function ScoreRing({ score }: { score: number }) {
  return (
    <div
      className={cn('score-ring', scoreToneOf(score))}
      role="img"
      aria-label={`Signal score ${score} out of 100`}
    >
      <span className="score-ring-value">{score}</span>
      <span className="score-ring-label">SIGNAL</span>
    </div>
  );
}

function Hero({ asset }: { asset: Asset }) {
  const score = calculateSignalScore(asset);
  const surging = asset.volume_spike !== null && asset.volume_spike > 1;
  return (
    <section className="hero" aria-label="Top signal">
      <div className="hero-glow" aria-hidden="true" />
      <div className="hero-content">
        <span className="hero-badge">🔥 TOP SIGNAL RIGHT NOW</span>
        <div className="hero-headline">
          <div>
            <h2 className="hero-ticker">{asset.ticker}</h2>
            <div className="hero-price">{formatPrice(asset.current_price)}</div>
          </div>
          <ScoreRing score={score} />
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
          <TradeTicket asset={asset} variant="hero" />
          <BrokerModal asset={asset} variant="hero" />
        </div>
      </div>
      <div className="hero-chart">
        <AdvancedRealTimeChart
          key={asset.ticker}
          symbol={formatTradingViewSymbol(asset.ticker)}
          theme="dark"
          autosize={true}
        />
      </div>
    </section>
  );
}

type MarketView = 'signals' | 'gainers' | 'losers';
type AssetClassFilter = 'All' | AssetClass;

const MARKET_VIEWS: { id: MarketView; label: string }[] = [
  { id: 'signals', label: '🔥 Top Signals' },
  { id: 'gainers', label: '📈 Top Gainers' },
  { id: 'losers', label: '📉 Top Losers' },
];

const ASSET_CLASS_FILTERS: AssetClassFilter[] = ['All', 'Stocks', 'Crypto', 'Forex'];

function sortMarkets(assets: Asset[], view: MarketView): Asset[] {
  const list = [...assets];
  if (view === 'signals')
    return list.sort((a, b) => calculateSignalScore(b) - calculateSignalScore(a));
  if (view === 'gainers')
    return list.sort((a, b) => (b.change_24h ?? -Infinity) - (a.change_24h ?? -Infinity));
  return list.sort((a, b) => (a.change_24h ?? Infinity) - (b.change_24h ?? Infinity));
}

function MarketRow({ asset, rank }: { asset: Asset; rank: number }) {
  const score = calculateSignalScore(asset);
  const change = asset.change_24h ?? null;
  const priceFlash = usePriceFlash(asset.current_price);
  return (
    <div className="markets-row">
      <span className="markets-rank">#{rank}</span>
      <span className="markets-ticker" title={asset.name || asset.ticker}>
        {asset.ticker}
      </span>
      <span className={cn('markets-price', priceFlash)}>{formatPrice(asset.current_price)}</span>
      <Sparkline
        data={generateTrendData(asset.current_price, asset.change_24h ?? null)}
        change={asset.change_24h ?? null}
      />
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
        <span className={cn('markets-score', scoreToneOf(score))}>{score}</span>
      </span>
      <span className="markets-trade">
        <BrokerModal asset={asset} />
      </span>
    </div>
  );
}

function Index() {
  const [source, setSource] = useState<'auto' | 'live' | 'sample'>('auto');
  const [marketView, setMarketView] = useState<MarketView>('signals');
  const [assetClass, setAssetClass] = useState<AssetClassFilter>('All');
  const [view, setView] = useState<'scanner' | 'portfolio'>('scanner');
  const query = useQuery({
    queryKey: ['assets-status'],
    queryFn: fetchAssets,
    refetchInterval: 60000,
    retry: 1,
  });
  const preview =
    source === 'sample' || (source === 'auto' && query.isSuccess && query.data.length === 0);
  const baseAssets = preview ? sampleAssets : query.data || [];
  const assets = useSimulatedPrices(baseAssets);
  const topPick = [...assets].sort((a, b) => calculateSignalScore(b) - calculateSignalScore(a))[0];
  const filtered =
    assetClass === 'All' ? assets : assets.filter((a) => getAssetClass(a.ticker) === assetClass);
  const rows = sortMarkets(filtered, marketView);

  return (
    <div className="min-h-screen text-foreground">
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
                value: 'scanner',
                label: (
                  <>
                    <CandlestickChart size={14} /> Scanner
                  </>
                ),
              },
              {
                value: 'portfolio',
                label: (
                  <>
                    <Briefcase size={14} /> Portfolio
                  </>
                ),
              },
            ]}
          />
          <div className="flex shrink-0 items-center gap-4">
            <span className="connection-status">
              <span className={cn('status-dot', query.isError && !preview && 'status-error')} />
              {preview
                ? 'Sample data'
                : query.isPending
                  ? 'Connecting'
                  : query.isError
                    ? 'Offline'
                    : 'Live'}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9 flex-shrink-0"
              aria-label="Refresh signals"
              title="Refresh signals"
              disabled={query.isFetching}
              onClick={() => query.refetch()}
            >
              <RefreshCw size={14} className={cn(query.isFetching && 'animate-spin')} />
            </Button>
            <ThemeToggle />
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
        {view === 'portfolio' ? (
          <PortfolioDashboard assets={assets} />
        ) : query.isPending && !preview ? (
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
        ) : topPick ? (
          <>
            <Hero asset={topPick} />
            <section className="markets" aria-label="Markets">
              <div className="markets-head">
                <h2 className="markets-title">Markets</h2>
                <div className="markets-head-actions">
                  <span className="markets-count font-mono">
                    {rows.length} ASSET{rows.length === 1 ? '' : 'S'}
                  </span>
                  <RoboAdvisor assets={assets} onInvest={() => setView('portfolio')} />
                </div>
              </div>
              <div className="markets-controls">
                <div className="markets-pills" role="group" aria-label="Market view">
                  {MARKET_VIEWS.map((view) => (
                    <button
                      key={view.id}
                      type="button"
                      className={cn(
                        'markets-pill',
                        marketView === view.id && 'markets-pill-active',
                      )}
                      aria-pressed={marketView === view.id}
                      onClick={() => setMarketView(view.id)}
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
                      onClick={() => setAssetClass(filter)}
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
                    <MarketRow key={asset.ticker} asset={asset} rank={index + 1} />
                  ))}
                </div>
              )}
            </section>
          </>
        ) : !query.isError ? (
          <div className="empty-state">
            <CandlestickChart size={32} className="mx-auto mb-4 text-muted-foreground" />
            <h3>No signals yet</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Your watchlist is empty. Check back soon, or preview sample data.
            </p>
            <Button variant="outline" className="mt-5" onClick={() => setSource('sample')}>
              View sample data
            </Button>
          </div>
        ) : null}
      </main>
      <footer className="terminal-footer page-width">
        <div className="flex items-center gap-2">
          <Zap size={13} />
          <span>Algorithmic signals. Live charts. Zero noise.</span>
        </div>
        <span>AI analysis is informational. Not financial advice.</span>
        <span className="font-mono text-[10px]">
          ZEROCHART
          <ArrowDown size={10} className="ml-1 inline" />
        </span>
      </footer>
    </div>
  );
}
