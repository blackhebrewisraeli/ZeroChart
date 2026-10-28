import type { Database } from '@/integrations/supabase/types';

/**
 * Decision & Execution Journal (docs/DECISION_JOURNAL.md): what the database
 * recorded about each TradingView signal and the paper fill linked to it.
 * Pure: it labels stored rows and never fills in a fact that wasn't stored.
 */

type SignalRow = Database['public']['Tables']['trading_signals']['Row'];
type FillRow = Database['public']['Tables']['paper_transactions']['Row'];
type DismissalRow = Database['public']['Tables']['trading_signal_dismissals']['Row'];

export type JournalFill = Pick<
  FillRow,
  'id' | 'action' | 'ticker' | 'quantity' | 'price' | 'fees' | 'created_at'
>;

/** What dismiss_tactical_signal recorded (20261028120000). Earlier dismissals have none. */
export type JournalDismissal = Pick<DismissalRow, 'dismissed_at' | 'reason'>;

/** The reasons trading_signal_dismissals accepts, in menu order. */
export const DISMISSAL_REASONS = {
  price_moved: 'Price moved',
  too_risky: 'Too risky',
  stale: 'Signal is stale',
  disagree: 'Disagree with the signal',
  other: 'Other',
} as const;

export type DismissalReason = keyof typeof DISMISSAL_REASONS;

export function dismissalReasonLabel(reason: string | null): string {
  if (reason === null) return 'No reason provided';
  return reason in DISMISSAL_REASONS ? DISMISSAL_REASONS[reason as DismissalReason] : reason;
}

/** A signal row as the journal reads it: named columns plus its linked fills and dismissal. */
export type JournalSignal = Pick<
  SignalRow,
  | 'id'
  | 'ticker'
  | 'action'
  | 'signal_kind'
  | 'signal_score'
  | 'quantity'
  | 'stop_loss'
  | 'price'
  | 'status'
  | 'event_id'
  | 'exchange'
  | 'timeframe'
  | 'bar_time'
  | 'model_version'
  | 'created_at'
> & {
  paper_transactions: JournalFill[];
  /** One-to-one through its primary key `signal_id`, so an object or null. */
  trading_signal_dismissals: JournalDismissal | null;
};

export type RecordedStatus = 'PENDING' | 'EXECUTED' | 'DISMISSED';

export type JournalState = 'awaiting' | 'dismissed' | 'executed' | 'unresolved' | 'inconsistent';

export const JOURNAL_STATES: readonly JournalState[] = [
  'awaiting',
  'dismissed',
  'executed',
  'unresolved',
  'inconsistent',
];

export const STATE_LABELS: Record<JournalState, string> = {
  awaiting: 'Awaiting user action',
  dismissed: 'Dismissed',
  executed: 'Executed',
  unresolved: 'Outcome unresolved',
  inconsistent: 'Evidence inconsistent',
};

/** Keyset position after the last row read: newest receipt first, then id. */
export interface JournalCursor {
  createdAt: string;
  id: string;
}

export interface ExecutionComparison {
  signalPrice: number | null;
  fillPrice: number | null;
  /**
   * Signal-to-fill price change, (fill − signal) ÷ signal × 100. It includes
   * the market's move and the owner's delay, so it is not execution slippage.
   */
  priceChangePct: number | null;
  /** Fill booking time minus server receipt time. */
  elapsedMs: number | null;
  fees: number;
}

export interface JournalEntry {
  signal: JournalSignal;
  state: JournalState;
  /** Why the state is unresolved or inconsistent, one finding per line. */
  notes: string[];
  fill: JournalFill | null;
  /** Exchange, timeframe, bar time and model were all recorded. */
  provenanceComplete: boolean;
  comparison: ExecutionComparison | null;
}

/** The asset part of a ticker, as execute_tactical_signal matches it. */
const compact = (ticker: string) => ticker.toUpperCase().replaceAll(/[^A-Z0-9]/g, '');

/** execute_tactical_signal books BTCUSDT and BTCUSD signals under BTC-USD. */
function sameAsset(signalTicker: string, fillTicker: string): boolean {
  const signal = compact(signalTicker);
  const fill = compact(fillTicker);
  return signal === fill || signal.replace(/USDT$/, 'USD') === fill;
}

