import { useEffect, useRef, useState } from 'react';

type FlashDirection = 'up' | 'down';

/**
 * Returns a CSS class ("price-flash-up" / "price-flash-down") for ~520ms whenever
 * the watched numeric value changes, so prices can flash neon green/red HFT-style.
 */
export function usePriceFlash(value: number | null | undefined): string {
  const previous = useRef<number | null | undefined>(value);
  const [flash, setFlash] = useState<FlashDirection | null>(null);

  useEffect(() => {
    const current = value;
    const prior = previous.current;
    previous.current = current;

    if (current == null || prior == null || !Number.isFinite(current) || !Number.isFinite(prior)) {
      return;
    }
    if (current === prior) return;

    setFlash(current > prior ? 'up' : 'down');
    const timer = window.setTimeout(() => setFlash(null), 520);
    return () => window.clearTimeout(timer);
  }, [value]);

  if (flash === 'up') return 'price-flash-up';
  if (flash === 'down') return 'price-flash-down';
  return '';
}
