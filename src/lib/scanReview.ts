/**
 * Reviewing a Markets scan: which recorded results a view shows, why a result
 * meets or misses the model's setup conditions, and whether the scan still
 * passes its own freshness rule now. Pure and deterministic: every sentence is
 * derived from values the scan recorded. Nothing is re-scored, and no
 * threshold, weight or ranking rule is defined here.
 */
import {
  FLAT_MOMENTUM,
  LONG_SETUP_MIN_SCORE,
  momentumBias,
  REGIME_HIGH_VOLATILITY,
  REGIME_LABELS,
  REGIME_TRENDING_MOMENTUM,
  RISK_SETUP_MAX_SCORE,
  RSI_OVERBOUGHT,
  RSI_OVERSOLD,
  type CanonicalScore,
  type FactorInputs,
  type MarketRegime,
  type ModelSetups,
} from '@/lib/canonicalModel';
import { SCAN_MAX_DATA_AGE_MS, type ScanAssetResult, type ScanCohort } from '@/lib/marketScanner';
import type { RiskProfile } from '@/lib/portfolioBuilder';
import { TRADINGVIEW_DEV_PROVIDER_ID, type TradingViewDevSource } from '@/lib/tradingViewDevScan';
import type { TickerKind } from '@/lib/ticker';
import { latestFinalSession, tradingSessions } from '@/lib/usEquityDaily';

export const CLASS_LABEL: Record<TickerKind, string> = {
  crypto: 'Crypto',
  equity: 'Equities & ETFs',
  forex: 'Forex',
};

export const PROVIDER_LABEL: Record<string, string> = {
  'binance-spot-klines': 'Binance spot klines',
  [TRADINGVIEW_DEV_PROVIDER_ID]: 'TradingView MCP get_ohlcv',
};

