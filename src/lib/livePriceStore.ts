import { useSyncExternalStore } from 'react';
import { toBinanceSymbol } from '@/lib/binance';
import type { Asset } from '@/lib/assets';

export interface LivePrice {
  price: number;
  /** 24h change as a fraction. */
  change: number;
}

// Module-level store so any mounted component can subscribe without a provider.
let priceMap = new Map<string, LivePrice>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Batch-writes incoming ticks; unchanged symbols keep their object identity. */
export function setLivePrices(updates: Map<string, LivePrice>): void {
  const next = new Map(priceMap);
  for (const [symbol, update] of updates) next.set(symbol, update);
  priceMap = next;
  emit();
}

export function getLivePrice(symbol: string): LivePrice | undefined {
  return priceMap.get(symbol);
}

function getLivePricesSnapshot(): Map<string, LivePrice> {
  return priceMap;
}

/**
 * Subscribes to a single symbol's live price. The component only re-renders
 * when that symbol's price object changes — not on unrelated ticks.
 */
export function useLivePrice(symbol: string | null): LivePrice | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (symbol ? priceMap.get(symbol) : undefined),
    () => undefined,
  );
}

/** Subscribes to the whole live-price map (for bulk computations). */
export function useLivePrices(): Map<string, LivePrice> {
  return useSyncExternalStore(subscribe, getLivePricesSnapshot, () => new Map());
}

export type ConnectionState = 'connected' | 'reconnecting';

let connectionState: ConnectionState = 'connected';
const connectionListeners = new Set<() => void>();

function subscribeConnection(listener: () => void): () => void {
  connectionListeners.add(listener);
  return () => {
    connectionListeners.delete(listener);
  };
}

/** Marks the WebSocket connection as connected or reconnecting. */
export function setConnectionState(state: ConnectionState): void {
  if (connectionState === state) return;
  connectionState = state;
  for (const listener of connectionListeners) listener();
}

/** Subscribes to the WebSocket connection state. */
export function useConnectionState(): ConnectionState {
  return useSyncExternalStore(
    subscribeConnection,
    () => connectionState,
    () => 'connected',
  );
}

/** Merges live prices into a static asset list, leaving non-crypto assets alone. */
export function mergeLivePrices(assets: Asset[], prices: Map<string, LivePrice>): Asset[] {
  return assets.map((asset) => {
    const symbol = toBinanceSymbol(asset.ticker);
    if (!symbol) return asset;
    const live = prices.get(symbol);
    if (!live) return asset;
    return { ...asset, current_price: live.price, change_24h: live.change };
  });
}
