import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FreshnessBadge } from '@/components/FreshnessBadge';
import { FRESHNESS_STATES } from '@/lib/freshness';

describe('FreshnessBadge', () => {
  it.each(FRESHNESS_STATES)('renders an explicit, accessible %s chip', (state) => {
    const { container } = render(<FreshnessBadge state={state} />);
    const badge = container.querySelector('.freshness-badge');
    expect(badge).not.toBeNull();
    expect(badge).toHaveAttribute('data-freshness', state);
    expect(badge).toHaveClass(`freshness-${state.toLowerCase()}`);
    // Visible label + screen-reader context (no role-less aria-label).
    expect(screen.getByText(state)).toBeInTheDocument();
    expect(badge?.textContent).toContain('price data');
  });
});
