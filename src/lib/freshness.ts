/**
 * Explicit per-asset data-freshness states (M1-T4, F-3.2b).
 *
 * Every price shown in the app carries one of five states so the UI (and the
 * alert evaluator) can distinguish real-time data from snapshots, stale rows,
 * and illustrative samples:
 *
 *   Live         — a real-time Binance WebSocket tick is overlaid and the
 *                  stream is connected right now.
 *   Delayed      — provider snapshot no older than `FRESHNESS_MAX_AGE_MS`, or
 *                  the last WebSocket tick while the stream is reconnecting.
 *   Stale        — provider snapshot older than the threshold, or undatable.
 *   Unavailable  — no usable price at all.
 *   Simulated    — sample/preview row (`updated_at` is the empty-string marker)
 *                  with no real tick overlaid.
 *
 * Precedence: missing price → real Binance tick (genuine market data even on
 * a sample row) → simulated marker → snapshot age.
 */
export type FreshnessState = 'Live' | 'Delayed' | 'Stale' | 'Unavailable' | 'Simulated';

export const FRESHNESS_STATES: readonly FreshnessState[] = [
  'Live',
  'Delayed',
  'Stale',
  'Unavailable',
  'Simulated',
];

/** Provider snapshots older than 2 hours read as Stale. */
export const FRESHNESS_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** The marker `sampleAssets` writes to `updated_at` (illustrative rows). */
export const SIMULATED_MARKER = '';

export interface FreshnessInput {
  /** `assets_status.updated_at` ISO string; '' marks sample rows. */
  updatedAt: string | null | undefined;
  /** Price actually displayed (live overlay or DB row). */
  price: number | null | undefined;
  /** Whether a real-time WebSocket tick is overlaid on this asset. */
  hasLivePrice: boolean;
  /** Whether the WebSocket stream is currently connected (default true). */
  streamConnected?: boolean;
  /** Clock injection for deterministic tests (default `Date.now()`). */
  now?: number;
}

function isUsablePrice(price: number | null | undefined): price is number {
  return typeof price === 'number' && Number.isFinite(price) && price > 0;
}

/**
 * Classifies the freshness of one asset price. Deterministic and pure — the
 * alert engine refuses to fire on anything worse than `Delayed`, so this
 * function also guards alerts against stale snapshots and simulated samples.
 */
export function classifyFreshness(input: FreshnessInput): FreshnessState {
  if (!isUsablePrice(input.price)) return 'Unavailable';
  if (input.hasLivePrice) return input.streamConnected === false ? 'Delayed' : 'Live';
  if (input.updatedAt === SIMULATED_MARKER) return 'Simulated';

  if (input.updatedAt === null || input.updatedAt === undefined) return 'Stale';
  const parsed = Date.parse(input.updatedAt);
  if (!Number.isFinite(parsed)) return 'Stale';
  const now = input.now ?? Date.now();
  return now - parsed <= FRESHNESS_MAX_AGE_MS ? 'Delayed' : 'Stale';
}

/**
 * Convenience wrapper for an `Asset` row plus its optional live overlay. The
 * live tick (if any) is what gets displayed, so it is what gets classified.
 */
export function assetFreshness(
  asset: { current_price: number | null; updated_at?: string | null },
  live: { price: number } | undefined,
  options: { streamConnected?: boolean; now?: number } = {},
): FreshnessState {
  return classifyFreshness({
    updatedAt: asset.updated_at,
    price: live ? live.price : asset.current_price,
    hasLivePrice: live !== undefined,
    ...options,
  });
}

/** Whether an alert may evaluate against this freshness state (F-5.1d). */
export function isAlertableFreshness(state: FreshnessState): boolean {
  return state === 'Live' || state === 'Delayed';
}
