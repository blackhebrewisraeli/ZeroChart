import { useMemo } from 'react';
import { Activity } from 'lucide-react';
import { toast } from 'sonner';
import { formatPnl, formatPrice, formatSignedPercent, pnlTone, type Asset } from '@/lib/assets';
import { usePortfolio } from '@/lib/portfolioStore';
import {
  computePortfolioValuation,
  positionCostBasis,
  type Position,
} from '@/lib/portfolioAccounting';
import { realizedPnlOn } from '@/lib/tradeLedger';
import { mergeLivePrices, useLivePrices } from '@/lib/livePriceStore';
import { formatShares } from '@/lib/risk';
import { AssetIcon } from '@/components/AssetIcon';
import { TacticalSignals } from '@/components/TacticalSignals';
import { TradeLedger } from '@/components/PortfolioDashboard';
import { FEE_RATE, TradeTicket } from '@/components/TradeTicket';
import { usePriceFlash } from '@/hooks/usePriceFlash';
import { cn } from '@/lib/utils';

function Stat({
  label,
  value,
  sub,
  tone,
  primary = false,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: 'pnl-up' | 'pnl-down' | undefined;
  primary?: boolean;
}) {
  return (
    <div role="group" aria-label={label} className={cn('paper-stat', primary && 'is-primary')}>
      <span className="paper-stat-label">{label}</span>
      <span className={cn('paper-stat-value', tone)}>{value}</span>
      <span className={cn('paper-stat-sub', tone)}>{sub}</span>
    </div>
  );
}

function PositionRow({
  position,
  asset,
  onClose,
}: {
  position: Position;
  asset: Asset | undefined;
  onClose: (position: Position, price: number) => void;
}) {
  const price = asset?.current_price;
  const hasPrice = typeof price === 'number' && Number.isFinite(price) && price > 0;
  const priceFlash = usePriceFlash(hasPrice ? price : null);
  const costBasis = positionCostBasis(position);
  const pnl = hasPrice ? price * position.shares - costBasis : null;

  return (
    <tr>
      <td>
        <span className="paper-ticker">
          <AssetIcon symbol={position.ticker} name={asset?.name ?? null} size="sm" />
          {position.ticker}
        </span>
      </td>
      <td>{formatShares(position.shares)}</td>
      <td>{formatPrice(position.buyPrice)}</td>
      <td className={priceFlash}>{hasPrice ? formatPrice(price) : '—'}</td>
      <td>{hasPrice ? formatPrice(price * position.shares) : '—'}</td>
      <td className={pnl === null ? undefined : pnlTone(pnl)}>
        {pnl === null
          ? '—'
          : `${formatPnl(pnl)} · ${formatSignedPercent(costBasis > 0 ? (pnl / costBasis) * 100 : 0)}`}
      </td>
      <td>
        <span className="paper-row-actions">
          {asset && <TradeTicket asset={asset} portfolioType="paper_trading" intent="tactical" />}
          <button
            type="button"
            className="paper-close"
            aria-label={`Close ${position.ticker} position`}
            disabled={!hasPrice}
            title={hasPrice ? undefined : 'No live price to close at yet'}
            onClick={() => hasPrice && onClose(position, price)}
          >
            Close
          </button>
        </span>
      </td>
    </tr>
  );
}

/**
 * Active trader workspace (M2-T3): signals, open positions and fills for the
 * `paper_trading` ledger only. Every fill here is a simulated tactical trade;
 * the Core Simulation and Live Tracking ledgers never see it.
 */
