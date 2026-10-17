import type { FreshnessState } from '@/lib/freshness';
import { cn } from '@/lib/utils';

const FRESHNESS_COPY: Record<FreshnessState, { label: string; hint: string }> = {
  Live: { label: 'Live', hint: 'Real-time WebSocket price' },
  Delayed: { label: 'Delayed', hint: 'Provider snapshot (fresh)' },
  Stale: { label: 'Stale', hint: 'Provider snapshot older than 2 hours' },
  Unavailable: { label: 'Unavailable', hint: 'No usable price data' },
  Simulated: { label: 'Simulated', hint: 'Illustrative sample — not live market data' },
};

/**
 * Small explicit freshness chip (M1-T4, F-3.2b). Renders one of the five
 * freshness states so no price ever masquerades as real-time data. The
 * visible label is real text (plus screen-reader-only context) rather than an
 * `aria-label` on a role-less span, which assistive tech may ignore.
 */
export function FreshnessBadge({
  state,
  className,
}: {
  state: FreshnessState;
  className?: string;
}) {
  const copy = FRESHNESS_COPY[state];
  return (
    <span
      className={cn('freshness-badge', `freshness-${state.toLowerCase()}`, className)}
      title={copy.hint}
      data-freshness={state}
    >
      {copy.label}
      <span className="sr-only"> price data — {copy.hint}</span>
    </span>
  );
}
