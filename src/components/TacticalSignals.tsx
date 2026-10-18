import { CheckCircle2, TrendingDown, TrendingUp } from 'lucide-react';
import type { Asset } from '@/lib/assets';
import { REGIME_LABELS } from '@/lib/multiFactor';
import { usePortfolio } from '@/lib/portfolioStore';
import { LEDGER_NAMES } from '@/lib/portfolioAccounting';
import { generateTacticalSignals } from '@/lib/tacticalSignals';
import { TradeTicket } from '@/components/TradeTicket';
import { cn } from '@/lib/utils';

/**
 * Active Research Lab feed (M2-T2): Multi-Factor BUY/SELL ideas against the
 * active ledger's holdings. Fills book into that ledger as tactical trades.
 */
export function TacticalSignals({ assets }: { assets: Asset[] }) {
  const { activePortfolioType, portfolios } = usePortfolio();
  const ledger = portfolios[activePortfolioType];
  const signals = generateTacticalSignals(ledger.positions, assets, ledger.cashBalance);
  const assetByTicker = new Map(assets.map((asset) => [asset.ticker, asset]));

  return (
    <section className="portfolio-section" aria-label="Tactical signals">
      <div className="portfolio-section-head">
        <h3 className="portfolio-section-title">Tactical Signals</h3>
        <span className="portfolio-count">
          Multi-Factor · {LEDGER_NAMES[activePortfolioType]} ledger
        </span>
      </div>
      {signals.length > 0 ? (
        <div className="suggestion-list">
          {signals.map((signal) => {
            const isSell = signal.type === 'SELL';
            const asset = assetByTicker.get(signal.ticker);
            return (
              <div
                key={`${signal.type}-${signal.ticker}`}
                className={cn('suggestion-card', isSell ? 'suggestion-sell' : 'suggestion-buy')}
              >
                <span className="suggestion-icon">
                  {isSell ? <TrendingDown size={18} /> : <TrendingUp size={18} />}
                </span>
                <div className="suggestion-body">
                  <div className="suggestion-head">
                    <span className="suggestion-ticker">{signal.ticker}</span>
                    <span className="suggestion-type">
                      {isSell ? 'Weak signal — consider exiting' : 'Strong signal — entry idea'} ·{' '}
                      {REGIME_LABELS[signal.regime]} regime
                    </span>
                  </div>
                  <p className="suggestion-reason">{signal.rationale}</p>
                </div>
                <span className="suggestion-score">{signal.score}</span>
                {asset && (
                  <TradeTicket
                    asset={asset}
                    portfolioType={activePortfolioType}
                    intent="tactical"
                    initialSide={isSell ? 'sell' : 'buy'}
                  />
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="suggestion-empty">
          <CheckCircle2 size={22} />
          <div>
            <span className="suggestion-empty-title">No tactical signal right now</span>
            <span className="suggestion-empty-sub">
              No holding scores below 50 and no new asset scores 85+ on the Multi-Factor model.
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