export function PaperTradingTerminal({ assets: baseAssets }: { assets: Asset[] }) {
  const { portfolios, executeSell } = usePortfolio();
  const livePrices = useLivePrices();
  const assets = useMemo(() => mergeLivePrices(baseAssets, livePrices), [baseAssets, livePrices]);
  const assetByTicker = new Map(assets.map((asset) => [asset.ticker.toUpperCase(), asset]));

  const paper = portfolios.paper_trading;
  const valuation = computePortfolioValuation(
    paper,
    Object.fromEntries([...assetByTicker].map(([ticker, asset]) => [ticker, asset.current_price])),
  );
  const now = new Date();
  const todayRealized = realizedPnlOn(paper.transactions, now);
  const fillsToday = paper.transactions.filter(
    (transaction) =>
      (transaction.type === 'buy' || transaction.type === 'sell') &&
      new Date(transaction.timestamp).toDateString() === now.toDateString(),
  ).length;
  const openCount = paper.positions.length;

  function closePosition(position: Position, price: number) {
    const result = executeSell('paper_trading', {
      ticker: position.ticker,
      shares: position.shares,
      price,
      fee: position.shares * price * FEE_RATE,
      timestamp: new Date().toISOString(),
      intent: 'tactical',
    });
    if (!result.ok) {
      toast.error(result.error ?? 'Close rejected');
      return;
    }
    toast.success(`Closed ${position.ticker}`, {
      description: `Realized ${formatPnl(result.realizedPnl ?? 0)} — simulated fill, recorded in your Paper Trading ledger.`,
    });
  }

  return (
    <section className="paper" aria-label="Paper trading terminal">
      <header className="portfolio-head">
        <div>
          <span className="paper-eyebrow">
            <span className="paper-eyebrow-dot" aria-hidden="true" /> Paper · Simulated fills
          </span>
          <h2 className="portfolio-title">Paper Trading Terminal</h2>
          <p className="portfolio-subtitle">
            Act on tactical signals at the live price. Isolated from your Core portfolio.
          </p>
        </div>
      </header>

      <section className="paper-pnl" aria-label="Paper P&L">
        <Stat
          primary
          label="Today's Realized P&L"
          value={formatPnl(todayRealized)}
          sub={`${fillsToday} ${fillsToday === 1 ? 'fill' : 'fills'} today · FIFO lots`}
          tone={pnlTone(todayRealized)}
        />
        <Stat
          primary
          label="Open Unrealized P&L"
          value={formatPnl(valuation.unrealizedPnl)}
          sub={`${formatSignedPercent(valuation.unrealizedPnlPct)} · net of fees`}
          tone={pnlTone(valuation.unrealizedPnl)}
        />
        <Stat label="Buying Power" value={formatPrice(paper.cashBalance)} sub="Paper cash" />
        <Stat
          label="Equity"
          value={formatPrice(valuation.totalEquity)}
          sub={`${openCount} open ${openCount === 1 ? 'position' : 'positions'}`}
        />
      </section>

      <div className="paper-grid">
        <div className="paper-main">
          <section className="portfolio-section" aria-label="Open positions">
            <div className="portfolio-section-head">
              <h3 className="portfolio-section-title">Open Positions</h3>
              <span className="portfolio-count">
                {openCount} OPEN · REALIZED {formatPnl(paper.realizedPnl)}
              </span>
            </div>
            {openCount > 0 ? (
              <div className="ledger-scroll">
                <table className="ledger-table paper-positions">
                  <thead>
                    <tr>
                      <th scope="col">Ticker</th>
                      <th scope="col">Qty</th>
                      <th scope="col">Avg Price</th>
                      <th scope="col">Last</th>
                      <th scope="col">Value</th>
                      <th scope="col">Unrealized P&amp;L</th>
                      <th scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {paper.positions.map((position) => (
                      <PositionRow
                        key={position.id}
                        position={position}
                        asset={assetByTicker.get(position.ticker.toUpperCase())}
                        onClose={closePosition}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="holdings-empty">
                <Activity size={26} />
                <span className="holdings-empty-title">No open paper positions</span>
                <span className="holdings-empty-sub">
                  Act on a tactical signal, or trade the top signal from the Scanner. Fills book
                  here against {formatPrice(paper.cashBalance)} of paper buying power.
                </span>
              </div>
            )}
          </section>

          <TradeLedger
            transactions={paper.transactions}
            filename="zerochart-ledger-paper.csv"
            title="Recent Fills"
            defaultOpen
          />
        </div>
        <div className="paper-side">
          <TacticalSignals assets={assets} />
        </div>
      </div>
    </section>
  );
}
