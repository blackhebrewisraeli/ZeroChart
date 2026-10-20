import { useEffect, useRef, useState } from 'react';
import { Flame } from 'lucide-react';
import { toast } from 'sonner';
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { supabase } from '@/lib/supabaseClient';
import { formatPrice, type Asset } from '@/lib/assets';
import { usePortfolio } from '@/lib/portfolioStore';
import { formatShares } from '@/lib/risk';
import { toBinanceSymbol } from '@/lib/ticker';
import { FEE_RATE } from '@/components/TradeTicket';
import { cn } from '@/lib/utils';

type Signal = Database['public']['Tables']['trading_signals']['Row'];

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The scanner asset a signal's ticker refers to ("BTCUSDT" or "BTC-USD"). */
function findAsset(assets: Asset[], ticker: string): Asset | undefined {
  const wanted = ticker.toUpperCase();
  return assets.find(
    (a) => a.ticker.toUpperCase() === wanted || toBinanceSymbol(a.ticker) === wanted,
  );
}

/** Appends fetched rows that aren't already listed or known to be resolved. */
function appendNew(list: Signal[], rows: Signal[], resolved: ReadonlySet<string>): Signal[] {
  const seen = new Set([...resolved, ...list.map((s) => s.id)]);
  return [...list, ...rows.filter((row) => !seen.has(row.id))];
}

/**
 * Action Center: TradingView signals (via the tv-webhook function) as one
 * giant card with Execute / Dismiss. Execute books a tactical fill of the
 * signal's quantity (units) in the `paper_trading` ledger at the live price.
 */
export function ActionCenter({ assets }: Readonly<{ assets: Asset[] }>) {
  const { scopeUserId: userId, getPortfolio, executePaperTrade } = usePortfolio();
  const [pending, setPending] = useState<Signal[]>([]);
  const [busy, setBusy] = useState(false);
  // Resolution is one-way (RLS only updates PENDING rows), so a backlog snapshot
  // still in flight must never bring back a signal resolved after it was read.
  const resolved = useRef(new Set<string>());

  useEffect(() => {
    if (!userId) return;
    let live = true;
    const channel = supabase
      // wait: SUBSCRIBED only once the postgres_changes listener is live, not just the join.
      .channel(`trading-signals:${userId}`, {
        config: { postgres_changes_options: { wait: true } },
      })
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'trading_signals', filter: `user_id=eq.${userId}` },
        (payload: RealtimePostgresChangesPayload<Signal>) => {
          if (payload.eventType === 'DELETE') return;
          const row = payload.new;
          if (row.status !== 'PENDING') resolved.current.add(row.id);
          setPending((list) => {
            const rest = list.filter((s) => s.id !== row.id);
            // A PENDING event can arrive after this tab already resolved the row.
            return row.status === 'PENDING' && !resolved.current.has(row.id)
              ? [row, ...rest]
              : rest;
          });
        },
      )
      .subscribe((status) => {
        if (status === 'CLOSED') return;
        // Backlog once the listener is live, so a signal inserted during the join
        // can't fall between the snapshot and the stream (appendNew dedupes).
        // Re-runs on reconnect, which picks up anything missed while offline, and
        // on CHANNEL_ERROR / TIMED_OUT so the backlog still shows without realtime.
        void supabase
          .from('trading_signals')
          .select('*')
          .eq('user_id', userId)
          .eq('status', 'PENDING')
          .order('created_at', { ascending: false })
          .then(({ data }) => {
            if (!live || !data) return;
            setPending((list) => appendNew(list, data, resolved.current));
          });
      });
    return () => {
      live = false;
      setPending([]);
      void supabase.removeChannel(channel);
    };
  }, [userId]);

  function forget(id: string) {
    resolved.current.add(id);
    setPending((list) => list.filter((s) => s.id !== id));
  }

  /** Moves a signal out of PENDING; false when another tab already resolved it. Throws on a DB error. */
  async function resolve(id: string, status: 'EXECUTED' | 'DISMISSED'): Promise<boolean> {
    const { data, error } = await supabase
      .from('trading_signals')
      .update({ status })
      .eq('id', id)
      .eq('status', 'PENDING')
      .select('id');
    if (error) throw new Error(error.message);
    forget(id);
    return data.length > 0;
  }

  async function dismiss(id: string) {
    setBusy(true);
    try {
      await resolve(id, 'DISMISSED');
    } catch (error) {
      toast.error('Could not update the signal', { description: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function execute(signal: Signal) {
    const asset = findAsset(assets, signal.ticker);
    const price = asset?.current_price;
    if (!asset || !price || price <= 0) {
      toast.error(`No live ${signal.ticker} price to fill at yet`);
      return;
    }
    const held =
      getPortfolio('paper_trading').positions.find(
        (p) => p.ticker.toUpperCase() === asset.ticker.toUpperCase(),
      )?.shares ?? 0;
    const buying = signal.action === 'BUY';
    if (!buying && held <= 0) {
      toast.error(`No open ${asset.ticker} paper position to sell`);
      return;
    }
    const quantity = Number(signal.quantity);
    const shares = buying ? quantity : Math.min(quantity, held);
    const order = {
      side: buying ? ('buy' as const) : ('sell' as const),
      ticker: asset.ticker,
      shares,
      price,
      fee: shares * price * FEE_RATE,
    };

    // Book first, claim second: the signal turns EXECUTED only after the ledger
    // accepted the fill, so a rejected order never leaves a zombie EXECUTED row.
    setBusy(true);
    let booked = false;
    try {
      const result = await executePaperTrade(order);
      if (!result.ok) throw new Error(result.error ?? 'Order rejected');
      booked = true;
      toast.success(
        `${buying ? 'Bought' : 'Sold'} ${formatPrice(shares * price)} of ${asset.ticker}`,
        {
          description: `${formatShares(shares)} units at ${formatPrice(price)} — simulated fill in your Paper Trading ledger.`,
        },
      );
      if (!(await resolve(signal.id, 'EXECUTED'))) {
        toast.warning('Another tab already resolved this signal', {
          description: 'Check your Paper Trading ledger for a duplicate fill.',
        });
      }
    } catch (error) {
      if (booked) {
        // The fill stands; hide the card so this tab can't book it twice.
        forget(signal.id);
        toast.error('Trade booked, but the signal could not be marked executed', {
          description: `${errorMessage(error)}. Dismiss it if it shows up again.`,
        });
      } else {
        toast.error(errorMessage(error));
      }
    } finally {
      setBusy(false);
    }
  }

  const signal = pending[0];
  if (!signal) return null;
  const buying = signal.action === 'BUY';
  const quantity = Number(signal.quantity);
  // What the fill would cost at the live price (the alert's price until one streams in).
  const fillPrice = findAsset(assets, signal.ticker)?.current_price ?? signal.price;
  const notional = fillPrice ? quantity * Number(fillPrice) : null;

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
          <dt>Signal Score</dt>
          <dd>{signal.signal_score} / 100</dd>
        </div>
        <div>
          <dt>Quantity</dt>
          <dd>{formatShares(quantity)} units</dd>
        </div>
        {notional !== null && (
          <div>
            <dt>Notional</dt>
            <dd>{formatPrice(notional)}</dd>
          </div>
        )}
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
          onClick={() => void dismiss(signal.id)}
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