export const UTC_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const UTC_DAY = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'short',
});
const NEW_YORK_DAY = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/New_York',
  day: 'numeric',
  month: 'short',
});
/** YYYY-MM-DD in New York: the session a close time belongs to. */
const NEW_YORK_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** "+0.21%": two decimals, since the flat-momentum band is ±0.05%. */
export function percent(fraction: number): string {
  const value = Number((fraction * 100).toFixed(2)) || 0;
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

/** "2.10%": an unsigned share of price. */
export function ratio(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}

/** "3h 05m" between two instants. */
export function ageLabel(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`;
}

/** "sessions to 27 Oct close (New York)" for equities, "candles to 27 Oct close (UTC)" for crypto days. */
export function dataAsOfLabel(cohort: Pick<ScanCohort, 'assetClass' | 'dataAsOf'>): string | null {
  const newest = cohort.dataAsOf.newest;
  if (newest === null) return null;
  return cohort.assetClass === 'equity'
    ? `sessions to ${NEW_YORK_DAY.format(newest)} close (New York)`
    : `candles to ${UTC_DAY.format(newest)} close (UTC)`;
}

/** The last session or candle one result rests on: "27 Oct session (New York)". */
export function resultAsOfLabel(result: Pick<ScanAssetResult, 'assetClass' | 'dataAsOf'>): string {
  if (result.dataAsOf === null) return 'Not recorded';
  return result.assetClass === 'equity'
    ? `${NEW_YORK_DAY.format(result.dataAsOf)} session (New York)`
    : `${UTC_DAY.format(result.dataAsOf)} candle (UTC)`;
}

export type ScanView = 'long' | 'risk' | 'all';

export interface ScanFilters {
  /** Ticker, scanned instrument or requested symbol, case-insensitive. */
  query: string;
  regime: MarketRegime | 'any';
  /** The model's own momentum bias (±0.05% of price is flat). */
  momentum: 'Bullish' | 'Flat' | 'Bearish' | 'any';
  /** Recorded risk-profile fit; 'none' is an asset that fits no profile. */
  profile: RiskProfile | 'none' | 'any';
}

export const NO_FILTERS: ScanFilters = {
  query: '',
  regime: 'any',
  momentum: 'any',
  profile: 'any',
};

export function filtersActive(filters: ScanFilters): boolean {
  return (
    filters.query.trim() !== '' ||
    filters.regime !== 'any' ||
    filters.momentum !== 'any' ||
    filters.profile !== 'any'
  );
}

/** One cohort's evaluated results in rank order, narrowed to a view. */
export function viewResults(
  results: readonly ScanAssetResult[],
  assetClass: TickerKind,
  view: ScanView,
): ScanAssetResult[] {
  return results.filter(
    (result) =>
      result.status === 'EVALUATED' &&
      result.assetClass === assetClass &&
      (view === 'all' || result.setups?.[view] === true),
  );
}

/** Whether an evaluated result passes the filters. Unevaluated results never do. */
export function matchesFilters(
  result: ScanAssetResult,
  filters: ScanFilters,
  symbol?: string,
): boolean {
  const { model } = result;
  if (!model) return false;
  const query = filters.query.trim().toUpperCase();
  if (
    query &&
    ![result.ticker, result.instrument, symbol].some((v) => v?.toUpperCase().includes(query))
  )
    return false;
  if (filters.regime !== 'any' && model.regime !== filters.regime) return false;
  if (filters.momentum !== 'any' && momentumBias(model.inputs.momentumPercent) !== filters.momentum)
    return false;
  if (filters.profile === 'any') return true;
  const fits = Object.values(result.riskProfiles ?? {}).some(Boolean);
  return filters.profile === 'none' ? !fits : result.riskProfiles?.[filters.profile] === true;
}

/** The three factors in display order, with how each raw reading is shown. */
export const QUANT_FACTORS = [
  {
    label: 'Mean Reversion',
    source: 'RSI',
    score: 'rsiScore',
    weight: 'rsi',
    reading: (inputs: FactorInputs) => `RSI(14) ${inputs.rsi.toFixed(1)}`,
  },
  {
    label: 'Momentum',
    source: 'MACD',
    score: 'momentumScore',
    weight: 'momentum',
    reading: (inputs: FactorInputs) => `MACD hist ${percent(inputs.momentumPercent)} of price`,
  },
  {
    label: 'Volatility Regime',
    source: 'ATR',
    score: 'volatilityScore',
    weight: 'volatility',
    reading: (inputs: FactorInputs) => `ATR(14) ${ratio(inputs.volatilityPercent)} of price`,
  },
] as const;

export interface SetupClause {
  label: string;
  rule: string;
  actual: string;
  met: boolean;
}

/** One Pine setup condition, clause by clause. ZC LONG needs every clause, ZC RISK any. */
export interface SetupCheck {
  name: 'ZC LONG' | 'ZC RISK';
  /** As the scan recorded it. */
  holds: boolean;
  join: 'all' | 'any';
  clauses: readonly SetupClause[];
}

export interface FactorLine {
  label: string;
  reading: string;
  score: number;
  weight: number;
  /**
   * weight × the component's distance from the focus threshold, signed so a
   * positive value moves the score toward the focus setup. The three sum to
   * the unrounded score's margin.
   */
  points: number;
}

export interface ScanExplanation {
  long: SetupCheck;
  risk: SetupCheck;
  /** The setup the factors are weighed against: the one that holds (ZC LONG first), else ZC LONG. */
  focus: 'long' | 'risk';
  threshold: number;
  factors: readonly FactorLine[];
  /** Sum of the factor points. */
  margin: number;
  /** False when ZC RISK holds through the regime alone, so the points decide nothing. */
  weighed: boolean;
  supports: readonly string[];
  weakens: readonly string[];
  regimeRule: string;
}

/** Why the model's regime classifier (first match wins) chose this regime. */
export function regimeRule(inputs: FactorInputs, regime: MarketRegime): string {
  const atr = `ATR ${ratio(inputs.volatilityPercent)}`;
  const hv = ratio(REGIME_HIGH_VOLATILITY);
  if (regime === 'HIGH_VOLATILITY') return `${atr} of price ≥ ${hv}`;
  const momentum = `|MACD hist| ${ratio(Math.abs(inputs.momentumPercent))}`;
  const trending = ratio(REGIME_TRENDING_MOMENTUM);
  if (regime === 'TRENDING') return `${atr} < ${hv}; ${momentum} of price ≥ ${trending}`;
  const rsi = `RSI ${inputs.rsi.toFixed(1)}`;
  const calm = `${atr} < ${hv}; ${momentum} < ${trending}`;
  if (regime === 'MEAN_REVERTING') {
    const extreme = inputs.rsi <= RSI_OVERSOLD ? `≤ ${RSI_OVERSOLD}` : `≥ ${RSI_OVERBOUGHT}`;
    return `${calm}; ${rsi} ${extreme}`;
  }
  return `${calm}; ${rsi} between ${RSI_OVERSOLD} and ${RSI_OVERBOUGHT}`;
}

function signedPoints(points: number): string {
  const value = Number(points.toFixed(1)) || 0;
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)} pts`;
}

/** Each factor's weighed line, sorted by sign: positive supports the focus setup, negative weakens it. */
function weighFactors(
  factors: readonly FactorLine[],
  threshold: number,
): { supports: string[]; weakens: string[] } {
  const lines = factors.map((factor) => ({
    points: factor.points,
    text: `${factor.label}: ${factor.reading} scores ${Math.round(factor.score)}, ${signedPoints(factor.points)} vs ${threshold}`,
  }));
  return {
    supports: lines.filter((line) => line.points > 0).map((line) => line.text),
    weakens: lines.filter((line) => line.points < 0).map((line) => line.text),
  };
}

/**
 * The model's own setup conditions applied to one recorded result, with each
 * factor's weighed contribution toward the setup in focus. Uses only the
 * recorded score, components, inputs and regime.
 */
export function explainResult(model: CanonicalScore, setups: ModelSetups): ScanExplanation {
  const { signal_score: score, regime, inputs, components } = model;
  const regimeLabel = REGIME_LABELS[regime];
  const long: SetupCheck = {
    name: 'ZC LONG',
    holds: setups.long,
    join: 'all',
    clauses: [
      {
        label: 'Score',
        rule: `≥ ${LONG_SETUP_MIN_SCORE}`,
        actual: String(score),
        met: score >= LONG_SETUP_MIN_SCORE,
      },
      {
        label: 'MACD momentum',
        rule: `≥ ${percent(FLAT_MOMENTUM)} of price`,
        actual: percent(inputs.momentumPercent),
        met: inputs.momentumPercent >= FLAT_MOMENTUM,
      },
    ],
  };
  const highVolatility = regime === 'HIGH_VOLATILITY';
  const risk: SetupCheck = {
    name: 'ZC RISK',
    holds: setups.risk,
    join: 'any',
    clauses: [
      {
        label: 'Score',
        rule: `≤ ${RISK_SETUP_MAX_SCORE}`,
        actual: String(score),
        met: score <= RISK_SETUP_MAX_SCORE,
      },
      {
        label: 'Regime',
        rule: `High-volatility (ATR ≥ ${ratio(REGIME_HIGH_VOLATILITY)} of price)`,
        actual: `${regimeLabel} (ATR ${ratio(inputs.volatilityPercent)})`,
        met: highVolatility,
      },
    ],
  };

  const focus = !setups.long && setups.risk ? 'risk' : 'long';
  const threshold = focus === 'long' ? LONG_SETUP_MIN_SCORE : RISK_SETUP_MAX_SCORE;
  const direction = focus === 'long' ? 1 : -1;
  const factors: FactorLine[] = QUANT_FACTORS.map((factor) => {
    const value = components[factor.score];
    const weight = components.weights[factor.weight];
    return {
      label: factor.label,
      reading: factor.reading(inputs),
      score: value,
      weight,
      points: direction * weight * (value - threshold),
    };
  });
  const margin = factors.reduce((sum, factor) => sum + factor.points, 0);

  const scoreDecides = focus === 'long' || score <= RISK_SETUP_MAX_SCORE;
  const { supports, weakens } = scoreDecides
    ? weighFactors(factors, threshold)
    : { supports: [] as string[], weakens: [] as string[] };
  if (focus === 'long') {
    const gate = `MACD momentum ${percent(inputs.momentumPercent)} of price`;
    if (long.clauses[1]?.met) supports.push(`${gate} clears the ${percent(FLAT_MOMENTUM)} gate`);
    else weakens.push(`${gate} is below the ${percent(FLAT_MOMENTUM)} gate ZC LONG needs`);
  } else if (highVolatility) {
    supports.push(
      `ATR ${ratio(inputs.volatilityPercent)} of price ≥ ${ratio(REGIME_HIGH_VOLATILITY)} sets the High-volatility regime, which holds ZC RISK on its own`,
    );
    if (!scoreDecides) {
      weakens.push(`Score ${score} is above ${RISK_SETUP_MAX_SCORE}: only the regime clause holds`);
    }
  }

  return {
    long,
    risk,
    focus,
    threshold,
    factors,
    margin,
    weighed: scoreDecides,
    supports,
    weakens,
    regimeRule: regimeRule(inputs, regime),
  };
}

export interface Freshness {
  stale: boolean;
  detail: string;
}

/**
 * Whether a cohort's data would still pass the scan's own freshness rule at
 * `now`: crypto's latest close within 48h, equities' latest final session or
 * the one before. Null when there is nothing to judge or the calendar ends.
 */
export function cohortFreshness(
  cohort: Pick<ScanCohort, 'assetClass' | 'dataAsOf'>,
  now: number,
): Freshness | null {
  const newest = cohort.dataAsOf.newest;
  if (newest === null) return null;
  if (cohort.assetClass === 'equity') {
    const required = latestFinalSession(now);
    if (required === null) return null;
    const newer = tradingSessions(NEW_YORK_DATE.format(newest), required).length - 1;
    if (newer <= 0) return { stale: false, detail: 'No newer session is final yet' };
    if (newer === 1) {
      return { stale: false, detail: 'One newer session is final, within the one-session grace' };
    }
    return {
      stale: true,
      detail: `Stale: ${newer} newer sessions are final, and this scan does not refresh`,
    };
  }
  const age = now - newest;
  return age <= SCAN_MAX_DATA_AGE_MS
    ? { stale: false, detail: `Latest candle closed ${ageLabel(age)} ago, within 48h` }
    : { stale: true, detail: `Stale: latest candle closed ${ageLabel(age)} ago, past 48h` };
}

/** What is known about a TradingView alert for one asset. A standing setup is never an alert. */
export function pineAlertNote(source: TradingViewDevSource | undefined, ticker: string): string {
  if (!source) {
    return 'This scan does not read TradingView alerts. A standing setup is not an alert that fired.';
  }
  if (!source.pineAlerts) return 'TradingView alerts were not checked for this import.';
  const symbol = source.symbols[ticker];
  if (!symbol) return 'No TradingView symbol was recorded for this ticker.';
  return source.pineAlerts.symbols.includes(symbol)
    ? `A TradingView alert exists on ${symbol}. This scan cannot tell whether it fired.`
    : `No TradingView alert existed on ${symbol} when checked (${UTC_TIME.format(Date.parse(source.pineAlerts.checkedAt))} UTC), so Pine emitted nothing for it.`;
}
