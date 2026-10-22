import { cn } from '@/lib/utils';

type AssetIconSize = 'sm' | 'md' | 'lg';

const SIZES: Record<AssetIconSize, string> = {
  sm: 'asset-icon-sm',
  md: 'asset-icon-md',
  lg: 'asset-icon-lg',
};

/**
 * Derives a compact monogram label from a full ticker/symbol:
 *   'BTC-USD' -> 'BTC', 'EURUSD=X' -> 'EUR', 'AAPL' -> 'AAPL'.
 */
function monogramFor(symbol: string): string {
  const clean = symbol.trim().toUpperCase();
  if (!clean) return '?';
  if (clean.endsWith('=X')) {
    const pair = clean.slice(0, -2);
    return pair.slice(0, 3) || clean.slice(0, 3);
  }
  const base = clean.replace(/[-.]?(USD|USDT)$/, '');
  return (base || clean).slice(0, 4);
}

export interface AssetIconProps {
  /** Asset ticker/symbol, e.g. 'BTC-USD', 'EURUSD=X', or 'AAPL'. */
  symbol: string;
  /** Human-readable asset name for the accessible label/tooltip. */
  name?: string | null;
  /** Optional image/logo source. Rendered monochromatically when provided. */
  src?: string | null;
  size?: AssetIconSize;
  className?: string;
}

/**
 * A unified, monochromatic asset icon. Renders a filtered image when a `src`
 * is supplied, otherwise falls back to a sleek circular monogram that blends
 * into the terminal theme.
 */
export function AssetIcon({ symbol, name, src, size = 'md', className }: Readonly<AssetIconProps>) {
  const label = monogramFor(symbol);
  const accessibleName = name ? `${symbol} · ${name}` : symbol;

  return (
    <span
      className={cn(
        'asset-icon border border-border bg-muted/30 text-muted-foreground',
        SIZES[size],
        className,
      )}
      role="img"
      aria-label={accessibleName}
      title={accessibleName}
    >
      {src ? (
        <img
          src={src}
          alt=""
          aria-hidden="true"
          draggable={false}
          loading="lazy"
          className="asset-icon-img"
        />
      ) : (
        <span className="asset-icon-mono" aria-hidden="true">
          {label}
        </span>
      )}
    </span>
  );
}
