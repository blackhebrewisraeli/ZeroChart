import { Radar } from 'lucide-react';
import { ScanReview } from '@/components/ScanReview';
import {
  scanStatusLabel,
  type MarketScan,
  type ScanAssetResult,
  type ScanCohort,
  type ScanStatus,
} from '@/lib/marketScanner';
import { ageLabel, CLASS_LABEL, dataAsOfLabel, PROVIDER_LABEL, UTC_TIME } from '@/lib/scanReview';
import {
  TRADINGVIEW_DEV_UNIVERSE_SOURCE,
  type TradingViewDevSource,
} from '@/lib/tradingViewDevScan';
import { cn } from '@/lib/utils';

const STATUS_LABEL: Record<ScanStatus, string> = {
  COMPLETE: 'Complete',
  PARTIAL: 'Incomplete',
  FAILED: 'Failed',
};

function universeLabel(source: string): string {
  if (source === TRADINGVIEW_DEV_UNIVERSE_SOURCE) return 'Requested';
  return source === 'assets_status' ? 'Markets universe' : 'Sample preview universe';
}

/** Where a development scan's bars came from, and what it does not establish. */
function DevSourceNotes({
  scan,
  source,
}: Readonly<{ scan: MarketScan; source: TradingViewDevSource }>) {
  const requested = new Set(Object.values(source.symbols));
  const asOfLabel = scan.cohorts[0] ? dataAsOfLabel(scan.cohorts[0]) : null;
  const alerted = source.pineAlerts?.symbols.filter((symbol) => requested.has(symbol)) ?? [];
  let alerts = 'TradingView alerts were not checked.';
  if (source.pineAlerts) {
    alerts =
      alerted.length === 0
        ? `No TradingView alert exists on any of these symbols (checked ${UTC_TIME.format(Date.parse(source.pineAlerts.checkedAt))} UTC), so none of these setups was emitted by Pine.`
        : `TradingView alerts exist on ${alerted.join(', ')}; a setup here is still ZeroChart's calculation, not proof an alert fired.`;
  }
  return (
    <section className="market-scan-coverage" aria-label="Source and limitations">
      <h3 className="market-scan-label">Source and limitations</h3>
      <ul className="market-scan-list market-scan-notes">
        <li>
          Daily bars retrieved by the owner&rsquo;s agent session through TradingView&rsquo;s MCP
          server ({source.tool}, {source.interval}) from{' '}
          {UTC_TIME.format(Date.parse(source.retrieval.startedAt))} to{' '}
          {UTC_TIME.format(Date.parse(source.retrieval.completedAt))} UTC, then imported and scored
          locally. The app has no TradingView connection; this is a development scan, not a licensed
          product feed, and it does not refresh.
        </li>
        <li>TradingView&rsquo;s notice: &ldquo;{source.notice}&rdquo;</li>
        <li>
          Split-adjusted only: dividends are not adjusted, and TradingView reports no split events,
          so an unadjusted split could not be cross-checked.
        </li>
        <li>
          The notice&rsquo;s &ldquo;still forming&rdquo; bar is never scored: a session counts only
          once final (9h after its close), and each score rests on the last{' '}
          {scan.cohorts[0]?.minClosedCandles} final sessions ({asOfLabel ?? 'none evaluated'}). Data
          may be delayed under the owner&rsquo;s plan.
        </li>
        <li>{alerts}</li>
        <li>Universe: {source.selectionRule}</li>
      </ul>
    </section>
  );
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

/**
 * What a Markets scan covered and found: universe, coverage, freshness, and
 * every evaluated asset for review, each explainable from its recorded values.
 * Setups are chart conditions, not orders — there is nothing to execute here.
 */
export function MarketScanSummary({
  scan,
  completedAt,
  scanning,
  failed,
  source,
}: Readonly<{
  scan: MarketScan | undefined;
  completedAt: number;
  scanning: boolean;
  failed: boolean;
  /** Set for the local TradingView development scan, which adds its provenance and full ranking. */
  source?: TradingViewDevSource;
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
  const title = source ? 'TradingView development scan' : 'Market scan';
  const firstCohort = scan.cohorts[0];
  const asOf = firstCohort ? dataAsOfLabel(firstCohort) : null;
  return (
    <section className={cn('market-scan', source && 'market-scan-devscan')} aria-label={title}>
      <div className="market-scan-head">
        <span className="market-scan-title">
          <Radar size={14} /> {title}
        </span>
        <span className={cn('market-scan-status', `market-scan-${scan.status.toLowerCase()}`)}>
          {STATUS_LABEL[scan.status]}
        </span>
        {source && (
          <span className="market-scan-status market-scan-dev">Historical dev import</span>
        )}
        <span className="market-scan-meta font-mono">
          {scanning ? 'Re-scanning… · ' : ''}
          {source
            ? `${asOf ?? 'No evaluated sessions'} · scored ${UTC_TIME.format(completedAt)} UTC`
            : `Completed ${UTC_TIME.format(completedAt)} UTC`}
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
        {source ? (
          <div>
            <dt>Not evaluated</dt>
            <dd>{coverage.notEvaluated + coverage.unsupported}</dd>
          </div>
        ) : (
          <div>
            <dt>Not scanned</dt>
            <dd>
              {coverage.unsupported}
              {coverage.unsupported > 0 && ` (${unsupportedBreakdown(scan.results)})`}
            </dd>
          </div>
        )}
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
      {scan.cohorts.some((cohort) => cohort.status !== 'UNSUPPORTED') && (
        <ScanReview scan={scan} source={source} detailed={source !== undefined} />
      )}
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
      {source && <DevSourceNotes scan={scan} source={source} />}
    </section>
  );
}
