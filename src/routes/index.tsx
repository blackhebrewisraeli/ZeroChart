import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ArrowDown, ArrowUpRight, CandlestickChart, Check, ChevronDown, Diamond, ExternalLink, Radio, RefreshCw, Search, Turtle, X, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { calculateSignalScore, fetchAssets, formatPrice, formatReward, formatRisk, formatRsi, formatTradingViewSymbol, formatVolume, getBrokerRoute, sampleAssets, type Asset } from '@/lib/assets';
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

function rsiTone(rsi: number | null) {
  if (rsi === null || !Number.isFinite(rsi)) return { tone: '', label: '' };
  if (rsi < 30) return { tone: 'tech-oversold', label: ' · Oversold' };
  if (rsi > 70) return { tone: 'tech-overbought', label: ' · Overbought' };
  return { tone: '', label: '' };
}

function trendInfo(asset: Asset) {
  const { current_price, sma_50 } = asset;
  if (current_price === null || sma_50 === null || !Number.isFinite(current_price) || !Number.isFinite(sma_50)) {
    return { className: '', icon: '—', label: 'No trend', short: '—' };
  }
  return current_price > sma_50
    ? { className: 'trend-up', icon: '📈', label: 'Above SMA 50', short: 'Up' }
    : { className: 'trend-down', icon: '📉', label: 'Below SMA 50', short: 'Down' };
}

