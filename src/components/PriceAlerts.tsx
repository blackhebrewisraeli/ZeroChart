import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bell, Trash2 } from 'lucide-react';
import type { User } from '@supabase/supabase-js';
import { toast } from 'sonner';
import { formatPrice, type Asset } from '@/lib/assets';
import { isBinanceCrypto, toDisplayTicker } from '@/lib/binance';
import { usePriceAlerts } from '@/hooks/usePriceAlerts';
import type { AlertCondition } from '@/lib/priceAlerts';
import { cn } from '@/lib/utils';

export function PriceAlerts({ assets, user }: { assets: Asset[]; user: User | null }) {
  const { alerts, loading, notifications, createAlert, deleteAlert, dismissNotification } =
    usePriceAlerts(assets, user);

  const cryptoAssets = useMemo(
    () =>
      assets
        .filter((asset) => isBinanceCrypto(asset.ticker))
        .sort((a, b) => a.ticker.localeCompare(b.ticker)),
    [assets],
  );

  const [ticker, setTicker] = useState('');
  const [condition, setCondition] = useState<AlertCondition>('above');
  const [target, setTarget] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (ticker === '' && cryptoAssets.length > 0) {
      setTicker(cryptoAssets[0]?.ticker ?? '');
    }
  }, [cryptoAssets, ticker]);

  const numericTarget = Number(target);
  const canSubmit =
    !!user && ticker !== '' && Number.isFinite(numericTarget) && numericTarget > 0 && !submitting;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await createAlert({ ticker, targetPrice: numericTarget, condition });
      setTarget('');
      toast.success(`Alert set for ${ticker}`);
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

      {!user ? (
        <div className="price-alerts-empty">Sign in to create cloud-synced price alerts.</div>
      ) : cryptoAssets.length === 0 ? (
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
              {cryptoAssets.map((asset) => (
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

      {user && (
        <div className="price-alerts-list">
          {loading ? (
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
                <span className="price-alert-target">{formatPrice(alert.target_price)}</span>
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
      )}

      <div className="price-alerts-toasts" role="region" aria-label="Price alert notifications">
        <AnimatePresence initial={false}>
          {notifications.map((notification) => (
            <motion.div
              key={notification.id}
              className="price-alert-toast"
              layout
              initial={{ opacity: 0, x: 24, scale: 0.96 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 24, scale: 0.96 }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            >
              <div className="price-alert-toast-body">
                <span className="price-alert-toast-title">
                  {toDisplayTicker(notification.ticker)} target hit
                </span>
                <span className="price-alert-toast-desc">
                  {toDisplayTicker(notification.ticker)}{' '}
                  {notification.condition === 'above' ? 'rose above' : 'fell below'}{' '}
                  {formatPrice(notification.targetPrice)} (now {formatPrice(notification.price)})
                </span>
              </div>
              <button
                type="button"
                className="price-alert-toast-close"
                onClick={() => dismissNotification(notification.id)}
                aria-label="Dismiss notification"
              >
                ×
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
