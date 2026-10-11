import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ArrowDown, ArrowUpRight, CandlestickChart, ExternalLink, Radio, RefreshCw, TrendingUp, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { calculateSignalScore, fetchAssets, formatPrice, formatReward, formatRisk, formatTradingViewSymbol, getBrokerRoute, sampleAssets, type Asset } from '@/lib/assets';
import { cn } from '@/lib/utils';
import { AdvancedRealTimeChart } from 'react-ts-tradingview-widgets';

export const Route = createFileRoute('/')({
  head: () => ({ meta: [
    { title: 'ZeroChart — Signal over noise' },
    { name: 'description', content: 'An algorithmic signal terminal with live charts for long-term conviction and asymmetric opportunities. Track clear asset signals with ZeroChart.' },
    { property: 'og:title', content: 'ZeroChart — Signal over noise' },
    { property: 'og:description', content: 'Stable and radar asset signals in one focused, algorithmic signal terminal with live charts.' },
    { property: 'og:type', content: 'website' },
    { name: 'twitter:card', content: 'summary_large_image' },
  ] }),
  component: Index,
});

function scoreToneOf(score: number) {
  return score > 85 ? 'score-high' : score >= 70 ? 'score-mid' : 'score-low';
}

function ScoreRing({ score }: { score: number }) {
  return (
    <div className={cn('score-ring', scoreToneOf(score))} role="img" aria-label={`Signal score ${score} out of 100`}>
      <span className="score-ring-value">{score}</span>
      <span className="score-ring-label">SIGNAL</span>
    </div>
  );
}

function TradeButton({ ticker, large = false }: { ticker: string; large?: boolean }) {
  const route = getBrokerRoute(ticker);
  return (
    <a
      className={cn('trade-button', large && 'trade-button-lg')}
      href={route.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${route.label} for ${ticker}`}
    >
      <ExternalLink size={large ? 16 : 13} /> {route.label}
    </a>
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
            <span className="volume-badge"><TrendingUp size={15} /> Volume is surging</span>
          )}
        </div>
        <div className="hero-action"><TradeButton ticker={asset.ticker} large /></div>
      </div>
      <div className="hero-chart">
        <AdvancedRealTimeChart key={asset.ticker} symbol={formatTradingViewSymbol(asset.ticker)} theme="dark" autosize={true} />
      </div>
    </section>
  );
}

function OpportunityCard({ asset }: { asset: Asset }) {
  const score = calculateSignalScore(asset);
  return (
    <article className="opportunity-card">
      <div className="opportunity-top">
        <span className="opportunity-ticker">{asset.ticker}</span>
        <span className={cn('opportunity-score', scoreToneOf(score))}>{score}</span>
      </div>
      <div className="opportunity-price">{formatPrice(asset.current_price)}</div>
      <div className="opportunity-action"><TradeButton ticker={asset.ticker} /></div>
    </article>
  );
}

function Index() {
  const [source, setSource] = useState<'auto' | 'live' | 'sample'>('auto');
  const query = useQuery({ queryKey: ['assets-status'], queryFn: fetchAssets, refetchInterval: 60000, retry: 1 });
  const preview = source === 'sample' || (source === 'auto' && query.isSuccess && query.data.length === 0);
  const assets = preview ? sampleAssets : query.data || [];
  const sorted = [...assets].sort((a, b) => calculateSignalScore(b) - calculateSignalScore(a));
  const topPick = sorted[0];
  const otherSignals = sorted.slice(1);

  return <div className="min-h-screen text-foreground">
    <header className="terminal-header"><div className="page-width flex h-full items-center justify-between gap-4"><a href="/" className="flex items-center gap-2.5" aria-label="ZeroChart home"><span className="brand-mark"><Zap size={19} fill="currentColor" /></span><span className="text-xl font-semibold">zerochart<span className="text-primary">.</span></span><span className="terminal-tag">SIGNALS</span></a><div className="flex items-center gap-4"><span className="connection-status"><span className={cn('status-dot', query.isError && !preview && 'status-error')} />{preview ? 'Sample data' : query.isPending ? 'Connecting' : query.isError ? 'Offline' : 'Live'}</span><Button variant="outline" size="icon" aria-label="Refresh signals" title="Refresh signals" disabled={query.isFetching} onClick={() => query.refetch()}><RefreshCw size={14} className={cn(query.isFetching && 'animate-spin')} /></Button></div></div></header>
    <main className="page-width pb-16 pt-8">
      {preview && <div className="preview-note"><span className="flex items-center gap-2"><Radio size={13} />Sample data · Illustrative prices and signals, not live market data.</span><Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setSource('live')}>View live data <ArrowUpRight size={12} /></Button></div>}
      {query.isError && !preview && <div role="alert" className="error-banner"><span>{query.data ? 'Refresh failed. Showing the last available snapshot.' : 'Unable to load signals. Check your connection.'}</span><Button variant="outline" size="sm" onClick={() => query.refetch()}>Retry</Button></div>}
      {query.isPending && !preview ? (
        <div aria-busy="true">
          <div className="hero skeleton-hero"><div className="skeleton h-7 w-56" /><div className="skeleton mt-5 h-14 w-44" /><div className="skeleton mt-6 h-9 w-64" /><div className="skeleton mt-6 h-4 w-full max-w-md" /></div>
          <div className="opportunity-grid mt-14">
            {Array.from({ length: 6 }, (_, i) => <div key={i} className="opportunity-card"><div className="skeleton h-6 w-20" /><div className="skeleton h-8 w-28" /><div className="skeleton h-10 w-full" /></div>)}
          </div>
        </div>
      ) : topPick ? (
        <>
          <Hero asset={topPick} />
          {otherSignals.length > 0 && (
            <section className="opportunities" aria-label="More opportunities">
              <div className="opportunities-head"><h2 className="opportunities-title">More Opportunities</h2><span className="opportunities-count font-mono">{otherSignals.length} SIGNALS</span></div>
              <div className="opportunity-grid">
                {otherSignals.map(asset => <OpportunityCard key={asset.ticker} asset={asset} />)}
              </div>
            </section>
          )}
        </>
      ) : !query.isError ? (
        <div className="empty-state"><CandlestickChart size={32} className="mx-auto mb-4 text-muted-foreground" /><h3>No signals yet</h3><p className="mt-2 text-sm text-muted-foreground">Your watchlist is empty. Check back soon, or preview sample data.</p><Button variant="outline" className="mt-5" onClick={() => setSource('sample')}>View sample data</Button></div>
      ) : null}
    </main>
    <footer className="terminal-footer page-width"><div className="flex items-center gap-2"><Zap size={13} /><span>Algorithmic signals. Live charts. Zero noise.</span></div><span>AI analysis is informational. Not financial advice.</span><span className="font-mono text-[10px]">ZEROCHART<ArrowDown size={10} className="ml-1 inline" /></span></footer>
  </div>;
}
