import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { toast } from 'sonner';
import { FEE_RATE } from '@/components/TradeTicket';
import { formatPrice, type Asset } from '@/lib/assets';
import {
  executePaperPortfolio,
  loadPaperTransactions,
  PortfolioChangedError,
  PortfolioRejectedError,
  type PortfolioHolding,
  type PortfolioReceipt,
} from '@/lib/db';
import { applyBuyTransaction } from '@/lib/portfolioAccounting';
import type { Allocation, RiskProfile } from '@/lib/portfolioBuilder';
import { usePortfolio } from '@/lib/portfolioStore';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A booking without `dryRun`: enough to ask the server about it again. */
type BookingRequest = Pick<
  Parameters<typeof executePaperPortfolio>[0],
  'requestId' | 'riskProfile' | 'budget' | 'holdings'
>;

// Bookings still waiting on an answer, per user. Kept in localStorage so a
// closed dialog or a reloaded page can still settle them by request ID.
const UNSETTLED_KEY = 'zerochart:unsettled-portfolio-requests:';
// Requests this page is waiting on right now, across remounts of the dialog.
const inFlight = new Set<string>();

function unsettled(user: string): BookingRequest[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(UNSETTLED_KEY + user) ?? '[]');
    return Array.isArray(stored) ? (stored as BookingRequest[]) : [];
  } catch {
    return [];
  }
}

function setUnsettled(user: string, requests: BookingRequest[]) {
  try {
    if (requests.length > 0) localStorage.setItem(UNSETTLED_KEY + user, JSON.stringify(requests));
    else localStorage.removeItem(UNSETTLED_KEY + user);
  } catch {
    // No storage: recovery then lasts only as long as the dialog stays open.
  }
}

const remember = (user: string, request: BookingRequest) =>
  setUnsettled(user, [
    ...unsettled(user).filter((r) => r.requestId !== request.requestId),
    request,
  ]);
const settled = (user: string, requestId: string) =>
  setUnsettled(
    user,
    unsettled(user).filter((r) => r.requestId !== requestId),
  );

const notBooked = () =>
  toast.info('An earlier Quant Analyzer request was not booked', {
    description: 'The server has no record of it, so no Paper Cash was spent.',
  });

/**
 * Settles a booking that a closed dialog or a reloaded page left unanswered. A
 * dry run under its request ID returns the receipt when it committed, waiting
 * on the account lock first if it is still committing; it never books.
 */
