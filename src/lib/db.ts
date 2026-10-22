import type { Position } from '@/lib/portfolioManager';
import type { PaperLedgerRow } from '@/lib/portfolioAccounting';
import type { PortfolioPersistedState, PortfolioStateV3 } from '@/lib/portfolioStore';
import { isCloudWriteAllowed } from '@/lib/hydrationStore';
import { supabase } from '@/lib/supabaseClient';
import type { Json } from '@/integrations/supabase/types';

/**
 * Thrown when a cloud write is attempted before the signed-in user's cloud
 * portfolio finished hydrating (M1-T1, F-4.1b). Callers surface this as a
 * transient "still syncing" state rather than a generic failure.
 */
export class PortfolioNotHydratedError extends Error {
  constructor(userId: string) {
    super(
      `Cloud portfolio for user ${userId} has not finished hydrating; refusing write to prevent cross-account overwrite.`,
    );
    this.name = 'PortfolioNotHydratedError';
  }
}

/**
 * Persists the user's portfolio as a single JSONB row. The table has a unique
 * constraint on `user_id`, so repeated saves upsert (update) the same row.
 *
 * Guarded by the hydration barrier (M1-T1, F-4.1b): the write is rejected
 * while this user's `loadPortfolio` is still in flight, so a slow hydration
 * can never be clobbered by (or clobber) another session's state.
 */
type PortfolioCloudPayload = PortfolioPersistedState;

async function savePortfolioPayload(userId: string, payload: unknown): Promise<void> {
  if (!isCloudWriteAllowed(userId)) throw new PortfolioNotHydratedError(userId);

  const { error } = await supabase.from('user_portfolios').upsert(
    {
      user_id: userId,
      // `Position` is an interface, so it has no implicit index signature to
      // satisfy the recursive `Json` type — one documented cast at the
      // persistence boundary (values are plain string/number/booleans).
      positions: payload as unknown as Json,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );

  if (error) throw error;
}

export async function savePortfolio(userId: string, positions: Position[]): Promise<void> {
  await savePortfolioPayload(userId, positions);
}

/**
 * Persists the v3 envelope's Core ledgers. Paper Trading is not part of the
 * snapshot: every paper fill is its own `paper_transactions` row.
 */
export async function savePortfolioStateV3(userId: string, state: PortfolioStateV3): Promise<void> {
  const { real_tracking, long_term_sim } = state.portfolios;
  await savePortfolioPayload(userId, { ...state, portfolios: { real_tracking, long_term_sim } });
}

async function loadPortfolioPayload(userId: string): Promise<unknown> {
  const { data, error } = await supabase
    .from('user_portfolios')
    .select('positions')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return data?.positions ?? null;
}

/**
 * Fetches the user's saved portfolio, or `null` when they have not saved one
 * yet (an explicit empty `[]` row comes back as `[]`, distinct from `null`).
 * Row Level Security restricts the query to the caller's own row.
 */
export async function loadPortfolio(userId: string): Promise<PortfolioCloudPayload | null> {
  const payload = await loadPortfolioPayload(userId);
  if (Array.isArray(payload)) return payload as unknown as Position[];
  if (payload === null || typeof payload !== 'object') return null;
  if ('version' in payload && payload.version === 3 && 'portfolios' in payload) {
    return payload as unknown as PortfolioStateV3;
  }
  if ('positions' in payload && Array.isArray(payload.positions)) {
    return payload as unknown as PortfolioCloudPayload;
  }
  return null;
}

/**
 * Loads either the legacy position array or the v3 multi-portfolio envelope.
 * Shape normalization and v1/v2 migration remain owned by `portfolioStore`.
 */
export async function loadPortfolioState(userId: string): Promise<PortfolioCloudPayload | null> {
  return loadPortfolio(userId);
}

/** A row as the client books it; id, user_id and created_at are server-set. */
export type PaperTransactionInsert = Pick<
  PaperLedgerRow,
  'action' | 'ticker' | 'quantity' | 'price' | 'fees'
>;

// Supabase's default max-rows; a shorter page means the ledger is exhausted.
const PAPER_PAGE_SIZE = 1000;

/** The user's Paper Trading ledger, oldest first. RLS limits it to their own rows. */
export async function loadPaperTransactions(userId: string): Promise<PaperLedgerRow[]> {
  const rows: PaperLedgerRow[] = [];
  for (let from = 0; ; from += PAPER_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('paper_transactions')
      .select('id, action, ticker, quantity, price, fees, created_at')
      .eq('user_id', userId)
      .order('created_at')
      .order('id')
      .range(from, from + PAPER_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < PAPER_PAGE_SIZE) return rows;
  }
}

/** Appends one row; the insert trigger rejects a fill the account can't cover. */
export async function insertPaperTransaction(row: PaperTransactionInsert): Promise<void> {
  const { error } = await supabase.from('paper_transactions').insert(row);
  if (error) throw new Error(error.message);
}

/** One holding of a Portfolio Builder proposal; the server picks price and quantity. */
export interface PortfolioHolding {
  ticker: string;
  /** Dollars for this holding, fees included. */
  amount: number;
  /** The client engine's Signal Score, checked against the profile's minimum. */
  score: number | null;
}

/** One buy as execute_paper_portfolio priced it. */
export interface PortfolioOrder {
  ticker: string;
  quantity: number;
  price: number;
  fees: number;
  cost: number;
  /** Planned stop the quantity was sized against; no stop order is placed. */
  stop_price: number;
  atr: number;
  planned_risk: number;
}

/** The server's plan (`planned`) or its receipt for a booked proposal (`executed`). */
export interface PortfolioReceipt {
  request_id: string;
  status: 'planned' | 'executed';
  /** True when an earlier request with this ID already booked it. */
  replayed: boolean;
  policy_version: string;
  risk_profile: string;
  budget: number;
  cash_before: number;
  spent: number;
  fees: number;
  cash_after: number;
  equity: number;
  open_risk_before: number;
  planned_risk: number;
  max_open_risk: number;
  orders: PortfolioOrder[];
  executed_at: string | null;
}

/** The server answered and refused: its transaction rolled back, so nothing was booked. */
export class PortfolioRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortfolioRejectedError';
  }
}