function TradeButton({ ticker }: { ticker: string }) {
  const route = getBrokerRoute(ticker);
  return (
    <a
      className="trade-button"
      href={route.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${route.label} for ${ticker}`}
    >
      <ExternalLink size={12} /> {route.label}
    </a>
  );
}

function RadarListItem({ asset, selected, onSelect }: { asset: Asset; selected: boolean; onSelect: () => void }) {
  const signal = asset.radar_signal;
  const rsi = rsiTone(asset.rsi_14);
  const trend = trendInfo(asset);
  const tone = signal === 'Green' ? 'signal-green' : signal === 'Yellow' ? 'signal-yellow' : signal === 'Red' ? 'signal-red' : 'signal-muted';
  const score = calculateSignalScore(asset);
  const scoreTone = score > 85 ? 'score-high' : score >= 70 ? 'score-mid' : 'score-low';
  return (
    <button
      type="button"
      className={cn('radar-list-item', selected && 'radar-list-item-active')}
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
    >
      <div className="radar-list-item-head">
        <span className="radar-list-ticker"><span className={cn('signal-dot', tone)} />{asset.ticker}</span>
        <span className={cn('radar-list-score', scoreTone)}>{score}</span>
      </div>
      <div className="radar-list-item-meta">
        <span className="radar-list-price">{formatPrice(asset.current_price)}</span>
        <span className={cn('tech-badge', rsi.tone)}>RSI {formatRsi(asset.rsi_14)}</span>
        <span className={cn('tech-badge', trend.className)}>{trend.icon} {trend.short}</span>
      </div>
    </button>
  );
}

function RadarDetail({ asset }: { asset: Asset }) {
  const monogram = asset.ticker === 'BTC' ? '₿' : asset.ticker === 'ETH' ? 'Ξ' : asset.ticker.slice(0, 1);
  return (
    <>
      <div className="radar-detail-topbar">
        <div className="radar-detail-heading">
          <span className={cn('asset-monogram', ['BTC', 'ETH', 'SOL', 'AVAX', 'LINK'].includes(asset.ticker) ? 'crypto-monogram' : 'equity-monogram')}>{monogram}</span>
          <div>
            <h2 className="font-mono text-lg font-semibold leading-tight">{asset.ticker}</h2>
            <p className="text-xs text-muted-foreground">{asset.name || 'Asset'}</p>
          </div>
        </div>
        <div className="radar-detail-insights">
          <div className="radar-insight"><span className="radar-insight-label">Risk</span><span className="radar-insight-value">{formatRisk(asset.risk_pct)}</span></div>
          <div className="radar-insight"><span className="radar-insight-label">Reward</span><span className="radar-insight-value radar-insight-reward">{formatReward(asset.reward_pct)}</span></div>
          <div className="radar-insight"><span className="radar-insight-label">Vol Spike</span><span className="radar-insight-value">{formatVolume(asset.volume_spike)}</span></div>
        </div>
        <div className="radar-detail-action"><TradeButton ticker={asset.ticker} /></div>
      </div>
      <div className="radar-chart">
        <AdvancedRealTimeChart key={asset.ticker} symbol={formatTradingViewSymbol(asset.ticker)} theme="dark" autosize={true} />
      </div>
    </>
  );
}

function RadarEmptyState() {
  return (
    <div className="radar-empty">
      <CandlestickChart size={40} className="text-muted-foreground" />
      <h3>Select an asset to view chart</h3>
      <p>Choose an asset from the list to load its live chart and algorithmic insights.</p>
    </div>
  );
}

const sorters: Record<string, (a: Asset, b: Asset) => number> = {
  score: (a, b) => calculateSignalScore(b) - calculateSignalScore(a),
  ticker: (a, b) => a['ticker'].localeCompare(b['ticker']),
  reward: (a, b) => (b.reward_pct ?? -Infinity) - (a.reward_pct ?? -Infinity),
  risk: (a, b) => (a.risk_pct ?? Infinity) - (b.risk_pct ?? Infinity),
  volume: (a, b) => (b.volume_spike ?? -Infinity) - (a.volume_spike ?? -Infinity),
};

function Index() {
  const [mode, setMode] = useState<'stable' | 'radar'>('stable');
  const [filter, setFilter] = useState('All signals');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('score');
  const [strongOnly, setStrongOnly] = useState(false);
  const [source, setSource] = useState<'auto' | 'live' | 'sample'>('auto');
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const query = useQuery({ queryKey: ['assets-status'], queryFn: fetchAssets, refetchInterval: 60000, retry: 1 });
  const preview = source === 'sample' || (source === 'auto' && query.isSuccess && query.data.length === 0);
  const assets = preview ? sampleAssets : query.data || [];
  const radar = mode === 'radar';
  const getSignal = (asset: Asset) => radar ? asset.radar_signal : asset.stable_signal;
  const counts = ['Green', 'Yellow', 'Red'].map(signal => assets.filter(asset => getSignal(asset) === signal).length);
  const filtered = assets.filter(asset => {
    if (filter !== 'All signals' && getSignal(asset) !== filter) return false;
    if (!`${asset.ticker} ${asset.name || ''}`.toLowerCase().includes(search.toLowerCase())) return false;
    if (strongOnly) {
      if (asset.reward_pct === null || asset.risk_pct === null || asset.volume_spike === null) return false;
      if (!(asset.reward_pct > asset.risk_pct && asset.volume_spike > 1.2)) return false;
    }
    return true;
  });
  const sorted = [...filtered].sort(sorters[sort] ?? sorters['ticker']);
  const selectedAsset = selectedTicker ? sorted.find(asset => asset.ticker === selectedTicker) ?? null : null;
  const newest = assets.reduce<string>((value, asset) => asset.updated_at && asset.updated_at > value ? asset.updated_at : value, '');
  const updated = newest && Number.isFinite(Date.parse(newest)) ? new Date(newest).toLocaleTimeString('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' }) + ' UTC' : '—';

  return <div className="min-h-screen bg-background text-foreground">
    <header className="terminal-header"><div className="page-width flex h-full items-center justify-between gap-4"><a href="/" className="flex items-center gap-2.5" aria-label="ZeroChart home"><span className="brand-mark"><Zap size={19} fill="currentColor" /></span><span className="text-xl font-semibold">zerochart<span className="text-primary">.</span></span><span className="terminal-tag">TERMINAL</span></a><div className="flex items-center gap-5"><span className="connection-status"><span className={cn('status-dot', query.isError && !preview && 'status-error')} />{preview ? 'Sample data' : query.isPending ? 'Connecting' : query.isError ? 'Connection interrupted' : 'Connected'}</span><span className="header-divider" /><span className="font-mono text-xs text-muted-foreground">V 1.0</span></div></div></header>
    <main className="page-width pb-12 pt-11">
      <div className="flex flex-wrap items-end justify-between gap-5"><div><div className="mb-3 flex items-center gap-2 font-mono text-[10px] tracking-[0.15em] text-primary"><span className="h-1.5 w-1.5 bg-primary" />THE SIGNAL TERMINAL</div><h1 className="text-[34px] font-semibold leading-tight">Signal over noise<span className="text-primary">.</span></h1><p className="mt-2.5 text-sm text-muted-foreground">Less watching. More conviction.</p></div><div className="flex items-center gap-3"><span className="font-mono text-[11px] text-muted-foreground">{preview ? 'PREVIEW SNAPSHOT' : `UPDATED ${updated}`}</span><Button variant="outline" size="icon" aria-label="Refresh signals" title="Refresh signals" disabled={query.isFetching} onClick={() => query.refetch()}><RefreshCw size={14} className={cn(query.isFetching && 'animate-spin')} /></Button></div></div>
      <div className="mode-selector" role="tablist" aria-label="Trading mode"><Button role="tab" aria-selected={!radar} variant="ghost" className={cn('mode-tab', !radar && 'mode-active')} onClick={() => setMode('stable')}><Turtle size={19} /><span>Stable mode<span className="mode-caption">Long-term conviction</span></span>{!radar && <Check size={15} className="ml-auto text-primary" />}</Button><Button role="tab" aria-selected={radar} variant="ghost" className={cn('mode-tab', radar && 'mode-active')} onClick={() => setMode('radar')}><Diamond size={18} /><span>Radar mode<span className="mode-caption">Swing / asymmetric</span></span>{radar && <Check size={15} className="ml-auto text-primary" />}</Button></div>
      <section className="signal-summary" aria-label="Signal overview"><div className="summary-total"><span className="summary-label">ASSETS ON THE RADAR</span><div className="mt-3 flex items-baseline gap-2"><span className="font-mono text-[30px]">{query.isPending && !preview ? '—' : String(assets.length).padStart(2, '0')}</span><span className="text-xs text-muted-foreground">tracked assets</span></div></div>{['Green', 'Yellow', 'Red'].map((signal, i) => <div className="summary-item" key={signal}><span className={cn('summary-label flex items-center gap-2', `signal-${signal.toLowerCase()}`)}><span className="signal-dot" />{signal === 'Green' ? 'GREEN LIGHT' : signal === 'Yellow' ? 'PROCEED WITH CAUTION' : 'STAND ASIDE'}</span><div className="mt-3 flex items-baseline gap-2"><span className="font-mono text-[30px]">{String(counts[i]).padStart(2, '0')}</span><span className="text-xs text-muted-foreground">{signal === 'Green' ? 'favorable' : signal === 'Yellow' ? 'neutral' : 'unfavorable'}</span></div></div>)}</section>
      <section className="mt-9" aria-label="Asset signals">
        {query.isError && !preview && <div role="alert" className="error-banner"><span>{query.data ? 'Refresh failed. Showing the last available snapshot.' : 'Unable to load asset signals. Check your connection and read permissions.'}</span><Button variant="outline" size="sm" onClick={() => query.refetch()}>Retry</Button></div>}
        {preview && <div className="preview-note"><span className="flex items-center gap-2"><Radio size={13} />Sample data · Illustrative prices and signals, not live market data.</span><Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setSource('live')}>View live data <ArrowUpRight size={12} /></Button></div>}
        <div className="master-detail">
          <aside className="radar-sidebar" aria-label="Asset list">
            <div className="radar-sidebar-head">
              <div className="flex items-center gap-3"><h2 className="text-base font-medium">{radar ? 'Radar watchlist' : 'Stable watchlist'}</h2><span className="count-badge font-mono">{filtered.length}</span></div>
              <div className="search-control"><Search size={14} /><input aria-label="Search assets" placeholder="Search assets..." value={search} onChange={e => setSearch(e.target.value)} />{search && <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="Clear search" onClick={() => setSearch('')}><X size={12} /></Button>}</div>
              <div className="flex gap-2"><div className="select-control flex-1"><select aria-label="Filter signals" value={filter} onChange={e => setFilter(e.target.value)}><option>All signals</option><option>Green</option><option>Yellow</option><option>Red</option></select><ChevronDown size={12} /></div><div className="select-control flex-1"><select aria-label="Sort assets" value={sort} onChange={e => setSort(e.target.value)}><option value="score">Sort: Signal Score</option><option value="ticker">Sort: Ticker (A–Z)</option><option value="reward">Sort: Highest Reward %</option><option value="risk">Sort: Lowest Risk %</option><option value="volume">Sort: Highest Volume Spike</option></select><ChevronDown size={12} /></div></div>
              <Button variant={strongOnly ? 'default' : 'outline'} size="sm" aria-pressed={strongOnly} className={cn('strong-toggle', strongOnly && 'strong-active')} onClick={() => setStrongOnly(v => !v)}>🚀 Strong Signals Only</Button>
            </div>
            <div className="radar-sidebar-scroll" aria-busy={query.isPending && !preview}>
              {query.isPending && !preview ? Array.from({ length: 8 }, (_, i) => <div key={i} className="radar-list-item radar-list-skeleton"><div className="skeleton h-4 w-2/3" /><div className="skeleton h-3 w-full" /></div>) : sorted.map(asset => <RadarListItem key={asset.ticker} asset={asset} selected={selectedAsset?.ticker === asset.ticker} onSelect={() => setSelectedTicker(asset.ticker)} />)}
              {!query.isPending && !query.isError && filtered.length === 0 && <div className="radar-list-empty"><Search size={18} /><p>{assets.length ? 'No assets match the current filters.' : 'No asset signals have been added yet.'}</p><Button variant="outline" size="sm" onClick={() => { if (assets.length) { setSearch(''); setFilter('All signals'); setStrongOnly(false); } else setSource('sample'); }}>{assets.length ? 'Clear filters' : 'View sample data'}</Button></div>}
            </div>
            <div className="radar-sidebar-footer"><span className="font-mono">{filtered.length > 0 ? `SHOWING ${filtered.length} OF ${assets.length} ASSETS` : 'NO ASSETS TO DISPLAY'}</span></div>
          </aside>
          <div className={cn('radar-detail', !selectedAsset && 'radar-detail-empty')}>
            {selectedAsset ? <RadarDetail asset={selectedAsset} /> : <RadarEmptyState />}
          </div>
        </div>
      </section>
      <footer className="terminal-footer"><div className="flex items-center gap-2"><Zap size={13} /><span>Algorithmic signals. Live charts. Zero noise.</span></div><span>AI analysis is informational. Not financial advice.</span><span className="font-mono text-[10px]">ZEROCHART / {radar ? 'RADAR' : 'STABLE'}<ArrowDown size={10} className="ml-1 inline" /></span></footer>
    </main>
  </div>;
}
