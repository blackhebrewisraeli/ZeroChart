import { useEffect, useState } from 'react';
import type { Asset } from '@/lib/assets';

const TICK_MS = 4000;
const MAX_JITTER = 0.006; // ±0.3% per tick

/**
 * Lightweight "live market" simulator. Nudges every asset price by a small random
 * percentage every few seconds so the terminal visibly ticks in real time — a
 * stand-in until a real WebSocket feed is wired up.
 */
export function useSimulatedPrices(assets: Asset[]): Asset[] {
  const [simulated, setSimulated] = useState<Asset[]>(assets);

  // Re-seed whenever the underlying dataset changes (live ↔ sample, refetch, etc.)
  useEffect(() => {
    setSimulated(assets);
  }, [assets]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setSimulated((prev) =>
        prev.map((asset) => {
          const price = asset.current_price;
          if (price == null || !Number.isFinite(price) || price <= 0) return asset;
          const delta = (Math.random() - 0.5) * MAX_JITTER;
          const nextPrice = price * (1 + delta);
          const nextChange = asset.change_24h == null ? null : asset.change_24h + delta;
          return { ...asset, current_price: nextPrice, change_24h: nextChange };
        }),
      );
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  return simulated;
}
