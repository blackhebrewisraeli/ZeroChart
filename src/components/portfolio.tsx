import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Briefcase, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { fetchAssets, formatPrice } from '@/lib/assets';
import {
  calcPnl,
  closeTrade,
  fetchOpenTrades,
  formatDate,
  formatPnlDollar,
  formatPnlPercent,
  openTradesQueryKey,
  type VirtualTrade,
} from '@/lib/trades';
import { cn } from '@/lib/utils';

function TradeRow({ trade, currentPrice }: { trade: VirtualTrade; currentPrice: number | null }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => closeTrade(trade.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: openTradesQueryKey });
      toast.success('Position closed', { description: `${trade.ticker} paper trade closed` });
    },
    onError: (error) => {
      toast.error('Close failed', {
        description: error instanceof Error ? error.message : 'Unable to close position',
      });
    },
  });

  const pnl = calcPnl(trade.entry_price, currentPrice);
  const tone = pnl.dollar === null ? '' : pnl.dollar > 0 ? 'pnl-positive' : pnl.dollar < 0 ? 'pnl-negative' : '';

  return (
    <div className="trade-row">
      <div className="trade-ticker">
        <span className="asset-monogram">{trade.ticker.slice(0, 1)}</span>
        <div>
          <h3 className="font-mono text-base font-semibold">{trade.ticker}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">Open position</p>
        </div>
      </div>
      <div className="trade-cell">
        <span className="trade-label">ENTRY PRICE</span>
        <span className="font-mono text-[26px] font-medium">{formatPrice(trade.entry_price)}</span>
      </div>
      <div className="trade-cell">
        <span className="trade-label">P&L</span>
        <span className={cn('font-mono text-[26px] font-medium', tone)}>{formatPnlDollar(pnl.dollar)}</span>
        <span className={cn('font-mono text-xs', tone)}>{formatPnlPercent(pnl.percent)}</span>
      </div>
      <div className="trade-cell">
        <span className="trade-label">ENTRY DATE</span>
        <span className="font-mono text-sm text-foreground">{formatDate(trade.entry_date)}</span>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="close-position"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        {mutation.isPending ? 'Closing…' : 'Close Position'}
      </Button>
    </div>
  );
}

export function Portfolio() {
  const query = useQuery({ queryKey: openTradesQueryKey, queryFn: fetchOpenTrades });
  const assetsQuery = useQuery({ queryKey: ['assets-status'], queryFn: fetchAssets, refetchInterval: 60000 });

  const priceByTicker = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const asset of assetsQuery.data ?? []) {
      map.set(asset.ticker, asset.current_price);
    }
    return map;
  }, [assetsQuery.data]);

  return (
    <section aria-label="Paper trading portfolio">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <div className="mb-3 flex items-center gap-2 font-mono text-[10px] tracking-[0.15em] text-primary">
            <span className="h-1.5 w-1.5 bg-primary" /> PAPER TRADING
          </div>
          <h1 className="text-[34px] font-semibold leading-tight">
            Portfolio<span className="text-primary">.</span>
          </h1>
          <p className="mt-2.5 text-sm text-muted-foreground">
            Simulated positions. No real money, no real risk.
          </p>
        </div>
        <Button
          variant="outline"
          size="icon"
          aria-label="Refresh positions"
          title="Refresh positions"
          disabled={query.isFetching}
          onClick={() => query.refetch()}
        >
          <RefreshCw size={14} className={query.isFetching ? 'animate-spin' : undefined} />
        </Button>
      </div>

      <div className="portfolio-summary">
        <span className="summary-label">OPEN POSITIONS</span>
        <div className="mt-3 flex items-baseline gap-2">
          <span className="font-mono text-[30px]">
            {query.isPending ? '—' : String(query.data?.length ?? 0).padStart(2, '0')}
          </span>
          <span className="text-xs text-muted-foreground">open trades</span>
        </div>
      </div>

      {query.isError && (
        <div role="alert" className="error-banner">
          <span>Unable to load your positions. Check your connection and permissions.</span>
          <Button variant="outline" size="sm" onClick={() => query.refetch()}>
            Retry
          </Button>
        </div>
      )}

      <div className="trade-list mt-6" aria-busy={query.isPending}>
        {query.isPending ? (
          Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="trade-row trade-skeleton" aria-hidden="true">
              <div className="skeleton h-9 w-32" />
              <div className="skeleton h-6 w-40" />
              <div className="skeleton h-6 w-32" />
              <div className="skeleton h-6 w-28" />
              <span className="sr-only">Loading positions</span>
            </div>
          ))
        ) : query.data && query.data.length > 0 ? (
          query.data.map((trade) => (
            <TradeRow key={trade.id} trade={trade} currentPrice={priceByTicker.get(trade.ticker) ?? null} />
          ))
        ) : (
          <div className="empty-state">
            <Briefcase size={25} className="mx-auto mb-4 text-muted-foreground" />
            <h3>No open positions</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Use the Simulate Buy button on the Radar view to open a paper trade.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
