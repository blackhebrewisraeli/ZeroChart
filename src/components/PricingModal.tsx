import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, LockKeyhole, Sparkles, X } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/lib/authStore';
import { cn } from '@/lib/utils';

type BillingCycle = 'monthly' | 'annual';

interface PricingModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const PRO_FEATURES = [
  'Multi-Factor Breakdown',
  'Market Regime Detection',
  'ATR Trailing Stops',
  'Realistic Backtest Friction',
  'Zero Ads: a trading experience free of pop-up ads',
] as const;

export function PricingModal({ open, onOpenChange }: Readonly<PricingModalProps>) {
  const [billingCycle, setBillingCycle] = useState<BillingCycle>('annual');
  const isAnnual = billingCycle === 'annual';
  const { activateSandboxPro } = useAuth();

  function handleSandboxCheckout() {
    activateSandboxPro();
    onOpenChange(false);
    toast.success('Pro activated (sandbox)', {
      description: 'Locks and ads are gone for this tab. Reload to return to Basic.',
    });
  }

  function handleUpgrade() {
    onOpenChange(false);
    toast.info('Stripe integration pending', {
      description: 'Pro checkout will be available soon.',
    });
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="pricing-overlay" />
        <Dialog.Content className="pricing-modal" aria-describedby="pricing-description">
          <div className="pricing-scanline" aria-hidden="true" />
          <Dialog.Close className="pricing-close" aria-label="Close pricing">
            <X size={18} />
          </Dialog.Close>

          <header className="pricing-header">
            <span className="pricing-icon" aria-hidden="true">
              <Sparkles size={18} />
            </span>
            <div>
              <Dialog.Title className="pricing-title">Unlock the full quant stack</Dialog.Title>
              <Dialog.Description id="pricing-description" className="pricing-description">
                Deeper factor analysis and more realistic backtests.
              </Dialog.Description>
            </div>
          </header>

          <div className="pricing-billing" aria-label="Billing cycle">
            <button
              type="button"
              className={cn('pricing-billing-option', !isAnnual && 'is-active')}
              aria-pressed={!isAnnual}
              onClick={() => setBillingCycle('monthly')}
            >
              Monthly
            </button>
            <button
              type="button"
              className={cn('pricing-billing-option', isAnnual && 'is-active')}
              aria-pressed={isAnnual}
              onClick={() => setBillingCycle('annual')}
            >
              Annual <span className="pricing-billing-tag">2 months free</span>
            </button>
          </div>

          <div className="pricing-grid">
            <section className="pricing-tier pricing-tier-basic" aria-labelledby="basic-tier-title">
              <div>
                <h3 id="basic-tier-title" className="pricing-tier-name">
                  Basic
                </h3>
                <p className="pricing-tier-copy">Track markets and build a portfolio.</p>
              </div>
              <p className="pricing-price">
                <strong>Free</strong>
                <span>forever</span>
              </p>
              <ul className="pricing-feature-list">
                <li>
                  <Check size={15} /> Live market dashboard
                </li>
                <li>
                  <Check size={15} /> Portfolio tracking
                </li>
                <li>
                  <Check size={15} /> Standard historical simulation
                </li>
              </ul>
              <button
                type="button"
                className="pricing-basic-button"
                onClick={() => onOpenChange(false)}
              >
                Continue with Basic
              </button>
            </section>

            <section className="pricing-tier pricing-tier-pro" aria-labelledby="pro-tier-title">
              <div className="pricing-pro-heading">
                <div>
                  <h3 id="pro-tier-title" className="pricing-tier-name">
                    Pro
                  </h3>
                  <p className="pricing-tier-copy">Make every decision with the full model.</p>
                </div>
                <span className="pricing-pro-badge">Best value</span>
              </div>
              <p className="pricing-price">
                <strong>{isAnnual ? '$190' : '$19'}</strong>
                <span>{isAnnual ? '/ year' : '/ month'}</span>
              </p>
              {isAnnual && <p className="pricing-equivalent">$15.83/month, billed annually</p>}
              <ul className="pricing-feature-list pricing-feature-list-pro">
                {PRO_FEATURES.map((feature) => (
                  <li key={feature}>
                    <Check size={15} /> {feature}
                  </li>
                ))}
              </ul>
              <button type="button" className="pricing-upgrade-button" onClick={handleUpgrade}>
                <LockKeyhole size={16} /> Upgrade to Pro
              </button>
              {import.meta.env.DEV && (
                <button
                  type="button"
                  className="pricing-sandbox-button"
                  onClick={handleSandboxCheckout}
                >
                  Sandbox checkout (test mode)
                </button>
              )}
            </section>
          </div>

          <p className="pricing-footnote">Cancel anytime. Your Basic workspace stays intact.</p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
