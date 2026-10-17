import { Link } from '@tanstack/react-router';
import { ArrowRight, LockKeyhole, TrendingDown, TrendingUp, Zap } from 'lucide-react';
import { Cell, Pie, PieChart, Tooltip } from 'recharts';
import { ALLOCATION_PALETTE } from '@/lib/allocation';
import { REGIME_LABELS } from '@/lib/multiFactor';
import type { SharedPortfolioRecord, SharedPortfolioHolding } from '@/lib/sharedPortfolio';
import { cn } from '@/lib/utils';

function formatPercent(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function pnlTone(value: number | null): string | undefined {
  if (value === null) return undefined;
  return value >= 0 ? 'pnl-up' : 'pnl-down';
}

function scoreTone(score: number): string {
  return score >= 80 ? 'shared-score-high' : score >= 60 ? 'shared-score-mid' : 'shared-score-low';
}

function AllocationTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: SharedPortfolioHolding }>;
}) {
  const holding = payload?.[0]?.payload;
  if (!active || !holding) return null;
  return (
    <div className="allocation-tooltip">
      <span className="allocation-tooltip-ticker">{holding.ticker}</span>
      <span className="allocation-tooltip-value">{holding.allocationPercent.toFixed(1)}%</span>
      <span className="allocation-tooltip-pct">{formatPercent(holding.pnlPercent)} return</span>
    </div>
  );
}

function BrandCta({ compact = false }: { compact?: boolean }) {
  return (
    <Link to="/" className={cn('shared-portfolio-cta', compact && 'is-compact')}>
      <span>Built with ZeroChart - Create your own Quant Portfolio</span>
      <ArrowRight size={16} aria-hidden="true" />
    </Link>
  );
}

