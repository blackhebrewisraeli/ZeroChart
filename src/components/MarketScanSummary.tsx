import { Radar } from 'lucide-react';
import { LONG_SETUP_MIN_SCORE, REGIME_LABELS, RISK_SETUP_MAX_SCORE } from '@/lib/canonicalModel';
import {
  scanStatusLabel,
  type MarketScan,
  type ScanAssetResult,
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

function SetupItem({ result }: Readonly<{ result: ScanAssetResult }>) {
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
    </li>
  );
}

function SetupList({
  title,
  rule,
  items,
  scan,
}: Readonly<{
  title: string;
  rule: string;
  items: readonly ScanAssetResult[];
  scan: MarketScan;
}>) {
  let empty = `None — all ${scan.coverage.evaluated} supported assets were evaluated.`;
  if (scan.status !== 'COMPLETE') {
    empty = `None among the ${scan.coverage.evaluated} evaluated. The scan is incomplete, so this is not a full answer.`;
  }
  return (
    <div className="market-scan-setups">
      <h3 className="market-scan-label">
        {title} <span className="market-scan-rule">{rule}</span>
      </h3>
      {items.length > 0 ? (
        <ul className="market-scan-list">
          {items.map((result) => (
            <SetupItem key={result.ticker} result={result} />
          ))}
        </ul>
      ) : (
        <p className="market-scan-empty">{empty}</p>
      )}
    </div>
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
  const ranked = scan.results.filter((result) => result.status === 'EVALUATED');
  const failures = scan.results.filter(
    (result) => result.status !== 'EVALUATED' && result.status !== 'UNSUPPORTED',
  );
  const { coverage } = scan;
  const asOf = scan.dataAsOf.newest;
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
          {asOf !== null && ` · Candles to ${UTC_DAY.format(asOf)} close (UTC)`}
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
            {scan.modelVersion} · {scan.timeframe.toUpperCase()} · {scan.candlePolicyVersion}
          </dd>
        </div>
      </dl>
      <div className="market-scan-grid">
        <SetupList
          title="Long setups"
          rule={`score ≥ ${LONG_SETUP_MIN_SCORE}, bullish momentum`}
          items={ranked.filter((result) => result.setups?.long)}
          scan={scan}
        />
        <SetupList
          title="Risk setups"
          rule={`score ≤ ${RISK_SETUP_MAX_SCORE} or high volatility`}
          items={ranked.filter((result) => result.setups?.risk)}
          scan={scan}
        />
      </div>
      {failures.length > 0 && (
        <section className="market-scan-failures" aria-label="Not evaluated this scan">
          <h3 className="market-scan-label">Not evaluated this scan</h3>
          <ul className="market-scan-list">
            {failures.map((result) => (
              <li key={result.ticker} className="market-scan-failure">
                <span className="market-scan-ticker">{result.ticker}</span>
                <span className="market-scan-fail-code">{scanStatusLabel(result)}</span>
                <span className="market-scan-rationale">{result.detail}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="market-scan-note">
        Setups are the model&rsquo;s conditions on the last closed daily candle (the Pine
        HUD&rsquo;s ZC LONG and ZC RISK) — technical setups, not orders, valuations or forecasts,
        and a high score alone is not a buy signal. Ranking compares Binance spot crypto only;
        equities and forex are not scanned until they have a validated daily candle source.
      </p>
    </section>
  );
}
