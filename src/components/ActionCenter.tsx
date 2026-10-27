import { useEffect, useRef, useState } from 'react';
import { Flame } from 'lucide-react';
import { toast } from 'sonner';
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { supabase } from '@/lib/supabaseClient';
import { formatPrice, type Asset } from '@/lib/assets';
import { usePortfolio } from '@/lib/portfolioStore';
import { usePaperRisk } from '@/hooks/usePaperRisk';
import { checkSell, formatShares } from '@/lib/risk';
import { Shares } from '@/components/Shares';
import { toBinanceSymbol } from '@/lib/ticker';
import { FEE_RATE } from '@/components/TradeTicket';
import { cn } from '@/lib/utils';
import { loadPaperTransactions } from '@/lib/db';
import { isDevAuthUser } from '@/lib/authStore';

type Signal = Database['public']['Tables']['trading_signals']['Row'];
const isStrategy = (signal: Signal) => signal.signal_kind === 'strategy';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The same rule as execute_tactical_signal (20261027120000): 1.0.0 on any
 * timeframe, 1.0.0-pw200 (the window-200 Pine script) on daily alerts only.
 */
function provenanceBlock(signal: Signal, complete: boolean): string | null {
  if (complete && signal.model_version === '1.0.0') return null;
  if (complete && signal.model_version === '1.0.0-pw200') {
    return signal.timeframe === '1D' || signal.timeframe === 'D'
      ? null
      : 'Model 1.0.0-pw200 can only be executed from a daily (1D) alert.';
  }
  return 'Verified strategy provenance is required before execution.';
}

/** The scanner asset a signal's ticker refers to ("BTCUSDT", "BTCUSD" or "BTC-USD"). */
function findAsset(assets: Asset[], ticker: string): Asset | undefined {
  const wanted = ticker.toUpperCase();
  return assets.find((a) => {
    const usdt = toBinanceSymbol(a.ticker);
    // TradingView's USD charts (BINANCE:BTCUSD, COINBASE:BTCUSD) send the bare "BTCUSD".
    return a.ticker.toUpperCase() === wanted || usdt === wanted || usdt?.slice(0, -1) === wanted;
  });
}

type Fill = { price: number; quantity: number };
type FillRow = { price: number | null; quantity: number | null };

const asFill = (row: FillRow | null | undefined): Fill | null =>
  row?.price != null && row.quantity != null ? { price: row.price, quantity: row.quantity } : null;