export function SharedPortfolioView({ record }: { record: SharedPortfolioRecord }) {
  const { snapshot } = record;
  const largest = snapshot.holdings[0];
  const { maxDrawdownPercent: drawdown, alphaPercent: alpha } = snapshot;
  const publishedAt = new Date(snapshot.createdAt);
  const publishedLabel = Number.isNaN(publishedAt.getTime())
    ? 'Published portfolio snapshot'
    : `Snapshot from ${publishedAt.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })}`;

  return (
    <main className="shared-portfolio-page">
      <div className="shared-portfolio-shell">
        <header className="shared-portfolio-header">
          <Link to="/" className="shared-portfolio-brand" aria-label="ZeroChart home">
            <span className="shared-portfolio-brand-mark">Z</span>
            <span>ZEROCHART</span>
          </Link>
          <BrandCta compact />
        </header>

        <section className="shared-portfolio-hero" aria-labelledby="shared-portfolio-title">
          <div className="shared-portfolio-hero-copy">
            <span className="shared-readonly-badge">
              <LockKeyhole size={13} aria-hidden="true" /> Public · Read-only
            </span>
            <h1 id="shared-portfolio-title">Quant Portfolio Snapshot</h1>
            <p>
              A transparent, point-in-time view of allocation, performance, and algorithmic signal
              strength.
            </p>
            <span className="shared-portfolio-date">{publishedLabel}</span>
          </div>
          <div className={cn('shared-hero-score', scoreTone(snapshot.quantScore))}>
            <span className="shared-hero-score-value">{Math.round(snapshot.quantScore)}</span>
            <span className="shared-hero-score-label">ROBO SCORE</span>
          </div>
        </section>

        <section className="shared-kpi-grid" aria-label="Portfolio summary">
          <div className="shared-kpi-card">
            <span className="shared-kpi-label">Total return</span>
            <strong className={pnlTone(snapshot.pnlPercent)}>
              {formatPercent(snapshot.pnlPercent)}
            </strong>
            <span>Unrealized, since entry</span>
          </div>
          <div className="shared-kpi-card">
            <span className="shared-kpi-label">Max drawdown</span>
            <strong className={pnlTone(drawdown === null ? null : -drawdown)}>
              {drawdown === null ? '—' : formatPercent(-drawdown)}
            </strong>
            <span>Peak to trough, up to 1 year</span>
          </div>
          <div className="shared-kpi-card">
            <span className="shared-kpi-label">Alpha</span>
            <strong className={pnlTone(alpha)}>
              {alpha === null ? '—' : formatPercent(alpha)}
            </strong>
            <span>vs BTC buy &amp; hold, same window</span>
          </div>
          <div className="shared-kpi-card">
            <span className="shared-kpi-label">Positions</span>
            <strong>{snapshot.holdings.length}</strong>
            <span>
              {largest
                ? `Largest: ${largest.ticker} ${largest.allocationPercent.toFixed(1)}%`
                : 'No holdings'}
            </span>
          </div>
        </section>

        <div className="shared-portfolio-grid">
          <section className="shared-panel" aria-labelledby="shared-allocation-title">
            <div className="shared-panel-heading">
              <div>
                <span className="shared-panel-kicker">PORTFOLIO MAP</span>
                <h2 id="shared-allocation-title">Asset allocation</h2>
              </div>
              <span className="shared-panel-count">{snapshot.holdings.length} POSITIONS</span>
            </div>

            {snapshot.holdings.length > 0 ? (
              <div className="shared-allocation-layout">
                <div className="shared-allocation-chart">
                  <PieChart width={224} height={224}>
                    <Pie
                      data={snapshot.holdings}
                      dataKey="allocationPercent"
                      nameKey="ticker"
                      innerRadius={70}
                      outerRadius={104}
                      paddingAngle={2}
                      stroke="none"
                      isAnimationActive={false}
                    >
                      {snapshot.holdings.map((holding, index) => (
                        <Cell
                          key={holding.ticker}
                          fill={ALLOCATION_PALETTE[index % ALLOCATION_PALETTE.length]}
                        />
                      ))}
                    </Pie>
                    <Tooltip content={<AllocationTooltip />} />
                  </PieChart>
                  <div className="shared-allocation-center">
                    <span>ASSETS</span>
                    <strong>{snapshot.holdings.length}</strong>
                  </div>
                </div>
                <div className="shared-allocation-legend">
                  {snapshot.holdings.map((holding, index) => (
                    <div key={holding.ticker} className="shared-allocation-row">
                      <span className="shared-allocation-name">
                        <i
                          aria-hidden="true"
                          style={{
                            backgroundColor: ALLOCATION_PALETTE[index % ALLOCATION_PALETTE.length],
                          }}
                        />
                        <span>
                          <strong>{holding.ticker}</strong>
                          <small>{holding.name}</small>
                        </span>
                      </span>
                      <span className="shared-allocation-value">
                        <strong>{holding.allocationPercent.toFixed(1)}%</strong>
                        <small>{formatPercent(holding.pnlPercent)}</small>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="shared-empty-state">This snapshot does not contain any holdings.</div>
            )}
          </section>

          <section className="shared-panel" aria-labelledby="shared-scores-title">
            <div className="shared-panel-heading">
              <div>
                <span className="shared-panel-kicker">ALGORITHMIC READOUT</span>
                <h2 id="shared-scores-title">Robo-Advisor scores</h2>
              </div>
              <Zap size={18} aria-hidden="true" />
            </div>
            <div className="shared-score-list">
              {snapshot.holdings.map((holding) => {
                const holdingTone = holding.pnlPercent >= 0 ? 'pnl-up' : 'pnl-down';
                return (
                  <article key={holding.ticker} className="shared-score-row">
                    <div className="shared-score-asset">
                      <strong>{holding.ticker}</strong>
                      <span>{REGIME_LABELS[holding.regime]}</span>
                    </div>
                    <div className={cn('shared-score-pill', scoreTone(holding.quantScore))}>
                      {Math.round(holding.quantScore)}
                    </div>
                    <div className={cn('shared-score-pnl', holdingTone)}>
                      {holding.pnlPercent >= 0 ? (
                        <TrendingUp size={14} aria-hidden="true" />
                      ) : (
                        <TrendingDown size={14} aria-hidden="true" />
                      )}
                      <span>{formatPercent(holding.pnlPercent)}</span>
                    </div>
                  </article>
                );
              })}
              {snapshot.holdings.length === 0 && (
                <div className="shared-empty-state">
                  Robo scores appear when holdings are added.
                </div>
              )}
            </div>
          </section>
        </div>

        <section className="shared-bottom-cta" aria-label="Create a ZeroChart portfolio">
          <span className="shared-panel-kicker">YOUR TURN</span>
          <h2>Build a portfolio that explains itself.</h2>
          <p>Track allocation, P&amp;L, and quant signals in one focused terminal.</p>
          <BrandCta />
        </section>

        <footer className="shared-portfolio-footer">
          <span>
            Read-only snapshot · Percentages only — no balances or share counts are shared.
          </span>
        </footer>
      </div>
    </main>
  );
}
