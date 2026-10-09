import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ArrowDown, ArrowUpRight, Briefcase, Check, ChevronDown, Diamond, LayoutGrid, List, Plus, Radio, RefreshCw, Search, ShieldCheck, Turtle, X, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Portfolio } from '@/components/portfolio';
import { fetchAssets, formatPrice, formatReward, formatRisk, formatRsi, formatVolume, sampleAssets, type Asset } from '@/lib/assets';
import { openTrade, openTradesQueryKey } from '@/lib/trades';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/')({
  head: () => ({ meta: [
    { title: 'ZeroChart — Signal over noise' },
    { name: 'description', content: 'A chartless trading terminal for long-term conviction and asymmetric opportunities. Track clear asset signals with ZeroChart.' },
    { property: 'og:title', content: 'ZeroChart — Signal over noise' },
    { property: 'og:description', content: 'Stable and radar asset signals in one focused, chartless trading dashboard.' },
    { property: 'og:type', content: 'website' },
    { name: 'twitter:card', content: 'summary_large_image' },
  ] }),
  component: Index,
});

function SignalIndicator({ signal }: { signal: string | null }) {
  return <span className={cn('signal-label', signal === 'Green' ? 'signal-green' : signal === 'Yellow' ? 'signal-yellow' : signal === 'Red' ? 'signal-red' : 'text-muted-foreground')}><span className="signal-dot" />{signal === 'Green' ? 'Green' : signal === 'Yellow' ? 'Yellow' : signal === 'Red' ? 'Red' : 'Unavailable'}</span>;
}

function rsiTone(rsi: number | null) {
  if (rsi === null || !Number.isFinite(rsi)) return { tone: '', label: '' };
  if (rsi < 30) return { tone: 'tech-oversold', label: ' · Oversold' };
  if (rsi > 70) return { tone: 'tech-overbought', label: ' · Overbought' };
  return { tone: '', label: '' };
}

function trendInfo(asset: Asset) {
  const { current_price, sma_50 } = asset;
  if (current_price === null || sma_50 === null || !Number.isFinite(current_price) || !Number.isFinite(sma_50)) {
    return { className: '', icon: '—', label: 'No trend' };
  }
  return current_price > sma_50
    ? { className: 'trend-up', icon: '📈', label: 'Above SMA 50' }
    : { className: 'trend-down', icon: '📉', label: 'Below SMA 50' };
}

function AssetCard({ asset, radar, list }: { asset: Asset; radar: boolean; list: boolean }) {
  const signal = radar ? asset.radar_signal : asset.stable_signal;
  const rsi = rsiTone(asset.rsi_14);
  const trend = trendInfo(asset);
  return <article className={cn('asset-card', list && 'asset-row')}>
    <div className="asset-heading"><div className="flex items-center gap-3"><span className={cn('asset-monogram', ['BTC', 'ETH', 'SOL', 'AVAX', 'LINK'].includes(asset.ticker) ? 'crypto-monogram' : 'equity-monogram')}>{asset.ticker === 'BTC' ? '₿' : asset.ticker === 'ETH' ? 'Ξ' : asset.ticker.slice(0, 1)}</span><div><h3 className="font-mono text-base font-semibold">{asset.ticker}</h3><p className="mt-0.5 text-xs text-muted-foreground">{asset.name || 'Asset'}</p></div></div><SignalIndicator signal={signal} /></div>
    <div className="asset-price"><span className="font-mono text-[26px] font-medium">{formatPrice(asset.current_price)}</span><span className="text-[10px] font-mono text-muted-foreground">USD</span></div>
    <div className="asset-technicals"><span className={cn('tech-badge', rsi.tone)}>RSI {formatRsi(asset.rsi_14)}{rsi.label}</span><span className={cn('tech-badge', trend.className)}>{trend.icon} {trend.label}</span></div>
    <p className="asset-explanation">{(radar ? asset.radar_explanation : asset.stable_explanation) || 'Analysis is not available for this asset.'}</p>
    <div className="asset-bottom"><span className="flex items-center gap-1.5">{radar ? <Diamond size={12} /> : <ShieldCheck size={12} />}{radar ? 'SWING' : 'LONG-TERM'}</span>{radar ? <span className="flex items-center gap-3 font-mono"><span>REWARD <b className="ml-0.5 font-medium text-foreground">{formatReward(asset.reward_pct)}</b></span><span>RISK <b className="ml-0.5 font-medium text-foreground">{formatRisk(asset.risk_pct)}</b></span><span>VOL <b className="ml-0.5 font-medium text-foreground">{formatVolume(asset.volume_spike)}</b></span></span> : <ArrowUpRight size={14} className="text-muted-foreground" />}</div>
    <SimulateBuyButton ticker={asset.ticker} price={asset.current_price} />
  </article>;
}

