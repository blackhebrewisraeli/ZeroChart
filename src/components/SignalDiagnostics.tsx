import { useEffect, useState } from 'react';
import { Activity, CheckCircle2 } from 'lucide-react';
import type { Database } from '@/integrations/supabase/types';
import { supabase } from '@/lib/supabaseClient';
import { usePortfolio } from '@/lib/portfolioStore';
import { cn } from '@/lib/utils';

type Signal = Database['public']['Tables']['trading_signals']['Row'];

function isDiagnostic(signal: Signal): boolean {
  return signal.signal_kind !== 'strategy';
}

/** Non-executable webhook deliveries, kept visible for transport debugging. */
export function SignalDiagnostics() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const { scopeUserId: userId } = usePortfolio();

  useEffect(() => {
    if (!userId) return;
    let live = true;
    const load = async () => {
      const { data, error } = await supabase
        .from('trading_signals')
        .select('*')
        .eq('user_id', userId)
        .eq('status', 'PENDING')
        .order('created_at', { ascending: false });
      if (!live || error || !data) return;
      setSignals(data.filter(isDiagnostic));
    };
    const channel = supabase
      .channel(`signal-diagnostics:${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'trading_signals', filter: `user_id=eq.${userId}` },
        () => void load(),
      )
      .subscribe(() => void load());
    return () => {
      live = false;
      void supabase.removeChannel(channel);
    };
  }, [userId]);

  if (!userId || signals.length === 0) return null;

  return (
    <section className="signal-diagnostics" aria-label="Webhook diagnostics">
      <header className="signal-diagnostics-head">
        <Activity size={18} aria-hidden="true" />
        <div>
          <h3>Webhook diagnostics</h3>
          <p>Transport checks and legacy alerts are visible here, but never executable.</p>
        </div>
      </header>
      <div className="signal-diagnostics-list">
        {signals.map((signal) => (
          <article key={signal.id} className="signal-diagnostics-row">
            <div>
              <strong>
                {signal.signal_kind === 'transport_test'
                  ? 'Transport test'
                  : 'Unverified legacy signal'}
              </strong>
              <span>
                {signal.action} {signal.ticker} · received{' '}
                {new Date(signal.created_at).toLocaleString()}
              </span>
            </div>
            <span className={cn('signal-diagnostics-status', signal.status.toLowerCase())}>
              {signal.status === 'PENDING' ? 'Not executable' : <CheckCircle2 size={15} />}
            </span>
          </article>
        ))}
      </div>
    </section>
  );
}
