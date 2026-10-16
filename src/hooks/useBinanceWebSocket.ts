import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { formatPrice, type Asset } from '@/lib/assets';
import { getAlerts, hasCrossed, removeAlert } from '@/lib/alertsStore';
import { setConnectionState, setLivePrices, type LivePrice } from '@/lib/livePriceStore';
import { toBinanceSymbol, toDisplayTicker } from '@/lib/binance';

const STREAM_URL = 'wss://stream.binance.com:9443/ws/!miniTicker@arr';
const THROTTLE_MS = 600;
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;
const BACKOFF_FACTOR = 2;

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
 * publishes them into the live-price store (one batched write per `THROTTLE_MS`).
 * Consumers subscribe to individual symbols via `useLivePrice`, so the socket
 * no longer forces a full React tree re-render on every tick. The socket
 * auto-reconnects on drop and is cleanly torn down on unmount.
 */
export function useBinanceWebSocket(assets: Asset[]): void {
  const symbols = useRef<Set<string>>(new Set());
  const pending = useRef<Map<string, LivePrice>>(new Map());

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
    let reconnectAttempt = 0;
    let stopped = false;

    function scheduleReconnect() {
      const delay = Math.min(
        INITIAL_RECONNECT_DELAY_MS * Math.pow(BACKOFF_FACTOR, reconnectAttempt),
        MAX_RECONNECT_DELAY_MS,
      );
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(connect, delay);
    }

    function connect() {
      if (stopped) return;
      const ws = new WebSocket(STREAM_URL);
      socket = ws;

      ws.onopen = () => {
        reconnectAttempt = 0;
        setConnectionState('connected');
      };

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
        if (stopped) return;
        setConnectionState('reconnecting');
        scheduleReconnect();
      };

      ws.onerror = () => ws.close();
    }

    connect();

    // Throttle writes: flush accumulated ticks into the store at most once per interval.
    const flushTimer = window.setInterval(() => {
      if (pending.current.size === 0) return;
      const snapshot = new Map(pending.current);
      pending.current.clear();
      setLivePrices(snapshot);
    }, THROTTLE_MS);

    return () => {
      stopped = true;
      window.clearInterval(flushTimer);
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);
}
