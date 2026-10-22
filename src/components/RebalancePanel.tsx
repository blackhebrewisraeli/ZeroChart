import { useState } from 'react';
import { Scale } from 'lucide-react';
import { formatPrice, type Asset } from '@/lib/assets';
import { usePortfolio, type PortfolioType } from '@/lib/portfolioStore';
import { REBALANCE_BAND, computeRebalancePlan } from '@/lib/rebalance';
import { FEE_RATE, TradeTicket } from '@/components/TradeTicket';

const percent = (weight: number) => `${(weight * 100).toFixed(1)}%`;
const points = (drift: number) => {
  const value = Number((drift * 100).toFixed(1));
  return `${value > 0 ? '+' : ''}${value.toFixed(1)} pts`;
};
const BAND_POINTS = REBALANCE_BAND * 100;

/**
 * Core Portfolio rebalancing (M2-T2): target weights in, drift and the trades
 * that restore them out. Passive — no quant signal reaches this panel.
 */
export function RebalancePanel({
  portfolioType,
  assets,
}: Readonly<{
  portfolioType: PortfolioType;
  assets: Asset[];
}>) {
  const { portfolios, setTargetAllocations } = usePortfolio();
  const portfolio = portfolios[portfolioType];
  const targets = portfolio.targetAllocations ?? {};
  const hasTargets = Object.keys(targets).length > 0;
  const [draft, setDraft] = useState<Record<string, string> | null>(null);

  const assetByTicker = new Map(assets.map((asset) => [asset.ticker.toUpperCase(), asset]));
  const prices = new Map<string, number>();
  for (const [ticker, asset] of assetByTicker) {
    const price = asset.current_price;
    if (price !== null && Number.isFinite(price) && price > 0) prices.set(ticker, price);
  }
  const plan = computeRebalancePlan(portfolio.positions, targets, prices, portfolio.cashBalance);
  const tradeByTicker = new Map(plan.trades.map((trade) => [trade.ticker, trade]));
  // A buy can spend only the cash on hand, fee included; sells run first to free it.
  const affordable = Math.floor((Math.max(portfolio.cashBalance, 0) / (1 + FEE_RATE)) * 100) / 100;

  const draftValues = draft ? Object.values(draft).map(Number) : [];
  const draftTotal = draftValues.reduce((sum, value) => sum + value, 0);
  const draftValid =
    draftValues.every((value) => Number.isFinite(value) && value >= 0) && draftTotal > 0;

  function startEditing() {
    // Existing targets, or today's holdings weights (cash aside) as the starting point.
    const holdingsValue = plan.rows.reduce((sum, row) => sum + row.value, 0);
    const start = (row: (typeof plan.rows)[number]) =>
      hasTargets ? row.targetWeight : holdingsValue > 0 ? row.value / holdingsValue : 0;
    setDraft(
      Object.fromEntries(plan.rows.map((row) => [row.ticker, (start(row) * 100).toFixed(1)])),
    );
  }

  function saveTargets() {
    if (!draft || !draftValid) return;
    setTargetAllocations(
      portfolioType,
      Object.fromEntries(
        Object.entries(draft).map(([ticker, value]) => [ticker, Number(value) / draftTotal]),
      ),
    );
    setDraft(null);
  }

  if (draft) {
    return (
      <div className="rebalance-editor">
        {Object.entries(draft).map(([ticker, value]) => (
          <label key={ticker} className="rebalance-editor-row">
            <span className="rebalance-ticker">{ticker}</span>
            <input
              className="portfolio-cash-input"
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              aria-label={`${ticker} target %`}
              value={value}
              onChange={(event) => setDraft({ ...draft, [ticker]: event.target.value })}
            />
            <span className="rebalance-unit">%</span>
          </label>
        ))}
        <div className="rebalance-editor-foot">
          <span className="rebalance-status">
            Total {Number.isFinite(draftTotal) ? draftTotal.toFixed(1) : '—'}%
            {draftValid && Math.abs(draftTotal - 100) > 0.05 && ' · saved scaled to 100%'}
          </span>
          <button type="button" className="portfolio-cash-btn" onClick={() => setDraft(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="portfolio-cash-btn"
            disabled={!draftValid}
            onClick={saveTargets}
          >
            Save targets
          </button>
        </div>
      </div>
    );
  }

  if (!hasTargets) {
    return (
      <div className="suggestion-empty rebalance-empty">
        <span className="rebalance-scale-icon">
          <Scale size={20} />
        </span>
        <div>
          <span className="suggestion-empty-title">No target allocation yet</span>
          <span className="suggestion-empty-sub">
            Set target weights and ZeroChart suggests trades whenever a holding drifts more than{' '}
            {BAND_POINTS} pts from its target.
          </span>
        </div>
        <button
          type="button"
          className="portfolio-cash-btn"
          disabled={plan.rows.length === 0}
          onClick={startEditing}
        >
          Set targets
        </button>
      </div>
    );
  }

  return (
    <div className="rebalance">
      <div className="rebalance-head">
        <span className="rebalance-status" data-breached={plan.breached}>
          {plan.breached
            ? `Drift is past the ${BAND_POINTS}-pt band — these trades restore your targets (sells first).`
            : `Within the ${BAND_POINTS}-pt band — no rebalance needed.`}
        </span>
        <button type="button" className="portfolio-cash-btn" onClick={startEditing}>
          Edit targets
        </button>
      </div>
      <div className="ledger-scroll">
        <table className="ledger-table rebalance-table">
          <thead>
            <tr>
              <th scope="col">Ticker</th>
              <th scope="col">Actual</th>
              <th scope="col">Target</th>
              <th scope="col">Drift</th>
              <th scope="col">Rebalance</th>
            </tr>
          </thead>
          <tbody>
            {plan.rows.map((row) => {
              const trade = tradeByTicker.get(row.ticker);
              const asset = assetByTicker.get(row.ticker);
              const amount =
                trade?.side === 'buy' ? Math.min(trade.amount, affordable) : (trade?.amount ?? 0);
              return (
                <tr key={row.ticker}>
                  <td>{row.ticker}</td>
                  <td>{percent(row.actualWeight)}</td>
                  <td>{percent(row.targetWeight)}</td>
                  <td
                    className={
                      Math.abs(row.drift) > REBALANCE_BAND ? 'rebalance-drift-out' : undefined
                    }
                  >
                    {points(row.drift)}
                  </td>
                  <td>
                    {trade && asset && amount >= 1 ? (
                      <TradeTicket
                        asset={asset}
                        portfolioType={portfolioType}
                        intent="rebalance"
                        initialSide={trade.side}
                        initialAmount={amount}
                        label={`${trade.side === 'buy' ? 'Buy' : 'Sell'} ${formatPrice(amount)}`}
                      />
                    ) : trade ? (
                      'Needs cash'
                    ) : plan.breached && !row.priced ? (
                      'No live price'
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              );
            })}
            <tr>
              <td>Cash</td>
              <td>{percent(plan.cashWeight)}</td>
              <td>{percent(0)}</td>
              <td className={plan.cashWeight > REBALANCE_BAND ? 'rebalance-drift-out' : undefined}>
                {points(plan.cashWeight)}
              </td>
              <td>—</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