function compare(signal: JournalSignal, fill: JournalFill): ExecutionComparison {
  const signalPrice = signal.price;
  const fillPrice = fill.price;
  const elapsedMs = Date.parse(fill.created_at) - Date.parse(signal.created_at);
  return {
    signalPrice,
    fillPrice,
    priceChangePct:
      signalPrice && fillPrice ? ((fillPrice - signalPrice) / signalPrice) * 100 : null,
    elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : null,
    fees: fill.fees,
  };
}

/** What the linked fills and dismissal record contradict, if anything. */
function evidenceFindings(signal: JournalSignal): string[] {
  const fills = signal.paper_transactions;
  const [fill] = fills;
  const findings: string[] = [];
  if (signal.trading_signal_dismissals && signal.status !== 'DISMISSED') {
    findings.push(`A dismissal is recorded, but the signal is recorded as ${signal.status}.`);
  }
  if (!fill) {
    if (signal.status === 'EXECUTED') {
      findings.push(
        'Recorded as executed, but no fill is linked to it. Signals executed before 2026-10-22 ' +
          '(migration 20261022090000) booked their fill without a link, so it may be in the ' +
          'Trade Ledger unlinked.',
      );
    }
    return findings;
  }
  if (fills.length > 1) findings.push(`${fills.length} fills are linked; execution books one.`);
  if (signal.status !== 'EXECUTED') {
    findings.push(`A fill is linked, but the signal is recorded as ${signal.status}.`);
  }
  if (fill.action !== signal.action) {
    findings.push(`The linked fill is a ${fill.action}; the signal is a ${signal.action}.`);
  }
  if (fill.quantity !== signal.quantity) {
    findings.push(`The linked fill's quantity differs from the signal's.`);
  }
  if (fill.ticker && !sameAsset(signal.ticker, fill.ticker)) {
    findings.push(`The linked fill booked ${fill.ticker}, not ${signal.ticker}.`);
  }
  if (Date.parse(fill.created_at) < Date.parse(signal.created_at)) {
    findings.push('The linked fill booked before the signal was received.');
  }
  return findings;
}

export function journalEntry(signal: JournalSignal): JournalEntry {
  const fill = signal.paper_transactions[0] ?? null;
  const notes = evidenceFindings(signal);
  let state: JournalState;
  if (notes.length > 0) state = 'inconsistent';
  else if (signal.status === 'EXECUTED') state = 'executed';
  else if (signal.status === 'DISMISSED') state = 'dismissed';
  else if (signal.signal_kind === 'strategy') state = 'awaiting';
  else {
    // ActionCenter lists strategy signals only, so nothing in the app acts on these.
    state = 'unresolved';
    notes.push(
      signal.signal_kind === 'transport_test'
        ? 'Transport test: a delivery check that is never executable. The app offers no action on it.'
        : 'No signal kind was recorded (a legacy alert), so it is never executable. The app offers no action on it.',
    );
  }
  return {
    signal,
    state,
    notes,
    fill,
    provenanceComplete: Boolean(
      signal.exchange && signal.timeframe && signal.bar_time && signal.model_version,
    ),
    comparison: fill ? compare(signal, fill) : null,
  };
}

export interface JournalSummary {
  loaded: number;
  states: Record<JournalState, number>;
  provenanceIncomplete: number;
}

export function summarizeJournal(entries: readonly JournalEntry[]): JournalSummary {
  const states = Object.fromEntries(JOURNAL_STATES.map((state) => [state, 0])) as Record<
    JournalState,
    number
  >;
  for (const entry of entries) states[entry.state] += 1;
  return {
    loaded: entries.length,
    states,
    provenanceIncomplete: entries.filter((entry) => !entry.provenanceComplete).length,
  };
}

/**
 * The asset filter as a ticker fragment. Tickers only use A–Z, 0–9 and ". = -"
 * (trading_signals_ticker_check), so nothing left can act as a LIKE wildcard.
 */
export function tickerQuery(text: string): string {
  return text.toUpperCase().replaceAll(/[^A-Z0-9.=-]/g, '');
}

/** "45s", "4m 05s", "2h 07m", "3d 4h". */
export function formatElapsed(ms: number): string {
  if (ms < 0) return `−${formatElapsed(-ms)}`;
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const pad = (value: number) => String(value).padStart(2, '0');
  if (seconds < 60) return `${seconds}s`;
  if (minutes < 60) return `${minutes}m ${pad(seconds % 60)}s`;
  if (hours < 24) return `${hours}h ${pad(minutes % 60)}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