async function recover(
  user: string,
  request: BookingRequest,
  replacePaperLedger: ReturnType<typeof usePortfolio>['replacePaperLedger'],
) {
  inFlight.add(request.requestId);
  try {
    const found = await executePaperPortfolio({ ...request, dryRun: true });
    settled(user, request.requestId);
    if (found.status !== 'executed') {
      notBooked();
      return;
    }
    const count = found.orders.length;
    toast.success(
      `Your earlier Quant Analyzer request booked ${count} ${count === 1 ? 'order' : 'orders'}`,
      {
        description: `Receipt ${found.request_id.slice(0, 8)}: ${formatPrice(found.spent)} spent from Paper Cash.`,
      },
    );
    replacePaperLedger(await loadPaperTransactions(user));
  } catch (error) {
    // The replay check runs before any validation, so a refusal means no batch has this ID.
    if (error instanceof PortfolioRejectedError) {
      settled(user, request.requestId);
      notBooked();
    }
    // Otherwise the server is still unreachable: it stays stored for the next check.
  } finally {
    inFlight.delete(request.requestId);
  }
}

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
  // Bumped to price the same proposal again: after Confirm found it had moved,
  // or when the owner asks for fresh prices.
  const [repriced, setRepriced] = useState(0);
  // The plan on screen before the latest reprice, to show the owner what moved.
  const [priorPlan, setPriorPlan] = useState<PortfolioReceipt | null>(null);
  const executingRef = useRef(false);

  // A new proposal starts clean: new request ID, no plan, nothing booked.
  // Reset while rendering, not in an effect: an effect can run after a Confirm
  // clicked the moment the results appear, and would erase its outcome.
  const [proposalFor, setProposalFor] = useState(result);
  if (proposalFor !== result) {
    setProposalFor(result);
    setRequestId(crypto.randomUUID());
    setServerPlan(null);
    setServerError(null);
    setPriorPlan(null);
    setExecution({ state: 'idle' });
  }

  // Signed in, the server prices the proposal: the quantities, fees and cash
  // shown are the ones Confirm will book.
  useEffect(() => {
    if (phase !== 'results' || !result || result.length === 0 || userId === null) return;
    let live = true;
    executePaperPortfolio({
      requestId,
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
  }, [phase, result, budget, riskProfile, userId, requestId, repriced]);

  // The first render and every new proposal settle any booking an earlier
  // dialog or page left unanswered, by that booking's own request ID.
  useEffect(() => {
    if (userId === null) return;
    for (const request of unsettled(userId)) {
      if (request.requestId !== requestId && !inFlight.has(request.requestId)) {
        void recover(userId, request, replacePaperLedger);
      }
    }
  }, [userId, requestId, replacePaperLedger]);

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
    settled(account, receipt.request_id);
    setExecution({ state: 'completed', receipt });
    try {
      replacePaperLedger(await loadPaperTransactions(account));
    } catch {
      toast.warning('Orders booked; Paper Trading is still syncing');
    }
  }

  /** After a lost response: asks the server whether this request ID booked. */
  async function reconcile(account: string, request: BookingRequest) {
    setExecution({ state: 'uncertain', checking: true });
    try {
      const found = await executePaperPortfolio({ ...request, dryRun: true });
      if (found.status === 'executed') {
        await settle(found, account);
      } else {
        settled(account, request.requestId);
        setExecution({
          state: 'failed',
          reason:
            'The server has no record of this request, so nothing was booked. Trying again is safe: one request can only book once.',
        });
      }
    } catch (error) {
      if (error instanceof PortfolioRejectedError) {
        settled(account, request.requestId);
        setExecution({ state: 'failed', reason: error.message });
      } else {
        setExecution({ state: 'uncertain', checking: false });
      }
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
      const request = { requestId, riskProfile, budget, holdings: toHoldings(result) };
      // Stored before sending, so a lost answer stays recoverable after this dialog.
      remember(userId, request);
      inFlight.add(requestId);
      setExecution({ state: 'pending' });
      try {
        const receipt = await executePaperPortfolio({
          ...request,
          dryRun: false,
          // Book what the preview showed, or nothing.
          expected: serverPlan.orders.map(({ ticker, price, quantity }) => ({
            ticker,
            price,
            quantity,
          })),
        });
        await settle(receipt, userId);
      } catch (error) {
        if (error instanceof PortfolioChangedError) {
          // Nothing booked: show the plan as it prices now and wait for a fresh Confirm.
          settled(userId, requestId);
          setPriorPlan(serverPlan);
          setServerPlan(null);
          setRepriced((n) => n + 1);
          setExecution({ state: 'failed', reason: error.message });
        } else if (error instanceof PortfolioRejectedError) {
          settled(userId, requestId);
          setExecution({ state: 'failed', reason: error.message });
        } else {
          await reconcile(userId, request);
        }
      } finally {
        inFlight.delete(requestId);
      }
    } finally {
      executingRef.current = false;
    }
  }

  const checkAgain =
    userId !== null && result && execution.state === 'uncertain' && !execution.checking
      ? () =>
          void reconcile(userId, { requestId, riskProfile, budget, holdings: toHoldings(result) })
      : null;

  // Signed in and not booked, the same proposal (budget, profile, holdings and
  // request ID) can be priced again, e.g. once a stale quote refreshes. It is a
  // dry run, so it books nothing, and Confirm waits for its plan. Never while a
  // booking is out or unresolved: reconciling that request ID comes first.
  const canReprice = userId !== null && execution.state !== 'completed';
  const repriceReady = canReprice && !busy && (serverPlan !== null || serverError !== null);
  function reprice() {
    if (!repriceReady || executingRef.current) return;
    if (serverPlan) setPriorPlan(serverPlan);
    setServerPlan(null);
    setServerError(null);
    if (execution.state === 'failed') setExecution({ state: 'idle' });
    setRepriced((n) => n + 1);
  }

  return {
    plan,
    planError,
    // A receipt is what booked: nothing to compare it with.
    priorPlan: execution.state === 'completed' ? null : priorPlan,
    execution,
    busy,
    confirm,
    checkAgain,
    reprice: canReprice ? reprice : null,
    repriceReady,
  };
}
