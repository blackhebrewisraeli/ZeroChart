import { MIN_CANDLES } from '@/lib/canonicalModel';
import { cn } from '@/lib/utils';

const HINT = `Not enough data — scoring needs ${MIN_CANDLES} daily candles`;

/**
 * Muted stand-in wherever a Signal Score would show but the canonical engine
 * returned INSUFFICIENT_DATA — never a fake 0. `compact` fits narrow table cells.
 */
export function InsufficientDataBadge({
  compact = false,
  className,
}: Readonly<{
  compact?: boolean;
  className?: string;
}>) {
  return (
    <span
      className={cn('insufficient-data-badge', compact && 'is-compact', className)}
      title={HINT}
    >
      {compact ? 'No data' : 'Not Enough Data'}
    </span>
  );
}
