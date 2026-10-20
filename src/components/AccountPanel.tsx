import { useState } from 'react';
import { Download, KeyRound, Sparkles } from 'lucide-react';
import type { Asset } from '@/lib/assets';
import { useAuth } from '@/lib/authStore';
import { usePortfolio } from '@/lib/portfolioStore';
import { LEDGER_NAMES, type PortfolioType } from '@/lib/portfolioAccounting';
import { downloadCsv, tradeLedgerCsv } from '@/lib/tradeLedger';
import { PineScriptModal } from '@/components/PineScriptModal';
import { PortfolioDashboard } from '@/components/PortfolioDashboard';
import { PricingModal } from '@/components/PricingModal';

/** Same filenames the Paper Desk and Core dashboards export under. */
const EXPORTS: { type: PortfolioType; filename: string }[] = [
  { type: 'paper_trading', filename: 'zerochart-ledger-paper.csv' },
  { type: 'long_term_sim', filename: 'zerochart-ledger-simulation.csv' },
  { type: 'real_tracking', filename: 'zerochart-ledger-live.csv' },
];

/**
 * Account zone: plan, TradingView webhook, data export, and the one place
 * real (tracked) holdings appear, kept apart from every simulated ledger.
 */
export function AccountPanel({ assets }: Readonly<{ assets: Asset[] }>) {
  const { user, isPro } = useAuth();
  const { portfolios } = usePortfolio();
  const [pricingOpen, setPricingOpen] = useState(false);
  const [pineOpen, setPineOpen] = useState(false);

  return (
    <section className="portfolio" aria-label="Account">
      <header className="portfolio-head">
        <div>
          <h2 className="portfolio-title">Account</h2>
          <p className="portfolio-subtitle">{user?.email}</p>
        </div>
      </header>

      <div className="account-grid">
        <section
          className="portfolio-workspace-card account-card"
          aria-labelledby="account-plan-title"
        >
          <h3 id="account-plan-title" className="portfolio-section-title">
            Subscription
          </h3>
          <span className="account-plan">{isPro ? 'Pro' : 'Basic · Free'}</span>
          <p>
            {isPro
              ? 'Factor breakdowns, regime detection and backtest friction are unlocked.'
              : 'Pro adds factor breakdowns, regime detection, backtest friction and no ads.'}
          </p>
          {!isPro && (
            <button
              type="button"
              className="portfolio-cash-btn"
              onClick={() => setPricingOpen(true)}
            >
              <Sparkles size={13} /> See Pro plans
            </button>
          )}
        </section>

        <section
          className="portfolio-workspace-card account-card"
          aria-labelledby="account-webhook-title"
        >
          <h3 id="account-webhook-title" className="portfolio-section-title">
            TradingView Webhook
          </h3>
          <p>
            Generate a webhook token and a Pine Script with it baked in. Alerts land in the Action
            Center on your Paper Desk.
          </p>
          <button type="button" className="portfolio-cash-btn" onClick={() => setPineOpen(true)}>
            <KeyRound size={13} /> Manage webhook keys
          </button>
        </section>

        <section
          className="portfolio-workspace-card account-card"
          aria-labelledby="account-export-title"
        >
          <h3 id="account-export-title" className="portfolio-section-title">
            Data Export
          </h3>
          <p>Download any ledger as CSV: fills, fees, cash movements and realized P&amp;L.</p>
          <div className="account-actions">
            {EXPORTS.map(({ type, filename }) => (
              <button
                key={type}
                type="button"
                className="portfolio-cash-btn"
                disabled={portfolios[type].transactions.length === 0}
                onClick={() => downloadCsv(filename, tradeLedgerCsv(portfolios[type].transactions))}
              >
                <Download size={13} /> {LEDGER_NAMES[type]}
              </button>
            ))}
          </div>
        </section>
      </div>

      <hr className="zone-divider" />
      <PortfolioDashboard assets={assets} portfolioType="real_tracking" />

      <PricingModal open={pricingOpen} onOpenChange={setPricingOpen} />
      <PineScriptModal open={pineOpen} onOpenChange={setPineOpen} />
    </section>
  );
}
