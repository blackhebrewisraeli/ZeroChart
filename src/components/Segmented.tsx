import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
}

/**
 * A two-option, iOS-style segmented control with a sliding glass thumb.
 * Both options share equal width; the thumb translates between them.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: {
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
}) {
  const activeIndex = Math.max(
    options.findIndex((option) => option.value === value),
    0,
  );

  return (
    <div className={cn('segment', className)} role="tablist" aria-label={ariaLabel}>
      <span
        className="segment-thumb"
        aria-hidden="true"
        style={{ transform: `translateX(${activeIndex * 100}%)` }}
      />
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          className={cn('segment-option', option.value === value && 'segment-option-active')}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