function SimulateBuyButton({ ticker, price }: { ticker: string; price: number | null }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => {
      if (price === null) throw new Error('No live price available for this asset.');
      return openTrade(ticker, price);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: openTradesQueryKey });
      toast.success('Position opened', { description: `${ticker} · ${formatPrice(price)} paper buy` });
    },
    onError: (error) => {
      toast.error('Trade failed', { description: error instanceof Error ? error.message : 'Unable to open position' });
    },
  });
  return (
    <Button
      variant="ghost"
      size="sm"
      className="simulate-buy"
      aria-label={`Simulate buy ${ticker}`}
      disabled={price === null || mutation.isPending}
      onClick={() => mutation.mutate()}
    >
      {mutation.isPending ? 'Opening…' : (<><Plus size={12} /> Simulate Buy</>)}
    </Button>
  );
}

const sorters: Record<string, (a: Asset, b: Asset) => number> = {
  ticker: (a, b) => a['ticker'].localeCompare(b['ticker']),
  reward: (a, b) => (b.reward_pct ?? -Infinity) - (a.reward_pct ?? -Infinity),
  risk: (a, b) => (a.risk_pct ?? Infinity) - (b.risk_pct ?? Infinity),
  volume: (a, b) => (b.volume_spike ?? -Infinity) - (a.volume_spike ?? -Infinity),
};

