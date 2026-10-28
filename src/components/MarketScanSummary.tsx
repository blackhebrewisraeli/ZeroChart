import { Radar } from 'lucide-react';
import { LONG_SETUP_MIN_SCORE, REGIME_LABELS, RISK_SETUP_MAX_SCORE } from '@/lib/canonicalModel';
import {
  scanStatusLabel,
  type MarketScan,
  type ScanAssetResult,
  type ScanCohort,
  type ScanStatus,
} from '@/lib/marketScanner';
import { cn } from '@/lib/utils';

const STATUS_LABEL: Record<ScanStatus, string> = {
  COMPLETE: 'Complete',
  PARTIAL: 'Incomplete',
  FAILED: 'Failed',
};

const UTC_TIME = new Intl.DateTimeFormat('en-GB', {
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

const CLASS_LABEL: Record<ScanCohort['assetClass'], string> = {
  crypto: 'Crypto',
  equity: 'Equities & ETFs',
  forex: 'Forex',
};

const PROVIDER_LABEL: Record<string, string> = { 'binance-spot-klines': 'Binance spot klines' };

/** "candles to 27 Oct close (UTC)" for crypto days, "sessions to 27 Oct close (New York)" for equities. */
function dataAsOfLabel(cohort: ScanCohort): string | null {
  const newest = cohort.dataAsOf.newest;
  if (newest === null) return null;
  return cohort.assetClass === 'equity'
    ? `sessions to ${NEW_YORK_DAY.format(newest)} close (New York)`
    : `candles to ${UTC_DAY.format(newest)} close (UTC)`;
}

/** "3h 05m" between a cached fetch and the scan. */
function ageLabel(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`;
}

function universeLabel(source: string): string {
  return source === 'assets_status' ? 'Markets universe' : 'Sample preview universe';
}

function unsupportedBreakdown(results: readonly ScanAssetResult[]): string {
  const count = (assetClass: ScanAssetResult['assetClass']) =>
    results.filter((result) => result.status === 'UNSUPPORTED' && result.assetClass === assetClass)
      .length;
  const equities = count('equity');
  const forex = count('forex');
  return [
    equities > 0 && `${equities} ${equities === 1 ? 'equity' : 'equities'}`,
    forex > 0 && `${forex} forex`,
  ]
    .filter(Boolean)
    .join(', ');
}

function CachedAge({ result, scan }: Readonly<{ result: ScanAssetResult; scan: MarketScan }>) {
  if (!result.cached || result.fetchedAt === null) return null;
  return (
    <span className="market-scan-fit">
      Cached data, fetched {ageLabel(scan.evaluationTime - result.fetchedAt)} before this scan
    </span>
  );
}

function SetupItem({ result, scan }: Readonly<{ result: ScanAssetResult; scan: MarketScan }>) {
  const profiles = Object.entries(result.riskProfiles ?? {})
    .filter(([, fits]) => fits)
    .map(([profile]) => profile);
  return (
    <li className="market-scan-item">
      <span className="market-scan-item-head">
        <span className="market-scan-rank">#{result.rank}</span>
        <span className="market-scan-ticker">{result.ticker}</span>
        <span className="market-scan-score">{result.model?.signal_score}</span>
        {result.model && (
          <span className="market-scan-regime">{REGIME_LABELS[result.model.regime]}</span>
        )}
      </span>
      <span className="market-scan-rationale">{result.model?.rationale}</span>
      <span className="market-scan-fit">
        {profiles.length > 0 ? `Fits ${profiles.join(' · ')} profile` : 'Fits no risk profile'}
      </span>
      <CachedAge result={result} scan={scan} />
    </li>
  );
}

function SetupList({
  title,
  rule,
  items,
  cohort,
  scan,
}: Readonly<{
  title: string;
  rule: string;
  items: readonly ScanAssetResult[];
  cohort: ScanCohort;
  scan: MarketScan;
}>) {
  let empty = `None — all ${cohort.coverage.evaluated} supported assets were evaluated.`;
  if (cohort.status !== 'COMPLETE') {
    empty = `None among the ${cohort.coverage.evaluated} evaluated. This class's scan is incomplete, so this is not a full answer.`;
  }
  return (
    <div className="market-scan-setups">
      <h3 className="market-scan-label">
        {title} <span className="market-scan-rule">{rule}</span>
      </h3>
      {items.length > 0 ? (
        <ul className="market-scan-list">
          {items.map((result) => (
            <SetupItem key={result.ticker} result={result} scan={scan} />
          ))}
        </ul>
      ) : (
        <p className="market-scan-empty">{empty}</p>
      )}
    </div>
  );
}

/** "2 from cache, fetched up to 3h 05m before this scan"; null when nothing was cached. */
function cacheLabel(members: readonly ScanAssetResult[], evaluationTime: number): string | null {
  const ages = members.flatMap((result) =>
    result.cached && result.fetchedAt !== null ? [evaluationTime - result.fetchedAt] : [],
  );
  if (ages.length === 0) return null;
  return `${ages.length} from cache, fetched up to ${ageLabel(Math.max(...ages))} before this scan`;
}

function CohortRow({ cohort, scan }: Readonly<{ cohort: ScanCohort; scan: MarketScan }>) {
  const { coverage } = cohort;
  const members = scan.results.filter((result) => result.assetClass === cohort.assetClass);
  const unsupported = cohort.status === 'UNSUPPORTED';
  const source = unsupported
    ? (members.find((result) => result.status === 'UNSUPPORTED')?.detail ??
      'No validated daily candle source.')
    : [
        PROVIDER_LABEL[cohort.provider ?? ''] ?? cohort.provider,
        cohort.candlePolicyVersion,
        dataAsOfLabel(cohort),
        cacheLabel(members, scan.evaluationTime),
      ]
        .filter(Boolean)
        .join(' · ');
  return (
    <li className="market-scan-cohort">
      <span className="market-scan-cohort-name">
        {CLASS_LABEL[cohort.assetClass]}{' '}
        <span className="market-scan-rule">{cohort.timeframe.toUpperCase()}</span>
      </span>
      <span className="market-scan-cohort-count">
        {unsupported
          ? `Not scanned · ${coverage.configured}`
          : `${coverage.evaluated} of ${coverage.supported} evaluated`}
      </span>
      <span className="market-scan-rationale">{source}</span>
    </li>
  );
}

function CohortSetups({ cohort, scan }: Readonly<{ cohort: ScanCohort; scan: MarketScan }>) {
  const ranked = scan.results.filter(
    (result) => result.status === 'EVALUATED' && result.assetClass === cohort.assetClass,
  );
  const label = CLASS_LABEL[cohort.assetClass];
  return (
    <section className="market-scan-cohort-setups" aria-label={`${label} setups`}>
      <h3 className="market-scan-label">
        {label} <span className="market-scan-rule">ranked only among {label.toLowerCase()}</span>
      </h3>
      <div className="market-scan-grid">
        <SetupList
          title="Long setups"
          rule={`score ≥ ${LONG_SETUP_MIN_SCORE}, bullish momentum`}
          items={ranked.filter((result) => result.setups?.long)}
          cohort={cohort}
          scan={scan}
        />
        <SetupList
          title="Risk setups"
          rule={`score ≤ ${RISK_SETUP_MAX_SCORE} or high volatility`}
          items={ranked.filter((result) => result.setups?.risk)}
          cohort={cohort}
          scan={scan}
        />
      </div>
      {cohort.assetClass === 'equity' && (
        <p className="market-scan-note">
          The model&rsquo;s predictive performance on equities and ETFs has not been validated.
          These are technical setups under model {scan.modelVersion}, not evidence that a company is
          undervalued.
        </p>
      )}
    </section>
  );
}

/**
 * What the last Markets scan covered and found: universe, coverage, freshness,
 * and the assets meeting the model's setup conditions, each with its reason.
 * Setups are chart conditions, not orders — there is nothing to execute here.
 */
export function MarketScanSummary({
  scan,
  completedAt,
  scanning,
  failed,
}: Readonly<{
  scan: MarketScan | undefined;
  completedAt: number;
  scanning: boolean;
  failed: boolean;
}>) {
  if (!scan) {
    return (
      <section className="market-scan" aria-label="Market scan" aria-busy={scanning}>
        <p className="market-scan-empty">
          {failed ? 'The market scan could not run. Scores are unavailable.' : 'Scanning…'}
        </p>
      </section>
    );
  }
  const failures = scan.results.filter(
    (result) => result.status !== 'EVALUATED' && result.status !== 'UNSUPPORTED',
  );
  const { coverage } = scan;
  return (
    <section className="market-scan" aria-label="Market scan">
      <div className="market-scan-head">
        <span className="market-scan-title">
          <Radar size={14} /> Market scan
        </span>
        <span className={cn('market-scan-status', `market-scan-${scan.status.toLowerCase()}`)}>
          {STATUS_LABEL[scan.status]}
        </span>
        <span className="market-scan-meta font-mono">
          {scanning ? 'Re-scanning… · ' : ''}
          Completed {UTC_TIME.format(completedAt)} UTC
        </span>
      </div>
      <dl className="market-scan-stats">
        <div>
          <dt>{universeLabel(scan.universe.source)}</dt>
          <dd>{coverage.configured} assets</dd>
        </div>
        <div>
          <dt>Evaluated</dt>
          <dd>
            {coverage.evaluated} of {coverage.supported} supported
          </dd>
        </div>
        <div>
          <dt>Not scanned</dt>
          <dd>
            {coverage.unsupported}
            {coverage.unsupported > 0 && ` (${unsupportedBreakdown(scan.results)})`}
          </dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd className="font-mono">
            {scan.modelVersion} · {scan.timeframe.toUpperCase()}
          </dd>
        </div>
      </dl>
      <section className="market-scan-coverage" aria-label="Coverage by asset class">
        <h3 className="market-scan-label">Coverage by asset class and timeframe</h3>
        <ul className="market-scan-list">
          {scan.cohorts.map((cohort) => (
            <CohortRow key={cohort.assetClass} cohort={cohort} scan={scan} />
          ))}
        </ul>
      </section>
      {scan.cohorts
        .filter((cohort) => cohort.status !== 'UNSUPPORTED')
        .map((cohort) => (
          <CohortSetups key={cohort.assetClass} cohort={cohort} scan={scan} />
        ))}
      {failures.length > 0 && (
        <section className="market-scan-failures" aria-label="Not evaluated this scan">
          <h3 className="market-scan-label">Not evaluated this scan</h3>
          <ul className="market-scan-list">
            {failures.map((result) => (
              <li key={result.ticker} className="market-scan-failure">
                <span className="market-scan-ticker">{result.ticker}</span>
                <span className="market-scan-fail-code">{scanStatusLabel(result)}</span>
                <span className="market-scan-rationale">{result.detail}</span>
                <CachedAge result={result} scan={scan} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="market-scan-note">
        Setups are the model&rsquo;s conditions on the last closed daily candle (the Pine
        HUD&rsquo;s ZC LONG and ZC RISK) — technical setups under the current model, not orders,
        recommendations, valuations or forecasts, and a high score alone is not a buy signal. Each
        asset class is ranked only within itself: the same score does not mean the same risk or
        predictive value across classes.
      </p>
    </section>
  );
}
