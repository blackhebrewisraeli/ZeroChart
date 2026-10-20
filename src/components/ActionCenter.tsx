import { useEffect, useState } from 'react';
import { Flame } from 'lucide-react';
import { toast } from 'sonner';
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { supabase } from '@/lib/supabaseClient';
import { formatPrice, type Asset } from '@/lib/assets';
import { applyBuyTransaction, applySellTransaction } from '@/lib/portfolioAccounting';
import { usePortfolio } from '@/lib/portfolioStore';
import { formatShares } from '@/lib/risk';
import { toBinanceSymbol } from '@/lib/ticker';
import { FEE_RATE } from '@/components/TradeTicket';
import { cn } from '@/lib/utils';

type Signal = Database['public']['Tables']['trading_signals']['Row'];

/** Appends fetched rows the realtime feed hasn't already delivered. */
function appendNew(list: Signal[], rows: Signal[]): Signal[] {
  const seen = new Set(list.map((s) => s.id));
  return [...list, ...rows.filter((row) => !seen.has(row.id))];
}

/**
 * Action Center: TradingView signals (via the tv-webhook function) as one
 * giant card with Execute / Dismiss. Execute books a tactical fill in the
 * `paper_trading` ledger at the live price. No charts, no math for the user.
 */
export function ActionCenter({ assets }: Readonly<{ assets: Asset[] }>) {
  const { scopeUserId: userId, getPortfolio, executeBuy, executeSell } = usePortfolio();
  const [pending, setPending] = useState<Signal[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!userId) return;
    let live = true;
    // Signals that fired while the app was closed; realtime covers everything after.
    void supabase
      .from('trading_signals')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'PENDING')
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        if (!live || !data) return;
        setPending((list) => appendNew(list, data));
      });
    const channel = supabase
      .channel(`trading-signals:${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'trading_signals', filter: `user_id=eq.${userId}` },
        (payload: RealtimePostgresChangesPayload<Signal>) => {
          if (payload.eventType === 'DELETE') return;
          const row = payload.new;
          setPending((list) => {
            const rest = list.filter((s) => s.id !== row.id);
            return row.status === 'PENDING' ? [row, ...rest] : rest;
          });
        },
      )
      .subscribe();
    return () => {
      live = false;
      setPending([]);
      void supabase.removeChannel(channel);
    };
  }, [userId]);

  /** Moves a signal out of PENDING; false when another tab already resolved it. */
  async function resolve(id: string, status: 'EXECUTED' | 'DISMISSED'): Promise<boolean> {
    setBusy(true);
    const { data, error } = await supabase
      .from('trading_signals')
      .update({ status })
      .eq('id', id)
      .eq('status', 'PENDING')
      .select('id');
    setBusy(false);
    if (error) {
      toast.error('Could not update the signal', { description: error.message });
      return false;
    }
    setPending((list) => list.filter((s) => s.id !== id));
    return data.length > 0;
  }

  async function execute(signal: Signal) {
    const ticker = signal.ticker.toUpperCase();
    const asset = assets.find(
      (a) => a.ticker.toUpperCase() === ticker || toBinanceSymbol(a.ticker) === ticker,
    );
    const price = asset?.current_price;
    if (!asset || !price || price <= 0) {
      toast.error(`No live ${signal.ticker} price to fill at yet`);
      return;
    }
    const paper = getPortfolio('paper_trading');
    const held =
      paper.positions.find((p) => p.ticker.toUpperCase() === asset.ticker.toUpperCase())?.shares ??
      0;
    const buying = signal.action === 'BUY';
    if (!buying && held <= 0) {
      toast.error(`No open ${asset.ticker} paper position to sell`);
      return;
    }
    const sized = Number(signal.suggested_size) / price;
    const shares = buying ? sized : Math.min(sized, held);
    const order = {
      ticker: asset.ticker,
      shares,
      price,
      fee: shares * price * FEE_RATE,
      timestamp: new Date().toISOString(),
      intent: 'tactical' as const,
    };
    // Dry-run the pure engine first so a rejected order never consumes the signal.
    const check = buying ? applyBuyTransaction(paper, order) : applySellTransaction(paper, order);
    if (!check.ok) {
      toast.error(check.error);
      return;
    }
    if (!(await resolve(signal.id, 'EXECUTED'))) return;
    // ponytail: no rollback if the fill fails after the claim — only a same-tab
    // race inside the round trip can cause it; revert to PENDING if it ever shows up.
    const result = buying
      ? executeBuy('paper_trading', order)
      : executeSell('paper_trading', order);
    if (!result.ok) {
      toast.error(result.error ?? 'Order rejected');
      return;
    }
    toast.success(
      `${buying ? 'Bought' : 'Sold'} ${formatPrice(shares * price)} of ${asset.ticker}`,
      {
        description: `${formatShares(shares)} at ${formatPrice(price)} — simulated fill in your Paper Trading ledger.`,
      },
    );
  }

  const signal = pending[0];
  if (!signal) return null;
  const buying = signal.action === 'BUY';

  return (
    <section
      className={cn('action-center', buying ? 'is-buy' : 'is-sell')}
      aria-label="Action center"
    >
      <p className="action-center-headline" role="alert">
        <Flame size={28} aria-hidden="true" />
        {signal.action} SIGNAL: {signal.ticker}
      </p>
      <dl className="action-center-facts">
        <div>
          <dt>Confidence</dt>
          <dd>{signal.conviction_score}%</dd>
        </div>
        <div>
          <dt>Recommended Size</dt>
          <dd>{formatPrice(Number(signal.suggested_size))}</dd>
        </div>
        {signal.stop_loss !== null && (
          <div>
            <dt>Stop Loss</dt>
            <dd>{formatPrice(Number(signal.stop_loss))}</dd>
          </div>
        )}
      </dl>
      <div className="action-center-actions">
        <button
          type="button"
          className="action-center-execute"
          disabled={busy}
          onClick={() => void execute(signal)}
        >
          Execute Trade (Paper)
        </button>
        <button
          type="button"
          className="action-center-dismiss"
          disabled={busy}
          onClick={() => void resolve(signal.id, 'DISMISSED')}
        >
          Dismiss
        </button>
      </div>
      {pending.length > 1 && (
        <p className="action-center-queue">+{pending.length - 1} more waiting</p>
      )}
    </section>
  );
}