// A SQLSTATE or PostgREST code means Postgres answered; anything else (a
// dropped connection, a gateway timeout) leaves the outcome unknown.
const SERVER_ERROR_CODE = /^([0-9A-Z]{5}|PGRST\d+)$/;

/**
 * Prices a proposal (`dryRun`) or books all of it in one transaction. A retry
 * with the same requestId never books twice: it returns the first receipt, and
 * a dry run with an executed requestId does too, which is how a caller
 * reconciles a response it lost. Throws PortfolioRejectedError when the server
 * refused, and a plain Error when the outcome is unknown.
 */
export async function executePaperPortfolio(proposal: {
  requestId: string;
  riskProfile: string;
  budget: number;
  holdings: PortfolioHolding[];
  dryRun: boolean;
}): Promise<PortfolioReceipt> {
  const { data, error } = await supabase.rpc('execute_paper_portfolio', {
    request_id: proposal.requestId,
    risk_profile: proposal.riskProfile,
    budget: proposal.budget,
    holdings: proposal.holdings as unknown as Json,
    dry_run: proposal.dryRun,
  });
  if (error) {
    throw SERVER_ERROR_CODE.test(error.code)
      ? new PortfolioRejectedError(error.message)
      : new Error(error.message);
  }
  return data as unknown as PortfolioReceipt;
}

/**
 * Whether the user's `user_subscriptions` row grants Pro. Only the service role
 * writes that table, so this is the one entitlement source the client trusts.
 */
export async function loadIsPro(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('user_subscriptions')
    .select('status, tier')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.status === 'active' && data.tier === 'pro';
}
