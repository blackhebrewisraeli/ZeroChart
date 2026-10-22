import { useMemo, useState } from 'react';
import { Activity, Download, Minus, Plus, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { useAlerts } from '@/lib/alertsStore';
import { formatPnl, formatPrice, formatSignedPercent, pnlTone, type Asset } from '@/lib/assets';
import { PAPER_STARTING_CASH, usePortfolio, type PaperOrder } from '@/lib/portfolioStore';
import {
  computePortfolioValuation,
  positionCostBasis,
  type Position,
} from '@/lib/portfolioAccounting';
import { buildSignalFeed, generateTacticalSignals } from '@/lib/tacticalSignals';
import {
  downloadCsv,
  executionDrag,
  realizedPnlOn,
  tradeLedgerCsv,
  tradeStats,
} from '@/lib/tradeLedger';
import { mergeLivePrices, useLivePrices } from '@/lib/livePriceStore';
import { formatShares, MAX_PORTFOLIO_RISK_PERCENT } from '@/lib/risk';
import { ActionCenter } from '@/components/ActionCenter';
import { AssetChart } from '@/components/AssetChart';
import { AssetIcon } from '@/components/AssetIcon';
import { TacticalSignals } from '@/components/TacticalSignals';
import { TradeLedger } from '@/components/PortfolioDashboard';
import { FEE_RATE, TradeTicket } from '@/components/TradeTicket';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { usePaperRisk } from '@/hooks/usePaperRisk';
import { usePriceFlash } from '@/hooks/usePriceFlash';
import { useCanonicalScores } from '@/hooks/useCanonicalScores';
import { cn } from '@/lib/utils';

/** Share of the open position one +/− click adds or trims. */
const SIZE_STEP = 0.25;
const LEDGER_FILENAME = 'zerochart-ledger-paper.csv';

function Stat({
  label,
  value,
  sub,
  tone,
  primary = false,
}: Readonly<{
  label: string;
  value: string;
  sub: string;
  tone?: 'pnl-up' | 'pnl-down' | undefined;
  primary?: boolean;
}>) {
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
  onSelect,
  onResize,
  onClose,
  addRejection,
}: Readonly<{
  position: Position;
  asset: Asset | undefined;
  onSelect: (ticker: string) => void;
  onResize: (position: Position, price: number, side: 'buy' | 'sell') => void;
  onClose: (position: Position, price: number) => void;
  /** Why the risk manager refuses a +25% add at `price`, or null. */
  addRejection: (position: Position, price: number) => string | null;
}>) {
  const price = asset?.current_price;
  const hasPrice = typeof price === 'number' && Number.isFinite(price) && price > 0;
  const priceFlash = usePriceFlash(hasPrice ? price : null);
  const costBasis = positionCostBasis(position);
  const pnl = hasPrice ? price * position.shares - costBasis : null;
  const noPrice = hasPrice ? undefined : 'No live price to fill at yet';
  const addBlocked = hasPrice ? addRejection(position, price) : null;

  return (
    <tr>
      <td>
        <button
          type="button"
          className="paper-ticker"
          aria-label={`Chart ${position.ticker}`}
          onClick={() => onSelect(position.ticker)}
        >
          <AssetIcon symbol={position.ticker} name={asset?.name ?? null} size="sm" />
          {position.ticker}
        </button>
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
          <button
            type="button"
            className="paper-size"
            aria-label={`Trim ${position.ticker} by 25%`}
            title={noPrice ?? 'Sell 25% of this position'}
            disabled={!hasPrice}
            onClick={() => hasPrice && onResize(position, price, 'sell')}
          >
            <Minus size={13} />
          </button>
          <button
            type="button"
            className="paper-size"
            aria-label={`Add 25% to ${position.ticker}`}
            title={noPrice ?? addBlocked ?? 'Buy 25% more of this position'}
            disabled={!hasPrice || addBlocked !== null}
            onClick={() => hasPrice && onResize(position, price, 'buy')}
          >
            <Plus size={13} />
          </button>
          <button
            type="button"
            className="paper-close"
            aria-label={`Close ${position.ticker} position`}
            disabled={!hasPrice}
            title={noPrice}
            onClick={() => hasPrice && onClose(position, price)}
          >
            Close
          </button>
        </span>
      </td>
    </tr>
  );
}

