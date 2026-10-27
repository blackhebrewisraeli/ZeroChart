import { formatShares } from '@/lib/risk';

/**
 * A unit quantity as formatShares writes it. When that rounds ("≈", or dust),
 * the stored value is in the tooltip, and it is what a screen reader reads.
 */
export function Shares({ value }: Readonly<{ value: number }>) {
  const text = formatShares(value);
  if (!/^[≈<]/.test(text)) return <>{text}</>;
  return (
    <span className="shares-rounded" title={`Exact: ${value}`}>
      <span aria-hidden="true">{text}</span>
      <span className="sr-only">{value}</span>
    </span>
  );
}
