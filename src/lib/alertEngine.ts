import type { Asset } from '@/lib/assets';
import { getAlertsState, recordTriggered, takeAlert, type PriceAlert } from '@/lib/alertsStore';
import { assetFreshness, isAlertableFreshness, type FreshnessState } from '@/lib/freshness';
import type { LivePrice } from '@/lib/livePriceStore';
import { hasTriggered } from '@/lib/priceAlerts';
import { toBinanceSymbol } from '@/lib/ticker';

/**
 * Pure alert-evaluation core (M1-T4, F-5.1a–d). Framework-free so the
 * exactly-once, stale-suppression, and refire-suppression guarantees are unit
 * tested directly; `useAlertEngine` is only a thin React driver around it.
 */

export interface EvaluatedPrice {
  price: number;
  freshness: FreshnessState;
}

export interface AlertFiring {
  alert: PriceAlert;
  price: number;
  freshness: FreshnessState;
}

export interface AlertPassInput {
  assets: readonly Asset[];
  livePrices: ReadonlyMap<string, LivePrice>;
  streamConnected: boolean;
  now?: number;
}

/**
 * Builds the ticker → (displayed price, freshness) map one evaluation pass
 * uses. The live Binance tick wins when present; otherwise the provider
 * snapshot — so alerts keep evaluating on Delayed data while the WebSocket
 * reconnects (F-5.1b) and never on Stale/Simulated/Unavailable data (F-5.1d).
 */
export function buildPriceIndex(input: AlertPassInput): Map<string, EvaluatedPrice> {
  const index = new Map<string, EvaluatedPrice>();
  for (const asset of input.assets) {
    const symbol = toBinanceSymbol(asset.ticker);
    const live = symbol ? input.livePrices.get(symbol) : undefined;
    const freshness = assetFreshness(asset, live, {
      streamConnected: input.streamConnected,
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
    const price = live ? live.price : asset.current_price;
    if (price === null || !Number.isFinite(price) || price <= 0) continue;
    index.set(asset.ticker, { price, freshness });
  }
  return index;
}

/**
 * Runs ONE evaluation pass over every alert in the unified store and claims
 * each crossed alert atomically (`takeAlert`). Returns only the alerts this
 * pass actually claimed — a concurrent/duplicate pass gets an empty result for
 * the same crossing, which is the exactly-once guarantee (F-5.1a).
 */
export function runAlertPass(input: AlertPassInput): AlertFiring[] {
  const { alerts, sync } = getAlertsState();
  if (sync.status === 'loading' || alerts.length === 0) return [];

  const index = buildPriceIndex(input);
  const fired: AlertFiring[] = [];
  for (const alert of alerts) {
    const entry = index.get(alert.ticker);
    if (!entry || !isAlertableFreshness(entry.freshness)) continue;
    if (!hasTriggered(alert.condition, alert.targetPrice, entry.price)) continue;
    const claimed = takeAlert(alert.id);
    if (claimed) fired.push({ alert: claimed, price: entry.price, freshness: entry.freshness });
  }
  const triggeredAt = input.now ?? Date.now();
  recordTriggered(fired.map(({ alert, price }) => ({ alert, price, triggeredAt })));
  return fired;
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Best-effort server write with bounded exponential backoff (F-5.1c). Returns
 * whether it eventually succeeded; failure is non-fatal because the store's
 * session suppression set already prevents a refire.
 */
export async function withRetry(
  task: () => Promise<void>,
  { attempts = 3, baseDelayMs = 500, sleep = defaultSleep }: RetryOptions = {},
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await task();
      return true;
    } catch {
      if (attempt < attempts - 1) await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  return false;
}
