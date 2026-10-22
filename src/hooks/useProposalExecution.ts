import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { toast } from 'sonner';
import { FEE_RATE } from '@/components/TradeTicket';
import type { Asset } from '@/lib/assets';
import {
  executePaperPortfolio,
  loadPaperTransactions,
  PortfolioRejectedError,
  type PortfolioHolding,
  type PortfolioReceipt,
} from '@/lib/db';
import { applyBuyTransaction } from '@/lib/portfolioAccounting';
import type { Allocation, RiskProfile } from '@/lib/portfolioBuilder';
import { usePortfolio } from '@/lib/portfolioStore';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Where booking the shown proposal stands. `uncertain` means the request may
 * have committed (the connection dropped): it is reconciled by request ID
 * before anything else can be tried.
 */
export type Execution =
  | { state: 'idle' }
  | { state: 'pending' }
  | { state: 'failed'; reason: string }
  | { state: 'uncertain'; checking: boolean }
  | { state: 'completed'; receipt: PortfolioReceipt };

/** What the server needs from a proposal: it prices and sizes each holding itself. */
function toHoldings(result: Allocation[]): PortfolioHolding[] {
  return result.map((allocation) => ({
    ticker: allocation.ticker,
    amount: allocation.allocatedAmount,
    score: allocation.score ?? null,
  }));
}

/**
 * A signed-out proposal priced in the browser, the way the guest ledger books
 * it: live price, ATR suggested shares capped at the allocation. It has no
 * server risk book, so its risk fields are NaN and stay hidden.
 */
function guestPlan(
  result: Allocation[],
  assetByTicker: ReadonlyMap<string, Asset>,
  cash: number,
  budget: number,
  requestId: string,
): PortfolioReceipt {
  const orders = result.flatMap((allocation) => {
    const price = assetByTicker.get(allocation.ticker)?.current_price;
    const atrLimit = allocation.suggestedShares;
    if (!price || !Number.isFinite(price) || price <= 0 || !atrLimit || atrLimit <= 0) return [];
    const budgetShares = allocation.allocatedAmount / (price * (1 + FEE_RATE));
    const quantity = Math.floor(Math.min(atrLimit, budgetShares) * 1e8) / 1e8;
    if (quantity <= 0) return [];
    const fees = quantity * price * FEE_RATE;
    return [
      {
        ticker: allocation.ticker,
        quantity,
        price,
        fees,
        cost: quantity * price + fees,
        stop_price: Number.NaN,
        atr: Number.NaN,
        planned_risk: Number.NaN,
      },
    ];
  });
  if (orders.length === 0) {
    throw new PortfolioRejectedError(
      'No holding has a live price and an ATR-sized quantity to buy right now.',
    );
  }
  const spent = orders.reduce((sum, order) => sum + order.cost, 0);
  return {
    request_id: requestId,
    status: 'planned',
    replayed: false,
    policy_version: 'browser',
    risk_profile: '',
    budget,
    cash_before: cash,
    spent,
    fees: orders.reduce((sum, order) => sum + order.fees, 0),
    cash_after: cash - spent,
    equity: Number.NaN,
    open_risk_before: Number.NaN,
    planned_risk: Number.NaN,
    max_open_risk: Number.NaN,
    orders,
    executed_at: null,
  };
}

export interface ProposalInput {
  phase: 'config' | 'results';
  result: Allocation[] | null;
  budget: number;
  riskProfile: RiskProfile;
  assetByTicker: ReadonlyMap<string, Asset>;
  /** Set while the Quant Analyzer is closing: Confirm does nothing then. */
  closingRef: RefObject<boolean>;
}

/**
 * Prices the shown Quant Analyzer proposal and books it. Signed in, the server
 * plans and books it in one transaction under one request ID; signed out, the
 * browser ledger books it all or nothing.
 */
