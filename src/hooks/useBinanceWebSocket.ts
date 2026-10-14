import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { formatPrice, type Asset } from '@/lib/assets';
import { getAlerts, hasCrossed, removeAlert } from '@/lib/alertsStore';
import { toBinanceSymbol, toDisplayTicker } from '@/lib/binance';

const STREAM_URL = 'wss://stream.binance.com:9443/ws/!miniTicker@arr';
const THROTTLE_MS = 600;
const RECONNECT_DELAY_MS = 3000;

interface TickerUpdate {
  price: number;
  change: number; // 24h change as a fraction
}

/**
 * Fires any active price alerts crossed by the latest tick. Triggered alerts
 * are removed and surfaced as a toast notification.
 */
function checkAlerts(binanceSymbol: string, price: number): void {
  for (const alert of getAlerts()) {
    if (toBinanceSymbol(alert.ticker) !== binanceSymbol) continue;
    if (!hasCrossed(alert, price)) continue;
    removeAlert(alert.id);
    toast.success(`${toDisplayTicker(alert.ticker)} reached ${formatPrice(alert.targetPrice)}!`, {
      description:
        alert.direction === 'above' ? 'Price rose to your target.' : 'Price fell to your target.',
    });
  }
}

/**
 * Streams live crypto prices from the Binance all-market mini-ticker feed and
 * merges them into the given asset list. Updates are throttled to a single
 * state change per `THROTTLE_MS` to keep React renders cheap, the socket
 * auto-reconnects on drop, and it is cleanly torn down on unmount.
 */
export function useBinanceWebSocket(assets: Asset[]): Asset[] {
  const symbols = useRef<Set<string>>(new Set());
  const pending = useRef<Map<string, TickerUpdate>>(new Map());
  const [prices, setPrices] = useState<Map<string, TickerUpdate>>(new Map());

  // Keep the set of relevant Binance symbols in sync with the asset list.
  useEffect(() => {
    const next = new Set<string>();
    for (const asset of assets) {
      const symbol = toBinanceSymbol(asset.ticker);
      if (symbol) next.add(symbol);
    }
    symbols.current = next;
  }, [assets]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let stopped = false;

    function connect() {
      if (stopped) return;
      const ws = new WebSocket(STREAM_URL);
      socket = ws;

      ws.onmessage = (event) => {
        try {
          const data: unknown = JSON.parse(event.data);
          if (!Array.isArray(data)) return;
          for (const item of data) {
            const tick = item as { s?: string; c?: string; o?: string };
            const symbol = tick.s;
            if (!symbol || !symbols.current.has(symbol)) continue;
            const price = Number.parseFloat(tick.c ?? '');
            const open = Number.parseFloat(tick.o ?? '');
            if (!Number.isFinite(price) || !Number.isFinite(open) || open <= 0) continue;
            pending.current.set(symbol, { price, change: (price - open) / open });
            checkAlerts(symbol, price);
          }
        } catch {
          // Ignore malformed or non-JSON frames.
        }
      };

      ws.onclose = () => {
        if (!stopped) {
          reconnectTimer = window.setTimeout(connect, RECONNECT_DELAY_MS);
        }
      };

      ws.onerror = () => ws.close();
    }

    connect();

    // Throttle state updates: flush accumulated ticks at most once per interval.
    const flushTimer = window.setInterval(() => {
      if (pending.current.size === 0) return;
      const snapshot = new Map(pending.current);
      pending.current.clear();
      setPrices((prev) => {
        const next = new Map(prev);
        for (const [symbol, update] of snapshot) next.set(symbol, update);
        return next;
      });
    }, THROTTLE_MS);

    return () => {
      stopped = true;
      window.clearInterval(flushTimer);
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  if (prices.size === 0) return assets;

  return assets.map((asset) => {
    const symbol = toBinanceSymbol(asset.ticker);
    if (!symbol) return asset;
    const update = prices.get(symbol);
    if (!update) return asset;
    return { ...asset, current_price: update.price, change_24h: update.change };
  });
}
