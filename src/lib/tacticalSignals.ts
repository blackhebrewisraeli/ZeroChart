import type { TriggeredAlert } from '@/lib/alertsStore';
import type { Asset } from '@/lib/assets';
import type { CanonicalResult, MarketRegime } from '@/lib/canonicalModel';
import type { Position } from '@/lib/portfolioAccounting';

/**
 * Active Research Lab signal advisor (M2-T2): tactical, alpha-seeking ideas
 * from the canonical engine (RSI · MACD · ATR regime). Core
 * Portfolio never calls this — its trades come from `rebalance.ts`.
 */

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
    const result = scores.get(asset.ticker);
    if (result?.status !== 'OK') continue;
    const { signal_score: score, regime, rationale } = result;
    const updatedAt = asset.updated_at ? Date.parse(asset.updated_at) : Number.NaN;
    const asOf = Number.isFinite(updatedAt) ? updatedAt : null;
    const base = { ticker: asset.ticker, score, regime, rationale, asOf };
    if (isHeld && score < SELL_BELOW) signals.push({ type: 'SELL', ...base });
    else if (!isHeld && score >= BUY_AT) signals.push({ type: 'BUY', ...base });
  }

  return signals.sort((a, b) =>
    a.type === b.type ? b.score - a.score : a.type === 'SELL' ? -1 : 1,
  );
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
