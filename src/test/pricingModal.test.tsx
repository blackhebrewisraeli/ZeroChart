import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null } })),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
      signOut: vi.fn(),
    },
  },
}));

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn() } }));

import { AdInterstitialModal } from '@/components/AdInterstitialModal';
import { PricingModal } from '@/components/PricingModal';
import { AD_ACTION_INTERVAL, recordHeavyAction, resetAdManager } from '@/lib/adManager';
import { AuthProvider, useAuth } from '@/lib/authStore';
import { PortfolioProvider } from '@/lib/portfolioStore';

let isPro = false;
function ProProbe() {
  isPro = useAuth().isPro;
  return <span data-testid="tier">{isPro ? 'pro' : 'basic'}</span>;
}

function renderWithAuth(ui: React.ReactNode) {
  return render(
    <PortfolioProvider>
      <AuthProvider>
        <ProProbe />
        {ui}
      </AuthProvider>
    </PortfolioProvider>,
  );
}

function heavyActions() {
  act(() => {
    for (let i = 0; i < AD_ACTION_INTERVAL; i += 1) recordHeavyAction(isPro);
  });
}

beforeEach(() => {
  localStorage.clear();
  resetAdManager();
});

describe('PricingModal', () => {
  it('switches between monthly and annual billing', () => {
    renderWithAuth(<PricingModal open onOpenChange={vi.fn()} />);

    expect(screen.getByText('$190')).toBeInTheDocument();
    expect(screen.getByText('/ year')).toBeInTheDocument();
    expect(screen.getByText('2 months free')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Monthly' }));
    expect(screen.getByRole('button', { name: 'Monthly' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('$19')).toBeInTheDocument();
    expect(screen.getByText('/ month')).toBeInTheDocument();
    expect(screen.queryByText(/billed annually/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /annual/i }));
    expect(screen.getByText('$190')).toBeInTheDocument();
    expect(screen.getByText(/billed annually/i)).toBeInTheDocument();
  });

  it('lists Zero Ads as a Pro perk', () => {
    renderWithAuth(<PricingModal open onOpenChange={vi.fn()} />);
    expect(screen.getByText(/zero ads/i)).toBeInTheDocument();
  });

  it('sandbox checkout flips a Free user to Pro live and stops the ads', async () => {
    renderWithAuth(<AdInterstitialModal />);
    await waitFor(() => expect(screen.getByTestId('tier')).toHaveTextContent('basic'));

    heavyActions();
    fireEvent.click(screen.getByRole('button', { name: /tired of ads\? upgrade/i }));
    fireEvent.click(screen.getByRole('button', { name: /sandbox checkout/i }));

    expect(screen.getByTestId('tier')).toHaveTextContent('pro');
    expect(screen.queryByRole('dialog')).toBeNull();

    heavyActions();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