function Index() {
  const [mode, setMode] = useState<'stable' | 'radar'>('stable');
  const [filter, setFilter] = useState('All signals');
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [sort, setSort] = useState('ticker');
  const [strongOnly, setStrongOnly] = useState(false);
  const [source, setSource] = useState<'auto' | 'live' | 'sample'>('auto');
  const [workspace, setWorkspace] = useState<'radar' | 'portfolio'>('radar');
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
  const newest = assets.reduce<string>((value, asset) => asset.updated_at && asset.updated_at > value ? asset.updated_at : value, '');
  const updated = newest && Number.isFinite(Date.parse(newest)) ? new Date(newest).toLocaleTimeString('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' }) + ' UTC' : '—';

  return <div className="min-h-screen bg-background text-foreground">
    <header className="terminal-header"><div className="page-width flex h-full items-center justify-between gap-4"><a href="/" className="flex items-center gap-2.5" aria-label="ZeroChart home"><span className="brand-mark"><Zap size={19} fill="currentColor" /></span><span className="text-xl font-semibold">zerochart<span className="text-primary">.</span></span><span className="terminal-tag">TERMINAL</span></a><div className="flex items-center gap-5"><span className="connection-status"><span className={cn('status-dot', query.isError && !preview && 'status-error')} />{preview ? 'Sample data' : query.isPending ? 'Connecting' : query.isError ? 'Connection interrupted' : 'Connected'}</span><span className="header-divider" /><span className="font-mono text-xs text-muted-foreground">V 1.0</span></div></div></header>
    <nav className="top-nav" aria-label="Primary navigation"><div className="page-width flex items-center gap-2"><button type="button" className={cn('top-nav-tab', workspace === 'radar' && 'top-nav-active')} aria-current={workspace === 'radar' ? 'page' : undefined} onClick={() => setWorkspace('radar')}><Radio size={15} />Radar</button><button type="button" className={cn('top-nav-tab', workspace === 'portfolio' && 'top-nav-active')} aria-current={workspace === 'portfolio' ? 'page' : undefined} onClick={() => setWorkspace('portfolio')}><Briefcase size={15} />Portfolio</button></div></nav>
    {workspace === 'radar' ? (
    <main className="page-width pb-12 pt-11">
      <div className="flex flex-wrap items-end justify-between gap-5"><div><div className="mb-3 flex items-center gap-2 font-mono text-[10px] tracking-[0.15em] text-primary"><span className="h-1.5 w-1.5 bg-primary" />THE CHARTLESS TERMINAL</div><h1 className="text-[34px] font-semibold leading-tight">Signal over noise<span className="text-primary">.</span></h1><p className="mt-2.5 text-sm text-muted-foreground">Less watching. More conviction.</p></div><div className="flex items-center gap-3"><span className="font-mono text-[11px] text-muted-foreground">{preview ? 'PREVIEW SNAPSHOT' : `UPDATED ${updated}`}</span><Button variant="outline" size="icon" aria-label="Refresh signals" title="Refresh signals" disabled={query.isFetching} onClick={() => query.refetch()}><RefreshCw size={14} className={cn(query.isFetching && 'animate-spin')} /></Button></div></div>
      <div className="mode-selector" role="tablist" aria-label="Trading mode"><Button role="tab" aria-selected={!radar} variant="ghost" className={cn('mode-tab', !radar && 'mode-active')} onClick={() => setMode('stable')}><Turtle size={19} /><span>Stable mode<span className="mode-caption">Long-term conviction</span></span>{!radar && <Check size={15} className="ml-auto text-primary" />}</Button><Button role="tab" aria-selected={radar} variant="ghost" className={cn('mode-tab', radar && 'mode-active')} onClick={() => setMode('radar')}><Diamond size={18} /><span>Radar mode<span className="mode-caption">Swing / asymmetric</span></span>{radar && <Check size={15} className="ml-auto text-primary" />}</Button></div>
      <section className="signal-summary" aria-label="Signal overview"><div className="summary-total"><span className="summary-label">ASSETS ON THE RADAR</span><div className="mt-3 flex items-baseline gap-2"><span className="font-mono text-[30px]">{query.isPending && !preview ? '—' : String(assets.length).padStart(2, '0')}</span><span className="text-xs text-muted-foreground">tracked assets</span></div></div>{['Green', 'Yellow', 'Red'].map((signal, i) => <div className="summary-item" key={signal}><span className={cn('summary-label flex items-center gap-2', `signal-${signal.toLowerCase()}`)}><span className="signal-dot" />{signal === 'Green' ? 'GREEN LIGHT' : signal === 'Yellow' ? 'PROCEED WITH CAUTION' : 'STAND ASIDE'}</span><div className="mt-3 flex items-baseline gap-2"><span className="font-mono text-[30px]">{String(counts[i]).padStart(2, '0')}</span><span className="text-xs text-muted-foreground">{signal === 'Green' ? 'favorable' : signal === 'Yellow' ? 'neutral' : 'unfavorable'}</span></div></div>)}</section>
      <section className="mt-9" aria-label="Asset signals"><div className="mb-5 flex flex-wrap items-center justify-between gap-4"><div className="flex items-center gap-3"><h2 className="text-base font-medium">{radar ? 'Radar watchlist' : 'Stable watchlist'}</h2><span className="count-badge font-mono">{filtered.length}</span></div><div className="toolbar"><div className="search-control"><Search size={14} /><input aria-label="Search assets" placeholder="Search assets..." value={search} onChange={e => setSearch(e.target.value)} />{search && <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="Clear search" onClick={() => setSearch('')}><X size={12} /></Button>}</div><div className="select-control"><select aria-label="Filter signals" value={filter} onChange={e => setFilter(e.target.value)}><option>All signals</option><option>Green</option><option>Yellow</option><option>Red</option></select><ChevronDown size={12} /></div><div className="select-control"><select aria-label="Sort assets" value={sort} onChange={e => setSort(e.target.value)}><option value="ticker">Sort: Ticker (A–Z)</option><option value="reward">Sort: Highest Reward %</option><option value="risk">Sort: Lowest Risk %</option><option value="volume">Sort: Highest Volume Spike</option></select><ChevronDown size={12} /></div><Button variant={strongOnly ? 'default' : 'outline'} size="sm" aria-pressed={strongOnly} className={cn('strong-toggle', strongOnly && 'strong-active')} onClick={() => setStrongOnly(v => !v)}>🚀 Strong Signals Only</Button><div className="view-toggle"><Button variant="ghost" size="icon" aria-label="Grid view" aria-pressed={view === 'grid'} className={cn(view === 'grid' && 'view-active')} onClick={() => setView('grid')}><LayoutGrid size={14} /></Button><Button variant="ghost" size="icon" aria-label="List view" aria-pressed={view === 'list'} className={cn(view === 'list' && 'view-active')} onClick={() => setView('list')}><List size={15} /></Button></div></div></div>
      {query.isError && !preview && <div role="alert" className="error-banner"><span>{query.data ? 'Refresh failed. Showing the last available snapshot.' : 'Unable to load asset signals. Check your connection and read permissions.'}</span><Button variant="outline" size="sm" onClick={() => query.refetch()}>Retry</Button></div>}
      {preview && <div className="preview-note"><span className="flex items-center gap-2"><Radio size={13} />Sample data · Illustrative prices and signals, not live market data.</span><Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setSource('live')}>View live data <ArrowUpRight size={12} /></Button></div>}
      <div className={cn('asset-grid', view === 'list' && 'asset-list')} aria-busy={query.isPending && !preview}>
        {query.isPending && !preview ? Array.from({ length: 6 }, (_, i) => <div key={i} className="asset-card skeleton-card"><div className="skeleton h-9 w-2/3" /><div className="skeleton mt-7 h-7 w-1/2" /><div className="skeleton mt-6 h-3 w-full" /><div className="skeleton mt-2 h-3 w-4/5" /><span className="sr-only">Loading asset signals</span></div>) : sorted.map(asset => <AssetCard key={asset.ticker} asset={asset} radar={radar} list={view === 'list'} />)}
      </div>
      {!query.isPending && !query.isError && filtered.length === 0 && <div className="empty-state"><Search size={25} className="mx-auto mb-4 text-muted-foreground" /><h3>{assets.length ? 'No matching assets' : 'Your watchlist is empty'}</h3><p className="mt-2 text-sm text-muted-foreground">{assets.length ? 'No assets match the current filters.' : 'No asset signals have been added yet.'}</p><Button variant="outline" className="mt-5" onClick={() => { if (assets.length) { setSearch(''); setFilter('All signals'); setStrongOnly(false); } else setSource('sample'); }}>{assets.length ? 'Clear filters' : 'View sample data'}</Button></div>}
      <div className="watchlist-footer"><span className="font-mono">{filtered.length > 0 ? `SHOWING ${filtered.length} OF ${assets.length} ASSETS` : 'NO ASSETS TO DISPLAY'}</span><span className="flex items-center gap-1.5"><ShieldCheck size={12} />{radar ? 'Asymmetric opportunities. Defined risk.' : 'Built for patience. Not predictions.'}</span></div></section>
      <footer className="terminal-footer"><div className="flex items-center gap-2"><Zap size={13} /><span>Zero charts. Clear signals.</span></div><span>AI analysis is informational. Not financial advice.</span><span className="font-mono text-[10px]">ZEROCHART / {radar ? 'RADAR' : 'STABLE'}<ArrowDown size={10} className="ml-1 inline" /></span></footer>
    </main>
    ) : (
    <main className="page-width pb-12 pt-11">
      <Portfolio />
    </main>
    )}
  </div>;
}
