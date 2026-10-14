import { useState } from 'react';
import {
  Briefcase,
  CheckCircle2,
  ChevronDown,
  Pencil,
  Trash2,
  TrendingDown,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { calculateSignalScore, formatPrice, type Asset } from '@/lib/assets';
import {
  calculatePortfolioStats,
  generateSuggestions,
  type Position,
  type Suggestion,
} from '@/lib/portfolioManager';
import { usePortfolio } from '@/lib/portfolioStore';
import { Segmented } from '@/components/Segmented';
import { cn } from '@/lib/utils';

type PortfolioMode = 'simulation' | 'live';

const AVAILABLE_CASH = 2500;

function formatPnl(value: number) {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${formatPrice(Math.abs(value))}`;
}

function formatSignedPercent(value: number) {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function healthTone(score: number) {
  return score >= 80 ? 'health-green' : score >= 50 ? 'health-yellow' : 'health-red';
}

function HealthRing({ score }: { score: number }) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(100, Math.max(0, score));
  const offset = circumference * (1 - clamped / 100);
  return (
    <div
      className={cn('health-ring', healthTone(score))}
      role="img"
      aria-label={`Portfolio health ${Math.round(score)} out of 100`}
    >
      <svg className="health-ring-svg" viewBox="0 0 100 100" aria-hidden="true">
        <circle className="health-ring-track" cx="50" cy="50" r={radius} />
        <circle
          className="health-ring-progress"
          cx="50"
          cy="50"
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="health-ring-center">
        <span className="health-ring-value">{Math.round(score)}</span>
        <span className="health-ring-label">HEALTH</span>
      </div>
    </div>
  );
}

function SuggestionCard({ suggestion, index }: { suggestion: Suggestion; index: number }) {
  const isSell = suggestion.type === 'SELL';
  return (
    <div
      className={cn('suggestion-card', isSell ? 'suggestion-sell' : 'suggestion-buy')}
      style={{ animationDelay: `${index * 55}ms` }}
    >
      <span className="suggestion-icon">
        {isSell ? <TrendingDown size={18} /> : <TrendingUp size={18} />}
      </span>
      <div className="suggestion-body">
        <div className="suggestion-head">
          <span className="suggestion-ticker">{suggestion.ticker}</span>
          <span className="suggestion-type">
            {isSell ? 'Cut losses / take profit' : 'Buy opportunity'}
          </span>
        </div>
        <p className="suggestion-reason">{suggestion.reason}</p>
      </div>
      <span className="suggestion-score">{suggestion.score}</span>
    </div>
  );
}

function HoldingRow({
  position,
  assets,
  index,
  onClose,
  onUpdate,
}: {
  position: Position;
  assets: Asset[];
  index: number;
  onClose: (id: string) => void;
  onUpdate: (id: string, updates: Partial<Pick<Position, 'shares' | 'buyPrice'>>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftShares, setDraftShares] = useState(String(position.shares));
  const [draftPrice, setDraftPrice] = useState(String(position.buyPrice));

  const asset = assets.find((a) => a.ticker === position.ticker);
  const livePrice = asset?.current_price;
  const currentPrice =
    typeof livePrice === 'number' && Number.isFinite(livePrice) && livePrice > 0
      ? livePrice
      : position.buyPrice;
  const marketValue = currentPrice * position.shares;
  const pnl = (currentPrice - position.buyPrice) * position.shares;
  const pnlPct =
    position.buyPrice > 0 ? ((currentPrice - position.buyPrice) / position.buyPrice) * 100 : 0;
  const tone = pnl >= 0 ? 'pnl-up' : 'pnl-down';

  function startEdit() {
    setDraftShares(String(position.shares));
    setDraftPrice(String(position.buyPrice));
    setEditing(true);
  }

  function saveEdit() {
    const shares = Number(draftShares);
    const price = Number(draftPrice);
    if (Number.isFinite(shares) && shares >= 0 && Number.isFinite(price) && price >= 0) {
      onUpdate(position.id, { shares, buyPrice: price });
    }
    setEditing(false);
  }

  return (
    <div className="holding" style={{ animationDelay: `${index * 45}ms` }}>
      <button
        type="button"
        className="holding-summary"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <div className="holding-asset">
          <span className="holding-ticker">{position.ticker}</span>
          <span className="holding-name">{asset?.name ?? position.ticker}</span>
        </div>
        <div className="holding-cell holding-cell-secondary">
          <span className="holding-cell-value">{position.shares}</span>
          <span className="holding-cell-label">Shares</span>
        </div>
        <div className="holding-cell holding-cell-secondary">
          <span className="holding-cell-value">{formatPrice(marketValue)}</span>
          <span className="holding-cell-label">Value</span>
        </div>
        <div className="holding-cell">
          <span className={cn('holding-cell-value', tone)}>{formatPnl(pnl)}</span>
          <span className={cn('holding-cell-label', tone)}>{formatSignedPercent(pnlPct)}</span>
        </div>
        <ChevronDown size={18} className={cn('holding-chevron', open && 'is-open')} />
      </button>

      <div className={cn('holding-details', open && 'is-open')}>
        <div className="holding-details-inner">
          <div className="holding-metrics">
            <div className="holding-metric">
              <span className="holding-metric-label">Buy price</span>
              <span className="holding-metric-value">{formatPrice(position.buyPrice)}</span>
            </div>
            <div className="holding-metric">
              <span className="holding-metric-label">Market price</span>
              <span className="holding-metric-value">{formatPrice(currentPrice)}</span>
            </div>
            <div className="holding-metric">
              <span className="holding-metric-label">Invested</span>
              <span className="holding-metric-value">
                {formatPrice(position.buyPrice * position.shares)}
              </span>
            </div>
            <div className="holding-metric">
              <span className="holding-metric-label">Signal</span>
              <span className="holding-metric-value">
                {asset ? calculateSignalScore(asset) : '—'}
              </span>
            </div>
            <div className="holding-metric">
              <span className="holding-metric-label">Date added</span>
              <span className="holding-metric-value">{position.dateAdded}</span>
            </div>
          </div>

          {editing && (
            <div className="holding-edit">
              <label className="holding-edit-field">
                <span className="holding-edit-label">Shares</span>
                <input
                  className="holding-edit-input"
                  type="number"
                  min="0"
                  step="any"
                  value={draftShares}
                  onChange={(e) => setDraftShares(e.target.value)}
                />
              </label>
              <label className="holding-edit-field">
                <span className="holding-edit-label">Buy price</span>
                <input
                  className="holding-edit-input"
                  type="number"
                  min="0"
                  step="any"
                  value={draftPrice}
                  onChange={(e) => setDraftPrice(e.target.value)}
                />
              </label>
              <div className="holding-edit-actions">
                <button
                  type="button"
                  className="holding-action holding-action-primary"
                  onClick={saveEdit}
                >
                  Save
                </button>
                <button type="button" className="holding-action" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className="holding-actions">
            <button
              type="button"
              className="holding-action holding-action-danger"
              onClick={() => onClose(position.id)}
            >
              <Trash2 size={15} /> Close Position
            </button>
            <button type="button" className="holding-action" onClick={startEdit}>
              <Pencil size={15} /> Edit
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function PortfolioDashboard({ assets }: { assets: Asset[] }) {
  const [mode, setMode] = useState<PortfolioMode>('simulation');
  const { positions, removePosition, updatePosition } = usePortfolio();

  const visible = positions.filter((p) =>
    mode === 'simulation' ? p.isSimulation : !p.isSimulation,
  );
  const stats = calculatePortfolioStats(visible, assets);
  const suggestions = generateSuggestions(visible, assets, AVAILABLE_CASH);

  return (
    <section className="portfolio" aria-label="Portfolio dashboard">
      <header className="portfolio-head">
        <div>
          <h2 className="portfolio-title">Wealth Management</h2>
          <p className="portfolio-subtitle">
            Simulate strategies or track live holdings — one engine, zero noise.
          </p>
        </div>
        <Segmented
          value={mode}
          ariaLabel="Portfolio mode"
          onChange={setMode}
          options={[
            { value: 'simulation', label: 'Simulation' },
            { value: 'live', label: 'Live Tracking' },
          ]}
        />
      </header>

      <div className="portfolio-overview">
        <div className="portfolio-overview-glow" aria-hidden="true" />
        <div className="overview-stat">
          <span className="overview-label">Portfolio Value</span>
          <span className="overview-value">{formatPrice(stats.totalValue)}</span>
          <span className="overview-sub">Invested {formatPrice(stats.totalInvested)}</span>
        </div>
        <div className="overview-stat">
          <span className="overview-label">Unrealized P&L</span>
          <span className={cn('overview-value', stats.unrealizedPnL >= 0 ? 'pnl-up' : 'pnl-down')}>
            {formatPnl(stats.unrealizedPnL)}
          </span>
          <span className={cn('overview-sub', stats.unrealizedPnL >= 0 ? 'pnl-up' : 'pnl-down')}>
            {formatSignedPercent(stats.pnlPercent)}
          </span>
        </div>
        <HealthRing score={stats.healthScore} />
      </div>

      <section className="portfolio-section" aria-label="Smart suggestions">
        <div className="portfolio-section-head">
          <h3 className="portfolio-section-title">Smart Suggestions</h3>
          <span className="portfolio-cash">
            <Wallet size={14} /> {formatPrice(AVAILABLE_CASH)} available
          </span>
        </div>
        {suggestions.length > 0 ? (
          <div className="suggestion-list">
            {suggestions.map((suggestion, i) => (
              <SuggestionCard
                key={`${suggestion.type}-${suggestion.ticker}`}
                suggestion={suggestion}
                index={i}
              />
            ))}
          </div>
        ) : (
          <div className="suggestion-empty">
            <CheckCircle2 size={22} />
            <div>
              <span className="suggestion-empty-title">No action needed</span>
              <span className="suggestion-empty-sub">
                Every holding is scoring above the sell threshold and no new buy qualifies yet.
              </span>
            </div>
          </div>
        )}
      </section>

      <section className="portfolio-section" aria-label="Holdings">
        <div className="portfolio-section-head">
          <h3 className="portfolio-section-title">Holdings</h3>
          <span className="portfolio-count">
            {visible.length} POSITION{visible.length === 1 ? '' : 'S'}
          </span>
        </div>
        {visible.length > 0 ? (
          <div className="holdings-list">
            {visible.map((position, i) => (
              <HoldingRow
                key={position.id}
                position={position}
                assets={assets}
                index={i}
                onClose={removePosition}
                onUpdate={updatePosition}
              />
            ))}
          </div>
        ) : (
          <div className="holdings-empty">
            <Briefcase size={26} />
            <span className="holdings-empty-title">
              {mode === 'simulation' ? 'No simulation positions' : 'No live positions yet'}
            </span>
            <span className="holdings-empty-sub">
              {mode === 'simulation'
                ? 'Your paper portfolio is empty. Add a position to start simulating.'
                : 'Connect your broker to start tracking real holdings.'}
            </span>
          </div>
        )}
      </section>
    </section>
  );
}
