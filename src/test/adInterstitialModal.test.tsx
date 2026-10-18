import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdInterstitialModal } from '@/components/AdInterstitialModal';
import {
  AD_ACTION_INTERVAL,
  AD_COOLDOWN_MS,
  recordHeavyAction,
  resetAdManager,
} from '@/lib/adManager';

const authState = vi.hoisted(() => ({ isPro: false, activateSandboxPro: () => {} }));

vi.mock('@/lib/authStore', () => ({
  useAuth: () => authState,
}));

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn() } }));

function heavyActions(now = 0) {
  act(() => {
    for (let i = 0; i < AD_ACTION_INTERVAL; i += 1) recordHeavyAction(authState.isPro, now);
  });
}

const adDialog = () => screen.queryByRole('dialog', { name: /tick data/i });

beforeEach(() => {
  authState.isPro = false;
  resetAdManager();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AdInterstitialModal', () => {
  it('shows a Free user the ad with a countdown before Dismiss unlocks', () => {
    vi.useFakeTimers();
    render(<AdInterstitialModal />);

    heavyActions();
    expect(adDialog()).toBeInTheDocument();
    expect(screen.getByText(/sponsored · quant partner/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss in 3s' })).toBeDisabled();

    for (let i = 0; i < 3; i += 1) act(() => vi.advanceTimersByTime(1000));

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(adDialog()).toBeNull();
  });

  it('respects the cooldown before showing the next ad', () => {
    vi.useFakeTimers();
    render(<AdInterstitialModal />);
    heavyActions(0);
    for (let i = 0; i < 3; i += 1) act(() => vi.advanceTimersByTime(1000));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    heavyActions(AD_COOLDOWN_MS - 1);
    expect(adDialog()).toBeNull();

    heavyActions(AD_COOLDOWN_MS);
    expect(adDialog()).toBeInTheDocument();
  });

  it('never shows an ad to a Pro user', () => {
    authState.isPro = true;
    render(<AdInterstitialModal />);

    heavyActions();
    heavyActions(AD_COOLDOWN_MS);
    expect(adDialog()).toBeNull();
  });

  it('removes an open ad the moment the user becomes Pro', () => {
    const { rerender } = render(<AdInterstitialModal />);
    heavyActions();
    expect(adDialog()).toBeInTheDocument();

    authState.isPro = true;
    rerender(<AdInterstitialModal />);
    expect(adDialog()).toBeNull();
  });

  it('opens the pricing modal from the upgrade call-to-action', () => {
    render(<AdInterstitialModal />);
    heavyActions();

    fireEvent.click(
      screen.getByRole('button', { name: /tired of ads\? upgrade to zerochart pro/i }),
    );

    expect(adDialog()).toBeNull();
    expect(
      screen.getByRole('dialog', { name: /unlock the full quant stack/i }),
    ).toBeInTheDocument();
  });
});
