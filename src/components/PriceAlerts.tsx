import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Bell, Trash2 } from 'lucide-react';
import type { User } from '@supabase/supabase-js';
import { toast } from 'sonner';
import { formatPrice, type Asset } from '@/lib/assets';
import { toBinanceSymbol, toDisplayTicker } from '@/lib/binance';
import { useAlertController } from '@/hooks/useAlertEngine';
import type { AlertCondition } from '@/lib/alertsStore';
import { cn } from '@/lib/utils';

/**
 * Price-alert panel backed by the SINGLE unified alert pipeline
 * (`useAlertEngine` + `alertsStore`, M1-T4 F-5.1). Guests create session-scoped
 * alerts (in-memory, cleared on refresh); signed-in users create cloud alerts
 * synced to `user_alerts`. Notifications come exclusively from the engine's
 * toast channel — this panel only renders the list and creation form.
 */
export function PriceAlerts({ assets, user }: { assets: Asset[]; user: User | null }) {
  const { alerts, sync, createAlert, deleteAlert } = useAlertController(user);

  const tradableAssets = useMemo(
    () =>
      assets
        .filter((asset) => toBinanceSymbol(asset.ticker))
        .sort((a, b) => a.ticker.localeCompare(b.ticker)),
    [assets],
  );

  const [ticker, setTicker] = useState('');
  const [condition, setCondition] = useState<AlertCondition>('above');
  const [target, setTarget] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (ticker === '' && tradableAssets.length > 0) {
      setTicker(tradableAssets[0]?.ticker ?? '');
    }
  }, [tradableAssets, ticker]);

  const numericTarget = Number(target);
  const canSubmit =
    ticker !== '' && Number.isFinite(numericTarget) && numericTarget > 0 && !submitting;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await createAlert({ ticker, targetPrice: numericTarget, condition });
      setTarget('');
      toast.success(`Alert set for ${ticker}`, {
        description: user ? 'Synced to your account.' : 'Session-only — sign in to keep it.',
      });
    } catch {
      toast.error("Couldn't save alert. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteAlert(id);
    } catch {
      toast.error("Couldn't delete alert. Please try again.");
    }
  }

  return (
    <div className="price-alerts-card">
      <div className="price-alerts-head">
        <div>
          <span className="price-alerts-eyebrow">Price Alerts</span>
          <p className="price-alerts-sub">
            Get notified the moment a Binance price crosses your target.
          </p>
        </div>
        <Bell size={18} className="price-alerts-icon" />
      </div>

      {tradableAssets.length === 0 ? (
        <div className="price-alerts-empty">No crypto assets available to track right now.</div>
      ) : (
        <form className="price-alerts-form" onSubmit={handleSubmit}>
          <label className="price-alerts-field">
            <span className="price-alerts-label">Ticker</span>
            <select
              className="price-alerts-select"
              value={ticker}
              onChange={(e) => setTicker(e.target.value)}
            >
              {tradableAssets.map((asset) => (
                <option key={asset.ticker} value={asset.ticker}>
                  {toDisplayTicker(asset.ticker)}
                </option>
              ))}
            </select>
          </label>

          <div className="price-alerts-field">
            <span className="price-alerts-label">Condition</span>
            <div className="price-alerts-condition" role="group" aria-label="Alert condition">
              <button
                type="button"
                className={cn('price-alerts-condition-btn', condition === 'above' && 'is-active')}
                aria-pressed={condition === 'above'}
                onClick={() => setCondition('above')}
              >
                Rise above
              </button>
              <button
                type="button"
                className={cn('price-alerts-condition-btn', condition === 'below' && 'is-active')}
                aria-pressed={condition === 'below'}
                onClick={() => setCondition('below')}
              >
                Fall below
              </button>
            </div>
          </div>

          <label className="price-alerts-field">
            <span className="price-alerts-label">Target price (USD)</span>
            <input
              className="price-alerts-input"
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={target}
              placeholder="0.00"
              onChange={(e) => setTarget(e.target.value)}
            />
          </label>

          <button type="submit" className="price-alerts-submit" disabled={!canSubmit}>
            Set Alert
          </button>
        </form>
      )}

      {!user && (
        <p className="price-alerts-sub">
          Signed out — alerts are session-only and clear when you refresh.
        </p>
      )}

      <div className="price-alerts-list">
        {sync.status === 'loading' ? (
          <div className="price-alerts-empty">Loading alerts…</div>
        ) : alerts.length === 0 ? (
          <div className="price-alerts-empty">No active alerts yet.</div>
        ) : (
          alerts.map((alert) => (
            <div key={alert.id} className="price-alert-item">
              <span className="price-alert-ticker">{toDisplayTicker(alert.ticker)}</span>
              <span className="price-alert-cond">
                {alert.condition === 'above' ? '↑ above' : '↓ below'}
              </span>
              <span className="price-alert-target">{formatPrice(alert.targetPrice)}</span>
              <span
                className={cn('price-alert-scope', alert.scope === 'session' && 'is-session')}
                title={
                  alert.scope === 'cloud'
                    ? 'Synced to your account'
                    : 'Session-only — cleared on refresh'
                }
              >
                {alert.scope === 'cloud' ? 'cloud' : 'session'}
              </span>
              <button
                type="button"
                className="price-alert-delete"
                onClick={() => handleDelete(alert.id)}
                aria-label={`Delete ${alert.ticker} alert`}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