export function useProposalExecution({
  phase,
  result,
  budget,
  riskProfile,
  assetByTicker,
  closingRef,
}: ProposalInput) {
  const {
    executePaperTrade,
    getPortfolio,
    replacePaperLedger,
    scopeUserId: userId,
  } = usePortfolio();
  // One request ID per proposal, shared by its preview and every retry, so the
  // server books it at most once however often Confirm reaches it.
  const [requestId, setRequestId] = useState('');
  const [serverPlan, setServerPlan] = useState<PortfolioReceipt | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [execution, setExecution] = useState<Execution>({ state: 'idle' });
  const executingRef = useRef(false);

  // A new proposal gets a new request ID and, signed in, a server price check:
  // the quantities, fees and cash shown are the ones Confirm will book.
  useEffect(() => {
    if (phase !== 'results' || !result || result.length === 0) return;
    const id = crypto.randomUUID();
    setRequestId(id);
    setServerPlan(null);
    setServerError(null);
    setExecution({ state: 'idle' });
    if (userId === null) return;
    let live = true;
    executePaperPortfolio({
      requestId: id,
      riskProfile,
      budget,
      holdings: toHoldings(result),
      dryRun: true,
    })
      .then((priced) => {
        if (live) setServerPlan(priced);
      })
      .catch((error: unknown) => {
        if (live) setServerError(errorMessage(error));
      });
    return () => {
      live = false;
    };
  }, [phase, result, budget, riskProfile, userId]);

  const guest = useMemo(() => {
    if (userId !== null || !result || result.length === 0) return null;
    try {
      const cash = getPortfolio('paper_trading').cashBalance;
      return { plan: guestPlan(result, assetByTicker, cash, budget, requestId), error: null };
    } catch (error) {
      return { plan: null, error: errorMessage(error) };
    }
  }, [userId, result, assetByTicker, getPortfolio, budget, requestId]);

  let plan = userId === null ? guest?.plan : serverPlan;
  if (execution.state === 'completed') plan = execution.receipt;
  const planError = userId === null ? (guest?.error ?? null) : serverError;
  const busy = execution.state === 'pending' || execution.state === 'uncertain';

  async function settle(receipt: PortfolioReceipt, account: string) {
    setExecution({ state: 'completed', receipt });
    try {
      replacePaperLedger(await loadPaperTransactions(account));
    } catch {
      toast.warning('Orders booked; Paper Trading is still syncing');
    }
  }

  /** After a lost response: asks the server whether this request ID booked. */
  async function reconcile(account: string) {
    if (!result) return;
    setExecution({ state: 'uncertain', checking: true });
    try {
      const found = await executePaperPortfolio({
        requestId,
        riskProfile,
        budget,
        holdings: toHoldings(result),
        dryRun: true,
      });
      if (found.status === 'executed') {
        await settle(found, account);
      } else {
        setExecution({
          state: 'failed',
          reason:
            'The server has no record of this request, so nothing was booked. Trying again is safe: one request can only book once.',
        });
      }
    } catch (error) {
      setExecution(
        error instanceof PortfolioRejectedError
          ? { state: 'failed', reason: error.message }
          : { state: 'uncertain', checking: false },
      );
    }
  }

  /** Signed out there is no server ledger: book the browser plan, all or nothing. */
  async function investAsGuest(guestOrders: PortfolioReceipt) {
    const timestamp = new Date().toISOString();
    const orders = guestOrders.orders.map((order) => {
      const name = assetByTicker.get(order.ticker)?.name;
      return {
        side: 'buy' as const,
        ticker: order.ticker,
        ...(name ? { name } : {}),
        shares: order.quantity,
        price: order.price,
        fee: order.fees,
      };
    });
    // Check the whole batch against the account before booking its first row.
    let preview = getPortfolio('paper_trading');
    for (const order of orders) {
      const bought = applyBuyTransaction(preview, { ...order, timestamp });
      if (!bought.ok) {
        setExecution({ state: 'failed', reason: bought.error });
        return;
      }
      preview = bought.container;
    }
    for (const order of orders) {
      const booked = await executePaperTrade(order);
      if (!booked.ok) {
        setExecution({ state: 'failed', reason: booked.error ?? 'Order rejected' });
        return;
      }
    }
    setExecution({
      state: 'completed',
      receipt: { ...guestOrders, status: 'executed', executed_at: timestamp },
    });
  }

  async function confirm() {
    // A second click (or Enter) while a request is out must not send another.
    if (executingRef.current || closingRef.current || !result || result.length === 0) return;
    if (busy || execution.state === 'completed') return;
    executingRef.current = true;
    try {
      if (userId === null) {
        if (guest?.plan) await investAsGuest(guest.plan);
        return;
      }
      if (!serverPlan) return;
      setExecution({ state: 'pending' });
      try {
        const receipt = await executePaperPortfolio({
          requestId,
          riskProfile,
          budget,
          holdings: toHoldings(result),
          dryRun: false,
        });
        await settle(receipt, userId);
      } catch (error) {
        if (error instanceof PortfolioRejectedError) {
          setExecution({ state: 'failed', reason: error.message });
        } else {
          await reconcile(userId);
        }
      }
    } finally {
      executingRef.current = false;
    }
  }

  const checkAgain =
    userId !== null && execution.state === 'uncertain' && !execution.checking
      ? () => void reconcile(userId)
      : null;
  return { plan, planError, execution, busy, confirm, checkAgain };
}
