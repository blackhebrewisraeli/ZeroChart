import { useCanonicalScores } from '@/hooks/useCanonicalScores';
import { getLivePrice } from '@/lib/livePriceStore';
import { computePortfolioValuation } from '@/lib/portfolioAccounting';
import { usePortfolio } from '@/lib/portfolioStore';
import {
  aggregateOpenRisk,
  checkNewEntry,
  DEFAULT_ATR_STOP_MULTIPLIER,
  type EntryCheck,
  type EntryOrder,
  type RiskBook,
} from '@/lib/risk';
import { toBinanceSymbol } from '@/lib/ticker';

export interface PaperRisk extends RiskBook {
  /** The risk manager's verdict on a new Paper Trading BUY of `ticker`. */
  checkBuy: (ticker: string, order: EntryOrder) => EntryCheck;
}

/**
 * The Paper Trading account's risk book, shared by every surface that books a
 * paper BUY. `ticker` preloads the ATR of a symbol about to be bought.
 *
 * ponytail: paper fills store no stop, so each position is assumed stopped
 * DEFAULT_ATR_STOP_MULTIPLIER × today's ATR below its entry (Pine's stop) and a
 * ticker whose ATR hasn't loaded risks its whole entry. Persist the signal's
 * stop_loss on the fill if per-trade stops ever need to diverge from that.
 * Positions mark at their live tick, else cost basis.
 */
export function usePaperRisk(ticker?: string): PaperRisk {
  const paper = usePortfolio().portfolios.paper_trading;
  const scores = useCanonicalScores([
    ...paper.positions.map((position) => position.ticker),
    ...(ticker ? [ticker] : []),
  ]);

  const atrStop = (symbol: string, entry: number) => {
    const result = scores.get(symbol);
    return result?.status === 'OK' && result.atr > 0
      ? Math.max(0, entry - DEFAULT_ATR_STOP_MULTIPLIER * result.atr)
      : 0;
  };

  const marks = Object.fromEntries(
    paper.positions.map((position) => {
      const symbol = toBinanceSymbol(position.ticker);
      return [position.ticker.trim().toUpperCase(), symbol ? getLivePrice(symbol)?.price : null];
    }),
  );
  const book: RiskBook = {
    equity: computePortfolioValuation(paper, marks).totalEquity,
    cash: paper.cashBalance,
    openRisk: aggregateOpenRisk(
      paper.positions.map((position) => ({
        shares: position.shares,
        buyPrice: position.buyPrice,
        stopPrice: atrStop(position.ticker, position.buyPrice),
      })),
    ),
  };

  return {
    ...book,
    checkBuy: (symbol, order) =>
      checkNewEntry(book, { ...order, stopPrice: order.stopPrice ?? atrStop(symbol, order.price) }),
  };
}
