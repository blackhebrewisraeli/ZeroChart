import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Sparkles, TrendingUp } from 'lucide-react';
import { PricingModal } from '@/components/PricingModal';
import { dismissAd, useAdOpen } from '@/lib/adManager';
import { useAuth } from '@/lib/authStore';

const COUNTDOWN_SECONDS = 3;

/**
 * App-wide host for the Basic-tier interstitial. Mount once inside
 * `AuthProvider`; `adManager` decides when it opens. Pro users never see it,
 * including an ad that was already open when they upgraded.
 */
export function AdInterstitialModal() {
  const { isPro } = useAuth();
  const adOpen = useAdOpen();
  const [pricingOpen, setPricingOpen] = useState(false);

  function upgrade() {
    dismissAd();
    setPricingOpen(true);
  }

  return (
    <>
      {adOpen && !isPro && <AdDialog onUpgrade={upgrade} />}
      <PricingModal open={pricingOpen} onOpenChange={setPricingOpen} />
    </>
  );
}

/** Mounted per ad, so every ad starts a fresh countdown. */
function AdDialog({ onUpgrade }: { onUpgrade: () => void }) {
  const [secondsLeft, setSecondsLeft] = useState(COUNTDOWN_SECONDS);
  const locked = secondsLeft > 0;

  useEffect(() => {
    if (!locked) return;
    const timer = window.setTimeout(() => setSecondsLeft((seconds) => seconds - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [secondsLeft, locked]);

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) dismissAd();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="pricing-overlay ad-overlay" />
        <Dialog.Content
          className="pricing-modal ad-modal"
          aria-describedby="ad-description"
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            if (locked) event.preventDefault();
          }}
        >
          <div className="pricing-scanline" aria-hidden="true" />
          <span className="ad-sponsor-label">Sponsored · Quant Partner</span>
          <header className="pricing-header">
            <span className="pricing-icon" aria-hidden="true">
              <TrendingUp size={18} />
            </span>
            <div>
              <Dialog.Title className="pricing-title">
                Institutional tick data at retail prices
              </Dialog.Title>
              <Dialog.Description id="ad-description" className="pricing-description">
                Stream 20 years of order-book history straight into your models. First month on us.
              </Dialog.Description>
            </div>
          </header>
          <button type="button" className="pricing-upgrade-button" onClick={onUpgrade}>
            <Sparkles size={16} /> Tired of ads? Upgrade to ZeroChart Pro
          </button>
          <Dialog.Close className="pricing-basic-button ad-dismiss-button" disabled={locked}>
            {locked ? `Dismiss in ${secondsLeft}s` : 'Dismiss'}
          </Dialog.Close>
          <p className="pricing-footnote">Demo placement. No partner receives your data.</p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
