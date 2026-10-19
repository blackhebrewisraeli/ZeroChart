import { BellRing, CheckCircle2, TrendingDown, TrendingUp } from 'lucide-react';
import { useAlerts } from '@/lib/alertsStore';
import { formatPrice, type Asset } from '@/lib/assets';
import { REGIME_LABELS } from '@/lib/multiFactor';
import { usePortfolio } from '@/lib/portfolioStore';
import { buildSignalFeed, generateTacticalSignals } from '@/lib/tacticalSignals';
import { TradeTicket } from '@/components/TradeTicket';
import { cn } from '@/lib/utils';

function FeedTime({ at }: { at: number | null }) {
  if (at === null) return null;
  return (
    <time className="suggestion-time" dateTime={new Date(at).toISOString()}>
      {new Date(at).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })}
    </time>
  );
}

/**
 * Tactical feed (M2-T2/T3): Multi-Factor BUY/SELL ideas against the Paper
 * Trading holdings, merged newest-first with price alerts fired this session.
 * Fills book into Paper Trading as tactical trades, never into Core. With
 * `onSelect`, clicking a card (its Trade button included, so keyboard users get
 * it too) also picks that ticker, e.g. for the terminal chart.
 */
export function TacticalSignals({
  assets,
  onSelect,
  selectedTicker,
}: {
  assets: Asset[];
  onSelect?: (ticker: string) => void;
  selectedTicker?: string | undefined;
}) {
  const { portfolios } = usePortfolio();
  const { triggered } = useAlerts();
  const ledger = portfolios.paper_trading;
  const signals = generateTacticalSignals(ledger.positions, assets, ledger.cashBalance);
  const feed = buildSignalFeed(signals, triggered);
  const assetByTicker = new Map(assets.map((asset) => [asset.ticker, asset]));
  const selectable = (ticker: string) =>
    onSelect && {
      onClick: () => onSelect(ticker),
      'data-selected': ticker === selectedTicker || undefined,
    };

  return (
    <section className="portfolio-section" aria-label="Tactical signals">
      <div className="portfolio-section-head">
        <h3 className="portfolio-section-title">Tactical Signals</h3>
        <span className="portfolio-count">Multi-Factor · Price Alerts · Paper Trading ledger</span>
      </div>
      {feed.length > 0 ? (
        <div className="suggestion-list">
          {feed.map((item) => {
            if (item.kind === 'alert') {
              const { alert, price } = item.trigger;
              const isUp = alert.condition === 'above';
              const asset = assetByTicker.get(alert.ticker);
              return (
                <div
                  key={`alert-${alert.id}`}
                  className={cn(
                    'suggestion-card',
                    isUp ? 'suggestion-alert-up' : 'suggestion-alert-down',
                  )}
                  {...selectable(alert.ticker)}
                >
                  <span className="suggestion-icon">
                    <BellRing size={18} />
                  </span>
                  <div className="suggestion-body">
                    <div className="suggestion-head">
                      <span className="suggestion-ticker">{alert.ticker}</span>
                      <span className="suggestion-source">Price Alert</span>
                      <span className="suggestion-type">
                        Crossed {isUp ? 'above' : 'below'} {formatPrice(alert.targetPrice)}
                      </span>
                      <FeedTime at={item.at} />
                    </div>
                    <p className="suggestion-reason">Triggered at {formatPrice(price)}.</p>
                  </div>
                  {asset && (
                    <TradeTicket asset={asset} portfolioType="paper_trading" intent="tactical" />
                  )}
                </div>
              );
            }

            const { signal } = item;
            const isSell = signal.type === 'SELL';
            const asset = assetByTicker.get(signal.ticker);
            return (
              <div
                key={`${signal.type}-${signal.ticker}`}
                className={cn('suggestion-card', isSell ? 'suggestion-sell' : 'suggestion-buy')}
                {...selectable(signal.ticker)}
              >
                <span className="suggestion-icon">
                  {isSell ? <TrendingDown size={18} /> : <TrendingUp size={18} />}
                </span>
                <div className="suggestion-body">
                  <div className="suggestion-head">
                    <span className="suggestion-ticker">{signal.ticker}</span>
                    <span className="suggestion-source">Quant Signal</span>
                    <span className="suggestion-type">
                      {isSell ? 'Weak signal — consider exiting' : 'Strong signal — entry idea'} ·{' '}
                      {REGIME_LABELS[signal.regime]} regime
                    </span>
                    <FeedTime at={item.at} />
                  </div>
                  <p className="suggestion-reason">{signal.rationale}</p>
                </div>
                <span className="suggestion-score">{signal.score}</span>
                {asset && (
                  <TradeTicket
                    asset={asset}
                    portfolioType="paper_trading"
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
              No holding scores below 50, no new asset scores 85+ on the Multi-Factor model, and no
              price alert has fired this session.
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
