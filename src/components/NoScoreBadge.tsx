import { MIN_CANDLES, type CanonicalResult } from '@/lib/canonicalModel';
import { scanStatusLabel } from '@/lib/marketScanner';
import { cn } from '@/lib/utils';

export type NoScoreStatus = Exclude<CanonicalResult['status'], 'OK'>;

const HINTS: Record<NoScoreStatus, string> = {
  INSUFFICIENT_DATA: `Not enough data — scoring needs ${MIN_CANDLES} daily candles`,
  UNSUPPORTED: 'No validated daily candle source for this asset class — never scored',
  FETCH_FAILED: 'Candle history failed to load — not scored',
  STALE_DATA: 'Latest closed candle is too old — not scored',
  DATA_INVALID: 'Candle history failed validation — not scored',
};

/**
 * Muted stand-in wherever a Signal Score would show but the canonical engine
 * has none — never a fake 0. Says why, in the Markets scan's words: an asset
 * that was never scanned is not one with too little history. `compact` fits
 * narrow table cells.
 */
export function NoScoreBadge({
  status,
  compact = false,
  className,
}: Readonly<{
  status: NoScoreStatus;
  compact?: boolean;
  className?: string;
}>) {
  const shortHistory = compact ? 'No data' : 'Not Enough Data';
  const label = status === 'INSUFFICIENT_DATA' ? shortHistory : scanStatusLabel({ status });
  return (
    <span
      className={cn('insufficient-data-badge', compact && 'is-compact', className)}
      title={HINTS[status]}
    >
      {label}
    </span>
  );
}