/** Top-up input and a confirmed reset, scoped to the Paper Trading ledger. */
function PaperAccountControls() {
  const { portfolios, topUpPaperCash, resetPaperAccount } = usePortfolio();
  const [amount, setAmount] = useState('10000');
  const paper = portfolios.paper_trading;

  async function topUp() {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      toast.error('Enter an amount greater than $0.');
      return;
    }
    const result = await topUpPaperCash(value);
    if (!result.ok) {
      toast.error(result.error ?? 'Top-up rejected');
      return;
    }
    toast.success(`Added ${formatPrice(value)} paper cash`);
  }

  async function reset() {
    const result = await resetPaperAccount();
    if (!result.ok) {
      toast.error(result.error ?? 'Reset rejected');
      return;
    }
    toast.success('Paper account reset', {
      description: `${formatPrice(PAPER_STARTING_CASH)} paper cash, no positions, empty ledger.`,
    });
  }

  return (
    <div className="portfolio-cash-controls paper-account" aria-label="Paper account">
      <input
        className="portfolio-cash-input"
        type="number"
        min="0"
        step="any"
        inputMode="decimal"
        aria-label="Top-up amount"
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
      />
      <button type="button" className="portfolio-cash-btn" onClick={() => void topUp()}>
        <Plus size={13} /> Top Up
      </button>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <button type="button" className="portfolio-cash-btn">
            <RotateCcw size={13} /> Reset
          </button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset paper account?</AlertDialogTitle>
            <AlertDialogDescription>
              Clears {paper.positions.length} open{' '}
              {paper.positions.length === 1 ? 'position' : 'positions'} and{' '}
              {paper.transactions.length} ledger{' '}
              {paper.transactions.length === 1 ? 'entry' : 'entries'}, and restores{' '}
              {formatPrice(PAPER_STARTING_CASH)} of paper cash. Your simulated portfolio and tracked
              holdings are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void reset()}>
              Reset to {formatPrice(PAPER_STARTING_CASH)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Paper Desk (M2-T3): chart, positions, fills and the tactical feed for the
 * `paper_trading` ledger only. Every fill here is a simulated tactical trade;
 * the Core Simulation and Live Tracking ledgers never see it.
 */
export function PaperTradingTerminal({ assets: baseAssets }: Readonly<{ assets: Asset[] }>) {
  const { portfolios, executePaperTrade } = usePortfolio();
  const risk = usePaperRisk();
  const { triggered } = useAlerts();
  const livePrices = useLivePrices();
  const assets = useMemo(() => mergeLivePrices(baseAssets, livePrices), [baseAssets, livePrices]);
  const assetByTicker = new Map(assets.map((asset) => [asset.ticker.toUpperCase(), asset]));
  const scores = useCanonicalScores(assets.map((asset) => asset.ticker));
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<'positions' | 'ledger'>('positions');

  const paper = portfolios.paper_trading;
  const valuation = computePortfolioValuation(
    paper,
    Object.fromEntries([...assetByTicker].map(([ticker, asset]) => [ticker, asset.current_price])),
  );
  const now = new Date();
  const fills = paper.transactions.filter(
    (transaction) => transaction.type === 'buy' || transaction.type === 'sell',
  );
  const fillsToday = fills.filter(
    (transaction) => new Date(transaction.timestamp).toDateString() === now.toDateString(),
  ).length;
  const { closes, wins } = tradeStats(paper.transactions);
  const todayRealized = realizedPnlOn(paper.transactions, now);
  const drag = executionDrag(paper.transactions);
  const openCount = paper.positions.length;
  const openRiskPct = risk.equity > 0 ? risk.openRisk / risk.equity : 0;

  // The chart follows the last pick, else the first open position, else the
  // feed's top card (same ranking as <TacticalSignals>) if it is a listed
  // asset (a fired alert may not be), else the first asset.
  const [topItem] = buildSignalFeed(
    generateTacticalSignals(paper.positions, assets, paper.cashBalance, scores),
    triggered,
  );
  const topSignal =
    topItem?.kind === 'alert' ? topItem.trigger.alert.ticker : topItem?.signal.ticker;
  const topAsset = topSignal ? assetByTicker.get(topSignal.toUpperCase()) : undefined;
  const ticker = selected ?? paper.positions[0]?.ticker ?? topAsset?.ticker ?? assets[0]?.ticker;
  const chartAsset = ticker ? assetByTicker.get(ticker.toUpperCase()) : undefined;

  const order = (
    side: PaperOrder['side'],
    position: Position,
    shares: number,
    price: number,
  ): PaperOrder => ({
    side,
    ticker: position.ticker,
    shares,
    price,
    fee: shares * price * FEE_RATE,
  });

  function addRejection(position: Position, price: number) {
    const shares = position.shares * SIZE_STEP;
    const check = risk.checkBuy(position.ticker, {
      shares,
      price,
      fee: shares * price * FEE_RATE,
    });
    return check.ok ? null : check.reason;
  }

  async function resizePosition(position: Position, price: number, side: 'buy' | 'sell') {
    const shares = position.shares * SIZE_STEP;
    const result = await executePaperTrade(order(side, position, shares, price));
    if (!result.ok) {
      toast.error(result.error ?? 'Order rejected');
      return;
    }
    toast.success(`${side === 'buy' ? 'Added to' : 'Trimmed'} ${position.ticker}`, {
      description: `${formatShares(shares)} at ${formatPrice(price)} — simulated fill in your Paper Trading ledger.`,
    });
  }

  async function closePosition(position: Position, price: number) {
    const result = await executePaperTrade(order('sell', position, position.shares, price));
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
            <span className="paper-eyebrow-dot" aria-hidden="true" /> Simulation Mode · No real
            money
          </span>
          <h2 className="portfolio-title">Paper Desk</h2>
          <p className="portfolio-subtitle">
            Act on tactical signals with simulated fills at the live price. Paper cash only.
          </p>
        </div>
        <PaperAccountControls />
      </header>

      <ActionCenter assets={assets} />

      <section className="paper-pnl" aria-label="Paper telemetry">
        <Stat
          label="Paper Cash"
          value={formatPrice(paper.cashBalance)}
          sub={`Equity ${formatPrice(valuation.totalEquity)}`}
        />
        <Stat
          primary
          label="Open Unrealized P&L"
          value={formatPnl(valuation.unrealizedPnl)}
          sub={`${formatSignedPercent(valuation.unrealizedPnlPct)} · ${openCount} open`}
          tone={pnlTone(valuation.unrealizedPnl)}
        />
        <Stat
          primary
          label="Aggregate Open Risk"
          value={`${(openRiskPct * 100).toFixed(1)}%`}
          sub={`${formatPrice(risk.openRisk)} to stops · ${MAX_PORTFOLIO_RISK_PERCENT * 100}% cap`}
          tone={openRiskPct >= MAX_PORTFOLIO_RISK_PERCENT ? 'pnl-down' : undefined}
        />
        <Stat
          primary
          label="Session Realized P&L"
          value={formatPnl(todayRealized)}
          sub={`${fillsToday} ${fillsToday === 1 ? 'fill' : 'fills'} today · FIFO lots`}
          tone={pnlTone(todayRealized)}
        />
        <Stat
          label="Execution Drag"
          value={formatPrice(drag)}
          sub={`Fees + slippage · ${fills.length} ${fills.length === 1 ? 'fill' : 'fills'}`}
        />
        <Stat
          label="Win Rate"
          value={closes > 0 ? `${Math.round((wins / closes) * 100)}%` : '—'}
          sub={`${wins} of ${closes} ${closes === 1 ? 'close' : 'closes'}`}
        />
      </section>

      <div className="paper-grid">
        <div className="paper-main">
          <section className="portfolio-section paper-chart" aria-label="Paper chart">
            <div className="portfolio-section-head">
              <h3 className="portfolio-section-title">Chart</h3>
              <select
                className="portfolio-cash-input paper-symbol"
                aria-label="Chart symbol"
                value={ticker ?? ''}
                onChange={(event) => setSelected(event.target.value)}
              >
                {assets.map((asset) => (
                  <option key={asset.ticker} value={asset.ticker}>
                    {asset.ticker}
                  </option>
                ))}
              </select>
            </div>
            {ticker && <AssetChart key={ticker} ticker={ticker} quantHeight={300} />}
          </section>

          <section
            className="portfolio-section analytics-workspace"
            aria-label="Positions and fills"
          >
            <div className="analytics-workspace-tabs">
              <button
                type="button"
                className={cn('analytics-workspace-tab', tab === 'positions' && 'is-active')}
                aria-pressed={tab === 'positions'}
                onClick={() => setTab('positions')}
              >
                Open Positions ({openCount})
              </button>
              <button
                type="button"
                className={cn('analytics-workspace-tab', tab === 'ledger' && 'is-active')}
                aria-pressed={tab === 'ledger'}
                onClick={() => setTab('ledger')}
              >
                Trade Ledger ({paper.transactions.length})
              </button>
              <span className="portfolio-count analytics-entry-count">
                REALIZED {formatPnl(paper.realizedPnl)}
              </span>
              <button
                type="button"
                className="portfolio-cash-btn ledger-export analytics-export"
                disabled={paper.transactions.length === 0}
                onClick={() => downloadCsv(LEDGER_FILENAME, tradeLedgerCsv(paper.transactions))}
              >
                <Download size={13} /> Export CSV
              </button>
            </div>
            <div className="analytics-workspace-panel">
              {tab === 'ledger' ? (
                <TradeLedger
                  embedded
                  title="Paper Trade Ledger"
                  transactions={paper.transactions}
                  filename={LEDGER_FILENAME}
                />
              ) : openCount > 0 ? (
                <div className="ledger-scroll" role="region" aria-label="Open positions">
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
                          onSelect={setSelected}
                          onResize={resizePosition}
                          onClose={closePosition}
                          addRejection={addRejection}
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
                    Act on a tactical signal or place a quick order. Fills book here against{' '}
                    {formatPrice(paper.cashBalance)} of paper cash.
                  </span>
                </div>
              )}
            </div>
          </section>
        </div>

        <div className="paper-side">
          {chartAsset && (
            <section className="portfolio-section paper-order" aria-label="Quick order">
              <div className="portfolio-section-head">
                <h3 className="portfolio-section-title">Quick Order</h3>
                <span className="portfolio-count">Paper Trading ledger</span>
              </div>
              <div className="paper-order-body">
                <span className="paper-ticker">
                  <AssetIcon symbol={chartAsset.ticker} name={chartAsset.name} size="sm" />
                  {chartAsset.ticker}
                </span>
                <span className="paper-order-price">{formatPrice(chartAsset.current_price)}</span>
                <TradeTicket
                  asset={chartAsset}
                  portfolioType="paper_trading"
                  intent="tactical"
                  label={`Trade ${chartAsset.ticker}`}
                />
              </div>
            </section>
          )}
          <TacticalSignals assets={assets} onSelect={setSelected} selectedTicker={ticker} />
        </div>
      </div>
    </section>
  );
}
