import { createContext, useContext } from 'react';
import { useCanonicalScores } from '@/hooks/useCanonicalScores';
import type { Asset } from '@/lib/assets';
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

/** The scanner's assets_status rows, provided by the Workspace. */
export const AssetsStatusContext = createContext<readonly Asset[]>([]);

export interface PaperRisk extends RiskBook {
  /** The risk manager's verdict on a new Paper Trading BUY of `ticker`. */
  checkBuy: (ticker: string, order: EntryOrder) => EntryCheck;
}

/** paper_risk_policy().max_atr_age: two daily market-analytics runs. */
export const MAX_SERVER_ATR_AGE_MS = 48 * 60 * 60 * 1000;

/**
 * The Paper Trading account's risk book, shared by every surface that books a
 * paper BUY. `ticker` preloads the ATR of a symbol about to be bought.
 *
 * Like paper_account_book(), each position is assumed stopped
 * DEFAULT_ATR_STOP_MULTIPLIER × ATR below its entry (Pine's stop). The ATR is
 * the browser's canonical score, else the server's atr_14 while it is under
 * MAX_SERVER_ATR_AGE_MS old (stocks and forex have no browser candles). A
 * ticker with neither risks its whole entry, as on the server.
 * Positions mark at their live tick, else cost basis.
 */
export function usePaperRisk(ticker?: string): PaperRisk {
  const paper = usePortfolio().portfolios.paper_trading;
  const assets = useContext(AssetsStatusContext);
  const scores = useCanonicalScores([
    ...paper.positions.map((position) => position.ticker),
    ...(ticker ? [ticker] : []),
  ]);

  const serverAtr = (symbol: string) => {
    const row = assets.find((asset) => asset.ticker.toUpperCase() === symbol.toUpperCase());
    const age = Date.now() - Date.parse(row?.analytics_updated_at ?? '');
    return age < MAX_SERVER_ATR_AGE_MS ? (row?.atr_14 ?? 0) : 0;
  };
  const atrStop = (symbol: string, entry: number) => {
    const result = scores.get(symbol);
    const atr = result?.status === 'OK' && result.atr > 0 ? result.atr : serverAtr(symbol);
    return atr > 0 ? Math.max(0, entry - DEFAULT_ATR_STOP_MULTIPLIER * atr) : 0;
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