/** The signal's booked fill, if any: execute_tactical_signal links exactly one row to it. */
async function bookedFill(signalId: string): Promise<Fill | null> {
  const { data } = await supabase
    .from('paper_transactions')
    .select('price, quantity')
    .eq('signal_id', signalId);
  return asFill(data?.[0]);
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
 * A BUY the portfolio risk manager rejects, or a SELL of more than the
 * paper holding, stays on screen with Execute disabled and the reason spelled
 * out. The server checks both again when it books.
 */
export function ActionCenter({ assets }: Readonly<{ assets: Asset[] }>) {
  const { scopeUserId: userId, portfolios, replacePaperLedger } = usePortfolio();
  const [pending, setPending] = useState<Signal[]>([]);
  const [busy, setBusy] = useState(false);
  // Resolution is one-way (RLS only updates PENDING rows), so a backlog snapshot
  // still in flight must never bring back a signal resolved after it was read.
  const resolved = useRef(new Set<string>());
  const risk = usePaperRisk(pending[0] && findAsset(assets, pending[0].ticker)?.ticker);

  useEffect(() => {
    // The dev stub has no session to read `trading_signals` with.
    if (!userId || isDevAuthUser(userId)) return;
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
            return row.status === 'PENDING' && isStrategy(row) && !resolved.current.has(row.id)
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
            setPending((list) => appendNew(list, data.filter(isStrategy), resolved.current));
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
    const buying = signal.action === 'BUY';
    setBusy(true);
    try {
      if (!userId) throw new Error('Sign in to execute a tactical signal');
      const { data, error } = await supabase.rpc('execute_tactical_signal', {
        signal_id: signal.id,
        user_id: userId,
        execution_price: price,
      });
      // A dropped connection can hide a committed fill, and a retry of it is
      // refused as no longer waiting: the fill row says whether it booked.
      const fill = error ? await bookedFill(signal.id) : asFill(data);
      if (fill === null) throw new Error(error?.message);
      forget(signal.id);
      try {
        replacePaperLedger(await loadPaperTransactions(userId));
      } catch {
        toast.warning('Trade executed; Paper Trading is still syncing');
      }
      // What the server booked, which the card only proposed.
      toast.success(
        `${buying ? 'Bought' : 'Sold'} ${formatPrice(fill.quantity * fill.price)} of ${asset.ticker}`,
        {
          description: `Booked ${formatShares(fill.quantity)} ${asset.ticker} at ${formatPrice(fill.price)} — simulated fill in your Paper Trading ledger.`,
        },
      );
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const signal = pending[0];
  if (!signal) return null;
  const buying = signal.action === 'BUY';
  const quantity = Number(signal.quantity);
  const asset = findAsset(assets, signal.ticker);
  const livePrice = asset?.current_price;
  // What the fill would cost at the live price (the alert's price until one streams in).
  const fillPrice = livePrice ?? signal.price;
  const notional = fillPrice ? quantity * Number(fillPrice) : null;
  // Only entries need clearing; a sell shrinks exposure.
  const entry =
    buying && asset && livePrice && livePrice > 0
      ? risk.checkBuy(asset.ticker, {
          shares: quantity,
          price: livePrice,
          fee: quantity * livePrice * FEE_RATE,
          stopPrice: signal.stop_loss,
        })
      : null;
  const exit =
    !buying && asset ? checkSell(portfolios.paper_trading, asset.ticker, quantity) : null;
  const rejection = [entry, exit].find((check) => check?.ok === false)?.reason ?? null;
  const provenanceComplete = Boolean(
    signal.exchange && signal.timeframe && signal.bar_time && signal.model_version,
  );
  const executionBlocked = rejection ?? provenanceBlock(signal, provenanceComplete);

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
          <dt>Model Signal Score</dt>
          <dd>{signal.signal_score} / 100</dd>
        </div>
        <div>
          <dt>Quantity</dt>
          <dd>
            <Shares value={quantity} /> units
          </dd>
        </div>
        {notional !== null && (
          <div>
            <dt>Notional</dt>
            <dd>{formatPrice(notional)}</dd>
          </div>
        )}
        {signal.stop_loss !== null && (
          <div>
            <dt>Planned stop</dt>
            <dd>{formatPrice(Number(signal.stop_loss))}</dd>
          </div>
        )}
      </dl>
      <p className="action-center-context">
        TradingView alert · simulated execution only. The model score is not a probability.
        {signal.stop_loss !== null && ' Planned stops do not create automatic stop orders.'}
      </p>
      <p
        className={cn('action-center-source', !provenanceComplete && 'is-incomplete')}
        role={provenanceComplete ? undefined : 'note'}
      >
        {provenanceComplete
          ? `Source: ${signal.exchange} · ${signal.timeframe} · model ${signal.model_version}`
          : 'Source details are incomplete. Verify this alert in TradingView before simulating it.'}
      </p>
      <div className="action-center-actions">
        {/* aria-disabled while busy: a disabled button drops keyboard focus to
            <body>, and the next queued signal reuses these buttons. */}
        <button
          type="button"
          className="action-center-execute"
          disabled={executionBlocked !== null}
          aria-disabled={busy || undefined}
          aria-describedby={executionBlocked ? 'action-center-rejection' : undefined}
          onClick={() => {
            if (!busy) void execute(signal);
          }}
        >
          Execute Trade (Paper)
        </button>
        <button
          type="button"
          className="action-center-dismiss"
          aria-disabled={busy || undefined}
          onClick={() => {
            if (!busy) void dismiss(signal.id);
          }}
        >
          Dismiss
        </button>
      </div>
      {executionBlocked && (
        <p id="action-center-rejection" className="action-center-rejection">
          {executionBlocked}
        </p>
      )}
      {pending.length > 1 && (
        <p className="action-center-queue">+{pending.length - 1} more waiting</p>
      )}
    </section>
  );
}
