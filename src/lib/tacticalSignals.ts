import type { TriggeredAlert } from '@/lib/alertsStore';
import type { Asset } from '@/lib/assets';
import type { CanonicalResult, MarketRegime } from '@/lib/canonicalModel';
import type { Position } from '@/lib/portfolioAccounting';

/**
 * Active Research Lab signal advisor (M2-T2): tactical, alpha-seeking ideas
 * from the canonical engine (RSI · MACD · ATR regime). Core
 * Portfolio never calls this — its trades come from `rebalance.ts`.
 */

const TYPE_ORDER = { SELL: 0, BUY: 1 } as const;

export interface TacticalSignal {
  type: 'BUY' | 'SELL';
  ticker: string;
  score: number;
  regime: MarketRegime;
  rationale: string;
  /** Epoch ms of the market snapshot the score came from; null when unknown. */
  asOf: number | null;
}

/** One card in the Lab feed: a Multi-Factor idea or a fired price alert. */
export type SignalFeedItem =
  | { kind: 'quant'; at: number | null; signal: TacticalSignal }
  | { kind: 'alert'; at: number; trigger: TriggeredAlert };

const SELL_BELOW = 50;
const BUY_AT = 85;

/** The quote's time in ms, or null when the feed gave none. */
function quotedAt(updatedAt: string | null | undefined): number | null {
  const time = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  return Number.isFinite(time) ? time : null;
}

/** SELL a weak holding, BUY a strong asset not held, else no signal. */
function signalFor(
  asset: Asset,
  isHeld: boolean,
  result: CanonicalResult | undefined,
): TacticalSignal | null {
  if (result?.status !== 'OK') return null;
  const { signal_score: score, regime, rationale } = result;
  const base = { ticker: asset.ticker, score, regime, rationale, asOf: quotedAt(asset.updated_at) };
  if (isHeld && score < SELL_BELOW) return { type: 'SELL', ...base };
  if (!isHeld && score >= BUY_AT) return { type: 'BUY', ...base };
  return null;
}

/**
 * - SELL: a held asset whose canonical score is below 50.
 * - BUY: a non-held asset scoring 85+ while the ledger has cash to deploy.
 * An asset without a canonical score (loading, or INSUFFICIENT_DATA) yields
 * no signal — missing data is silence, never a SELL.
 */
export function generateTacticalSignals(
  positions: readonly Position[],
  assets: readonly Asset[],
  availableCash: number,
  scores: ReadonlyMap<string, CanonicalResult>,
): TacticalSignal[] {
  const held = new Set(positions.map((position) => position.ticker.toUpperCase()));
  const signals: TacticalSignal[] = [];
  const seen = new Set<string>();

  for (const asset of assets) {
    const ticker = asset.ticker.toUpperCase();
    if (seen.has(ticker)) continue;
    seen.add(ticker);
    const isHeld = held.has(ticker);
    if (!isHeld && availableCash <= 0) continue;
    const signal = signalFor(asset, isHeld, scores.get(asset.ticker));
    if (signal) signals.push(signal);
  }

  // SELLs first (they protect what is held), then the strongest score.
  return signals.sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || b.score - a.score);
}

/**
 * Merges quant signals and fired price alerts into one feed, newest first.
 * The sort is stable, so same-snapshot quant signals keep their SELL-first,
 * score-ranked order; undated signals sink to the bottom.
 */
export function buildSignalFeed(
  signals: readonly TacticalSignal[],
  triggered: readonly TriggeredAlert[],
): SignalFeedItem[] {
  const items: SignalFeedItem[] = [
    ...signals.map((signal) => ({ kind: 'quant' as const, at: signal.asOf, signal })),
    ...triggered.map((trigger) => ({ kind: 'alert' as const, at: trigger.triggeredAt, trigger })),
  ];
  return items.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}
