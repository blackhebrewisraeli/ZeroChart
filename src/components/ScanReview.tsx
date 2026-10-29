import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Minus, X } from 'lucide-react';
import { Segmented } from '@/components/Segmented';
import {
  FLAT_MOMENTUM,
  LONG_SETUP_MIN_SCORE,
  REGIME_LABELS,
  RISK_SETUP_MAX_SCORE,
  type CanonicalScore,
  type MarketRegime,
  type ModelSetups,
} from '@/lib/canonicalModel';
import type { MarketScan, ScanAssetResult, ScanCohort } from '@/lib/marketScanner';
import { RISK_PROFILE_POLICIES, type RiskProfile } from '@/lib/portfolioBuilder';
import {
  ageLabel,
  CLASS_LABEL,
  cohortFreshness,
  dataAsOfLabel,
  explainResult,
  filtersActive,
  matchesFilters,
  NO_FILTERS,
  percent,
  pineAlertNote,
  PROVIDER_LABEL,
  QUANT_FACTORS,
  ratio,
  resultAsOfLabel,
  UTC_TIME,
  viewResults,
  type ScanExplanation,
  type ScanFilters,
  type ScanView,
  type SetupCheck,
  type SetupClause,
} from '@/lib/scanReview';
import type { TradingViewDevSource } from '@/lib/tradingViewDevScan';
import { closeOnBackdrop, cn } from '@/lib/utils';
import { containDialogTab } from '@/lib/dialogFocus';

/** Assets compared side by side, all from one cohort of one scan. */
const MAX_COMPARE = 3;

const VIEW_RULE: Record<ScanView, string> = {
  long: `ZC LONG: score ≥ ${LONG_SETUP_MIN_SCORE} and MACD momentum ≥ ${percent(FLAT_MOMENTUM)} of price`,
  risk: `ZC RISK: score ≤ ${RISK_SETUP_MAX_SCORE}, or a high-volatility regime`,
  all: 'Every evaluated asset by score; most meet no setup',
};
const VIEW_NOUN: Record<ScanView, string> = {
  long: 'long setups',
  risk: 'risk warnings',
  all: 'ranked assets',
};

/** The factor bars shared with the asset details sheet: component score and applied weight. */
export function FactorBars({ model }: Readonly<{ model: Pick<CanonicalScore, 'components'> }>) {
  return (
    <ul className="quant-factors">
      {QUANT_FACTORS.map((factor) => {
        const value = model.components[factor.score];
        const weight = model.components.weights[factor.weight];
        return (
          <li key={factor.label} className="quant-factor">
            <span className="quant-factor-label">
              {factor.label} <span>({factor.source})</span>
            </span>
            <span className="quant-factor-track" aria-hidden="true">
              <span className="quant-factor-bar" style={{ width: `${value}%` }} />
            </span>
            <span className="quant-factor-value">{Math.round(value)}</span>
            <span className="quant-factor-weight" title="Applied weight">
              {Math.round(weight * 100)}%
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The three factor readings, their 0–100 scores and the regime weights that blend them. */
function ComponentLine({ model }: Readonly<{ model: CanonicalScore }>) {
  const { inputs, components } = model;
  const { weights } = components;
  return (
    <span className="market-scan-fit font-mono">
      RSI {inputs.rsi.toFixed(1)} → {components.rsiScore.toFixed(0)} ×{weights.rsi.toFixed(2)} ·
      MACD hist {percent(inputs.momentumPercent)} → {components.momentumScore.toFixed(0)} ×
      {weights.momentum.toFixed(2)} · ATR {(inputs.volatilityPercent * 100).toFixed(2)}% →{' '}
      {components.volatilityScore.toFixed(0)} ×{weights.volatility.toFixed(2)}
    </span>
  );
}

function SetupTags({ result }: Readonly<{ result: ScanAssetResult }>) {
  return (
    <>
      {result.setups?.long && <span className="market-scan-tag is-long">Long setup</span>}
      {result.setups?.risk && <span className="market-scan-tag is-risk">Risk warning</span>}
    </>
  );
}

function profileFit(result: ScanAssetResult): string {
  const profiles = Object.entries(result.riskProfiles ?? {})
    .filter(([, fits]) => fits)
    .map(([profile]) => profile);
  return profiles.length > 0 ? `Fits ${profiles.join(' · ')} profile` : 'Fits no risk profile';
}

/** Rank, score, setup and Pine alert are four different things; say so once, above the results. */
function ReadingGuide({
  scan,
  source,
}: Readonly<{ scan: MarketScan; source: TradingViewDevSource | undefined }>) {
  let alerts = 'This scan reads no TradingView alerts.';
  if (source) {
    const requested = new Set(Object.values(source.symbols));
    const alerted = source.pineAlerts?.symbols.filter((symbol) => requested.has(symbol)) ?? [];
    if (!source.pineAlerts) alerts = 'Alerts were not checked for this import.';
    else if (alerted.length === 0) alerts = 'None exists on these symbols.';
    else alerts = `Alerts exist on ${alerted.join(', ')}.`;
  }
  return (
    <dl className="scan-guide">
      <div>
        <dt>Rank</dt>
        <dd>
          Order by score within one asset class in this scan. Relative only: #1 is not a buy, and
          ranks never cross classes.
        </dd>
      </div>
      <div>
        <dt>Score</dt>
        <dd>
          0–100 blend of RSI, MACD and ATR factors under model {scan.modelVersion}. Not a
          probability, forecast or valuation.
        </dd>
      </div>
      <div>
        <dt>Setup</dt>
        <dd>
          ZC LONG or ZC RISK holding on the last closed bar: a standing condition that may have held
          for days. Not an order.
        </dd>
      </div>
      <div>
        <dt>Pine alert</dt>
        <dd>Fires only on the bar a condition turns true, where an alert is set. {alerts}</dd>
      </div>
    </dl>
  );
}

function ResultRow({
  result,
  symbol,
  detailed,
  compared,
  compareDisabled,
  onCompare,
  onExplain,
}: Readonly<{
  result: ScanAssetResult;
  symbol: string | undefined;
  detailed: boolean;
  compared: boolean;
  compareDisabled: string | null;
  onCompare: (ticker: string) => void;
  onExplain: (ticker: string) => void;
}>) {
  return (
    <li className="market-scan-item scan-row">
      <div className="scan-row-main">
        <span className="market-scan-item-head">
          <span className="market-scan-rank">#{result.rank}</span>
          <span className="market-scan-ticker">{result.ticker}</span>
          {symbol && <span className="market-scan-rank">{symbol}</span>}
          <span className="market-scan-score">{result.model?.signal_score}</span>
          {result.model && (
            <span className="market-scan-regime">{REGIME_LABELS[result.model.regime]}</span>
          )}
          <SetupTags result={result} />
        </span>
        {detailed && result.model && <ComponentLine model={result.model} />}
        <span className="market-scan-rationale">{result.model?.rationale}</span>
        <span className="market-scan-fit">{profileFit(result)}</span>
      </div>
      <div className="scan-row-actions">
        <button
          type="button"
          className="portfolio-cash-btn"
          aria-label={`Explain ${result.ticker}`}
          onClick={() => onExplain(result.ticker)}
        >
          Explain
        </button>
        <label className="scan-compare-toggle" title={compareDisabled ?? undefined}>
          <input
            type="checkbox"
            aria-label={`Compare ${result.ticker}`}
            checked={compared}
            disabled={compareDisabled !== null}
            onChange={() => onCompare(result.ticker)}
          />
          <span>Compare</span>
        </label>
      </div>
    </li>
  );
}

function clauseValue(clause: SetupClause): string {
  return `${clause.label} ${clause.actual}`;
}

function clauseShortfall(clause: SetupClause): string {
  return `${clauseValue(clause)}, needs ${clause.rule}`;
}

function setupCell(check: SetupCheck): string {
  if (check.holds) {
    const met = check.clauses.filter((clause) => clause.met);
    return `Holds: ${met.map(clauseValue).join(', ')}`;
  }
  const unmet = check.clauses.filter((clause) => !clause.met);
  return `Not met: ${unmet.map(clauseShortfall).join('; ')}`;
}

function fetchedLabel(result: ScanAssetResult, scan: MarketScan): string {
  if (result.assetClass === 'crypto') return 'During this scan';
  if (result.fetchedAt === null) return 'Not recorded';
  const age = scan.evaluationTime - result.fetchedAt;
  return result.cached
    ? `Cached, ${ageLabel(age)} before the scan`
    : `${ageLabel(age)} before the scan`;
}

/** Up to three assets of one cohort side by side, every cell a recorded value. */
function Comparison({
  id,
  results,
  cohort,
  scan,
  source,
  onRemove,
  onClear,
}: Readonly<{
  id: string;
  results: readonly ScanAssetResult[];
  cohort: ScanCohort;
  scan: MarketScan;
  source: TradingViewDevSource | undefined;
  onRemove: (ticker: string) => void;
  onClear: () => void;
}>) {
  const rows = results.flatMap((result) =>
    result.model && result.setups
      ? [{ result, model: result.model, explanation: explainResult(result.model, result.setups) }]
      : [],
  );
  const label = CLASS_LABEL[cohort.assetClass];
  const field = (
    name: string,
    value: (row: (typeof rows)[number]) => string,
  ): [string, (row: (typeof rows)[number]) => string] => [name, value];
  const fields = [
    field('Rank', ({ result }) => `#${result.rank} of ${cohort.coverage.evaluated}`),
    field('Score', ({ model }) => String(model.signal_score)),
    field(
      'Regime',
      ({ model, explanation }) => `${REGIME_LABELS[model.regime]}: ${explanation.regimeRule}`,
    ),
    field('ZC LONG', ({ explanation }) => setupCell(explanation.long)),
    field('ZC RISK', ({ explanation }) => setupCell(explanation.risk)),
    ...QUANT_FACTORS.map((factor) =>
      field(factor.label, ({ model }) => {
        const score = Math.round(model.components[factor.score]);
        const weight = Math.round(model.components.weights[factor.weight] * 100);
        return `${factor.reading(model.inputs)} → ${score} × ${weight}%`;
      }),
    ),
    field('Risk profiles', ({ result }) => profileFit(result)),
    field('Last evaluated', ({ result }) => resultAsOfLabel(result)),
    field('Window', ({ result }) => `${result.closedCandles} closed`),
    field('Fetched', ({ result }) => fetchedLabel(result, scan)),
  ];
  return (
    <section id={id} tabIndex={-1} className="scan-compare" aria-label={`${label} comparison`}>
      <div className="scan-compare-head">
        <h4 className="market-scan-label">
          Compare {rows.length} of {MAX_COMPARE}{' '}
          <span className="market-scan-rule">{label} only, this scan</span>
        </h4>
        <button type="button" className="portfolio-cash-btn" onClick={onClear}>
          Clear
        </button>
      </div>
      {rows.length < 2 ? (
        <p className="market-scan-empty">
          Select up to {MAX_COMPARE - rows.length} more {label.toLowerCase()} to compare.
        </p>
      ) : (
        <div
          className="scan-compare-scroll"
          role="region"
          tabIndex={0} // NOSONAR(S6845): a scrollable region must take focus so the keyboard can scroll it
          aria-label="Comparison table, scrolls sideways on narrow screens"
        >
          <table className="scan-compare-table">
            <thead>
              <tr>
                <th scope="col">Recorded</th>
                {rows.map(({ result }) => (
                  <th key={result.ticker} scope="col">
                    <span className="market-scan-ticker">{result.ticker}</span>
                    {source?.symbols[result.ticker] && (
                      <span className="market-scan-rank">{source.symbols[result.ticker]}</span>
                    )}
                    <button
                      type="button"
                      className="scan-compare-remove"
                      aria-label={`Remove ${result.ticker} from comparison`}
                      onClick={() => onRemove(result.ticker)}
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {fields.map(([name, value]) => (
                <tr key={name}>
                  <th scope="row">{name}</th>
                  {rows.map((row) => (
                    <td key={row.result.ticker}>{value(row)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="market-scan-note">
        Same scan, asset class, {scan.timeframe.toUpperCase()} timeframe and model{' '}
        {scan.modelVersion}. The scores order these assets within this scan; their gaps are not
        probabilities or expected returns.
      </p>
    </section>
  );
}

function CohortResults({
  cohort,
  scan,
  view,
  filters,
  source,
  detailed,
  compare,
  onCompare,
  onExplain,
  onClearCompare,
  onClearFilters,
}: Readonly<{
  cohort: ScanCohort;
  scan: MarketScan;
  view: ScanView;
  filters: ScanFilters;
  source: TradingViewDevSource | undefined;
  detailed: boolean;
  compare: readonly string[];
  onCompare: (ticker: string) => void;
  onExplain: (ticker: string) => void;
  onClearCompare: () => void;
  onClearFilters: () => void;
}>) {
  const label = CLASS_LABEL[cohort.assetClass];
  const inView = viewResults(scan.results, cohort.assetClass, view);
  const shown = inView.filter((result) =>
    matchesFilters(result, filters, source?.symbols[result.ticker]),
  );
  const compared = compare.flatMap((ticker) => {
    const result = scan.results.find((item) => item.ticker === ticker);
    return result?.status === 'EVALUATED' && result.assetClass === cohort.assetClass
      ? [result]
      : [];
  });
  const compareClass = scan.results.find((item) => item.ticker === compare[0])?.assetClass;
  const freshness = cohortFreshness(cohort, Date.now());
  const { coverage } = cohort;
  const compareId = useId();

  let empty = `None — all ${coverage.evaluated} supported assets were evaluated.`;
  if (coverage.evaluated === 0) empty = 'No asset in this class was evaluated this scan.';
  else if (cohort.status !== 'COMPLETE') {
    empty = `None among the ${coverage.evaluated} evaluated. This class's scan is incomplete, so this is not a full answer.`;
  }

  const disabledReason = (result: ScanAssetResult): string | null => {
    if (compare.includes(result.ticker)) return null;
    if (compareClass && compareClass !== result.assetClass) {
      return 'Compare assets from one asset class only';
    }
    return compare.length >= MAX_COMPARE ? `Compare at most ${MAX_COMPARE} assets` : null;
  };

  return (
    <section className="market-scan-cohort-setups" aria-label={`${label} results`}>
      <h3 className="market-scan-label">
        {label} <span className="market-scan-rule">ranked only among {label.toLowerCase()}</span>
      </h3>
      <p className="scan-asof font-mono">
        <span className={cn('market-scan-status', `market-scan-${cohort.status.toLowerCase()}`)}>
          {cohort.status === 'COMPLETE' ? 'Complete' : 'Incomplete'}
        </span>
        <span>
          {coverage.evaluated} of {coverage.supported} evaluated
        </span>
        <span>{dataAsOfLabel(cohort) ?? 'No evaluated data'}</span>
        {freshness && (
          <span className={cn(freshness.stale && 'scan-stale')}>{freshness.detail}</span>
        )}
      </p>
      <p className="market-scan-rule scan-view-rule">
        {VIEW_RULE[view]}
        {compared.length > 0 && (
          <>
            {' · '}
            <button
              type="button"
              className="scan-link-button"
              onClick={() => document.getElementById(compareId)?.focus()}
            >
              Comparing {compared.length}: go to comparison
            </button>
          </>
        )}
      </p>
      {shown.length > 0 ? (
        <ul className="market-scan-list scan-results">
          {shown.map((result) => (
            <ResultRow
              key={result.ticker}
              result={result}
              symbol={source?.symbols[result.ticker]}
              detailed={detailed}
              compared={compare.includes(result.ticker)}
              compareDisabled={disabledReason(result)}
              onCompare={onCompare}
              onExplain={onExplain}
            />
          ))}
        </ul>
      ) : (
        <p className="market-scan-empty">
          {inView.length > 0 ? (
            <>
              No {VIEW_NOUN[view]} match these filters ({inView.length} hidden).{' '}
              <button type="button" className="scan-link-button" onClick={onClearFilters}>
                Clear filters
              </button>
            </>
          ) : (
            empty
          )}
        </p>
      )}
      {shown.length > 0 && shown.length < inView.length && (
        <p className="market-scan-fit">
          Showing {shown.length} of {inView.length} {VIEW_NOUN[view]}.
        </p>
      )}
      {cohort.assetClass === 'equity' && (
        <p className="market-scan-note">
          The model&rsquo;s predictive performance on equities and ETFs has not been validated.
          These are technical setups under model {scan.modelVersion}, not evidence that a company is
          undervalued.
        </p>
      )}
      {compared.length > 0 && (
        <Comparison
          id={compareId}
          results={compared}
          cohort={cohort}
          scan={scan}
          source={source}
          onRemove={onCompare}
          onClear={onClearCompare}
        />
      )}
    </section>
  );
}

function ClauseList({ check }: Readonly<{ check: SetupCheck }>) {
  return (
    <div className="scan-check">
      <p className="scan-check-head">
        <span className="font-mono">{check.name}</span>
        <span className={cn('scan-check-state', check.holds && 'is-met')}>
          {check.holds ? 'Holds' : 'Does not hold'}
        </span>
        <span className="market-scan-rule">
          {check.join === 'all' ? 'needs every clause' : 'needs any clause'}
        </span>
      </p>
      <ul className="scan-clauses">
        {check.clauses.map((clause) => (
          <li key={clause.label} className={cn(clause.met && 'is-met')}>
            {clause.met ? (
              <Check size={13} aria-hidden="true" />
            ) : (
              <Minus size={13} aria-hidden="true" />
            )}
            <span>
              {clause.label} {clause.rule}: <strong className="font-mono">{clause.actual}</strong>{' '}
              <span className="market-scan-rule">{clause.met ? 'met' : 'not met'}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FactorEffects({ explanation }: Readonly<{ explanation: ScanExplanation }>) {
  const name = explanation.focus === 'long' ? 'ZC LONG' : 'ZC RISK';
  const comparator = explanation.focus === 'long' ? '≥' : '≤';
  const margin = Number(explanation.margin.toFixed(1)) || 0;
  return (
    <>
      {explanation.weighed && (
        <p className="market-scan-fit">
          Weighed against {name}&rsquo;s score {comparator} {explanation.threshold}. Each
          factor&rsquo;s points are its weight × its distance from {explanation.threshold}; together
          they come to {margin >= 0 ? '+' : '−'}
          {Math.abs(margin).toFixed(1)}, the unrounded score&rsquo;s margin.
        </p>
      )}
      <div className="scan-effects">
        <div>
          <h5 className="scan-effects-title">Supports</h5>
          {explanation.supports.length > 0 ? (
            <ul className="market-scan-notes">
              {explanation.supports.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : (
            <p className="market-scan-empty">Nothing recorded supports it.</p>
          )}
        </div>
        <div>
          <h5 className="scan-effects-title">Weakens</h5>
          {explanation.weakens.length > 0 ? (
            <ul className="market-scan-notes">
              {explanation.weakens.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : (
            <p className="market-scan-empty">Nothing recorded weakens it.</p>
          )}
        </div>
      </div>
    </>
  );
}

function limitations(
  result: ScanAssetResult,
  cohort: ScanCohort,
  scan: MarketScan,
  source: TradingViewDevSource | undefined,
): string[] {
  const equity = cohort.assetClass === 'equity';
  const items: string[] = [];
  if (source) {
    items.push(
      `Imported historical development data: bars the owner's agent session retrieved from TradingView between ${UTC_TIME.format(Date.parse(source.retrieval.startedAt))} and ${UTC_TIME.format(Date.parse(source.retrieval.completedAt))} UTC, scored locally. Not a licensed feed, and it does not refresh.`,
      'Split-adjusted only: dividends are not adjusted, and no split events were reported to cross-check.',
    );
  }
  if (equity) {
    items.push(
      "The model's predictive performance on equities and ETFs has not been validated, nor whether its volatility bands suit single stocks. This is a technical reading, not a valuation of the company.",
    );
  }
  items.push(
    `The score rests on the last ${result.closedCandles} closed ${equity ? 'sessions' : 'daily candles'}; the Pine HUD sees 200 bars at a close, so its readings can differ.`,
    'No liquidity filter is applied.',
  );
  if (scan.status !== 'COMPLETE' || cohort.status !== 'COMPLETE') {
    items.push(
      `This scan is incomplete: the rank is among ${cohort.coverage.evaluated} evaluated, not all ${cohort.coverage.supported} supported.`,
    );
  }
  const freshness = cohortFreshness(cohort, Date.now());
  if (freshness?.stale) items.push(`${freshness.detail}.`);
  items.push(pineAlertNote(source, result.ticker));
  return items;
}

/** One evaluated asset, explained from its recorded values only. Nothing here is an action. */
function ExplanationSheet({
  result,
  model,
  setups,
  cohort,
  scan,
  source,
  onClose,
}: Readonly<{
  result: ScanAssetResult;
  model: CanonicalScore;
  setups: ModelSetups;
  cohort: ScanCohort;
  scan: MarketScan;
  source: TradingViewDevSource | undefined;
  onClose: () => void;
}>) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    const returnFocus = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose();
      containDialogTab(event, dialogRef.current);
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
      returnFocus?.focus();
    };
  }, [onClose]);

  const explanation = explainResult(model, setups);
  const symbol = source?.symbols[result.ticker];
  const raw = model.components.weights;
  const unrounded =
    raw.rsi * model.components.rsiScore +
    raw.momentum * model.components.momentumScore +
    raw.volatility * model.components.volatilityScore;
  const sourceRows: [string, string][] = [
    ['Source', PROVIDER_LABEL[cohort.provider ?? ''] ?? cohort.provider ?? 'Not recorded'],
    ['Instrument', [result.instrument, symbol].filter(Boolean).join(' · ') || 'Not recorded'],
    ['Timeframe', `${scan.timeframe.toUpperCase()} · ${cohort.calendar}`],
    ['Model', `${model.version} · scanner ${scan.scannerVersion}`],
    ['Candle policy', cohort.candlePolicyVersion ?? 'Not recorded'],
    ['Last evaluated', resultAsOfLabel(result)],
    [
      'Window',
      `${result.closedCandles} closed ${cohort.assetClass === 'equity' ? 'sessions' : 'candles'}`,
    ],
    ['Scored', `${UTC_TIME.format(scan.evaluationTime)} UTC`],
    ['Fetched', fetchedLabel(result, scan)],
  ];

  return createPortal(
    <div // NOSONAR(S6819): click-to-close backdrop, not an image; Escape closes it from the keyboard
      role="presentation"
      className="asset-details-overlay"
      onClick={closeOnBackdrop(onClose)}
    >
      <dialog
        ref={dialogRef}
        open
        className="asset-details-sheet scan-explain"
        aria-modal="true"
        aria-label={`${result.ticker} explanation`}
      >
        <header className="asset-details-header">
          <div>
            <span className="asset-details-eyebrow">
              {CLASS_LABEL[cohort.assetClass]} · {scan.timeframe.toUpperCase()} · #{result.rank} of{' '}
              {cohort.coverage.evaluated}
            </span>
            <h3 className="asset-details-name">{result.ticker}</h3>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="asset-details-close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </header>
        <div className="scan-explain-body">
          <div className="quant-insight-summary">
            <span className="quant-breakdown-score" title="Signal Score (0–100)">
              {model.signal_score}
            </span>
            <span className="regime-badge" data-regime={model.regime}>
              {REGIME_LABELS[model.regime]}
            </span>
            <SetupTags result={result} />
            {!result.setups?.long && !result.setups?.risk && (
              <span className="market-scan-tag">No setup</span>
            )}
            {source && (
              <span className="market-scan-status market-scan-dev">Historical import</span>
            )}
          </div>
          <p className="quant-rationale">{model.rationale}</p>

          <section aria-labelledby={`${titleId}-setups`}>
            <h4 id={`${titleId}-setups`} className="quant-breakdown-title">
              Setup conditions on the last closed bar
            </h4>
            <ClauseList check={explanation.long} />
            <ClauseList check={explanation.risk} />
            <p className="market-scan-fit">
              A standing condition, not a transition: Pine alerts only on the bar a condition turns
              true. {pineAlertNote(source, result.ticker)}
            </p>
          </section>

          <section aria-labelledby={`${titleId}-readings`}>
            <h4 id={`${titleId}-readings`} className="quant-breakdown-title">
              Readings and factor scores
            </h4>
            <dl className="scan-facts">
              <div>
                <dt>RSI(14)</dt>
                <dd>{model.inputs.rsi.toFixed(1)}</dd>
              </div>
              <div>
                <dt>MACD hist / price</dt>
                <dd>{percent(model.inputs.momentumPercent)}</dd>
              </div>
              <div>
                <dt>ATR(14) / price</dt>
                <dd>{ratio(model.inputs.volatilityPercent)}</dd>
              </div>
              <div>
                <dt>Regime</dt>
                <dd>
                  {REGIME_LABELS[model.regime]}: {explanation.regimeRule}
                </dd>
              </div>
            </dl>
            <FactorBars model={model} />
            <p className="market-scan-fit">
              Score {model.signal_score} is the weighted blend {unrounded.toFixed(1)}, rounded.
              Weights are the {REGIME_LABELS[model.regime].toLowerCase()} regime&rsquo;s.
            </p>
          </section>

          <section aria-labelledby={`${titleId}-effects`}>
            <h4 id={`${titleId}-effects`} className="quant-breakdown-title">
              What supports and weakens it
            </h4>
            <FactorEffects explanation={explanation} />
          </section>

          <section aria-labelledby={`${titleId}-source`}>
            <h4 id={`${titleId}-source`} className="quant-breakdown-title">
              Source and freshness
            </h4>
            <dl className="scan-facts">
              {sourceRows.map(([name, value]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section aria-labelledby={`${titleId}-limits`}>
            <h4 id={`${titleId}-limits`} className="quant-breakdown-title">
              Limitations
            </h4>
            <ul className="market-scan-notes">
              {limitations(result, cohort, scan, source).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
        </div>
      </dialog>
    </div>,
    document.body,
  );
}

const REGIME_OPTIONS = Object.entries(REGIME_LABELS) as [MarketRegime, string][];
const PROFILE_OPTIONS = Object.keys(RISK_PROFILE_POLICIES) as RiskProfile[];

/**
 * The scan's results for review: long setups, risk warnings or every ranked
 * asset, narrowed by recorded fields, each explainable and comparable within
 * its own cohort. Read-only: no order, size or broker link.
 */
export function ScanReview({
  scan,
  source,
  detailed,
}: Readonly<{ scan: MarketScan; source: TradingViewDevSource | undefined; detailed: boolean }>) {
  const [view, setView] = useState<ScanView>('long');
  const [filters, setFilters] = useState<ScanFilters>(NO_FILTERS);
  const [compare, setCompare] = useState<readonly string[]>([]);
  const [explaining, setExplaining] = useState<string | null>(null);
  const closeExplanation = useCallback(() => setExplaining(null), []);
  const toggleCompare = useCallback((ticker: string) => {
    setCompare((current) => {
      if (current.includes(ticker)) return current.filter((item) => item !== ticker);
      return current.length < MAX_COMPARE ? [...current, ticker] : current;
    });
  }, []);

  const cohorts = scan.cohorts.filter((cohort) => cohort.status !== 'UNSUPPORTED');
  const count = (which: ScanView) =>
    cohorts.reduce(
      (sum, cohort) => sum + viewResults(scan.results, cohort.assetClass, which).length,
      0,
    );
  const set = <K extends keyof ScanFilters>(key: K, value: ScanFilters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));

  const explained = scan.results.find((result) => result.ticker === explaining);
  const explainedCohort = cohorts.find((cohort) => cohort.assetClass === explained?.assetClass);

  return (
    <div className="scan-review">
      <ReadingGuide scan={scan} source={source} />
      <div className="scan-toolbar">
        <Segmented
          value={view}
          ariaLabel="Scan view"
          className="scan-views"
          onChange={setView}
          options={(['long', 'risk', 'all'] as const).map((value) => ({
            value,
            label: (
              <>
                {{ long: 'Long setups', risk: 'Risk warnings', all: 'All ranked' }[value]}
                <span className="segment-tag">{count(value)}</span>
              </>
            ),
          }))}
        />
        <div className="scan-filters">
          <input
            className="portfolio-cash-input scan-search"
            type="search"
            aria-label="Search ticker or symbol"
            placeholder="Ticker or symbol"
            value={filters.query}
            onChange={(event) => set('query', event.target.value)}
          />
          <select
            className="portfolio-cash-input"
            aria-label="Filter by regime"
            value={filters.regime}
            onChange={(event) => set('regime', event.target.value as ScanFilters['regime'])}
          >
            <option value="any">Any regime</option>
            {REGIME_OPTIONS.map(([value, name]) => (
              <option key={value} value={value}>
                {name}
              </option>
            ))}
          </select>
          <select
            className="portfolio-cash-input"
            aria-label="Filter by MACD momentum"
            value={filters.momentum}
            onChange={(event) => set('momentum', event.target.value as ScanFilters['momentum'])}
          >
            <option value="any">Any momentum</option>
            <option value="Bullish">Bullish</option>
            <option value="Flat">Flat</option>
            <option value="Bearish">Bearish</option>
          </select>
          <select
            className="portfolio-cash-input"
            aria-label="Filter by risk-profile fit"
            value={filters.profile}
            onChange={(event) => set('profile', event.target.value as ScanFilters['profile'])}
          >
            <option value="any">Any profile fit</option>
            {PROFILE_OPTIONS.map((profile) => (
              <option key={profile} value={profile}>
                Fits {profile}
              </option>
            ))}
            <option value="none">Fits no profile</option>
          </select>
          {filtersActive(filters) && (
            <button
              type="button"
              className="portfolio-cash-btn"
              onClick={() => setFilters(NO_FILTERS)}
            >
              Reset
            </button>
          )}
        </div>
      </div>
      {cohorts.map((cohort) => (
        <CohortResults
          key={cohort.assetClass}
          cohort={cohort}
          scan={scan}
          view={view}
          filters={filters}
          source={source}
          detailed={detailed}
          compare={compare}
          onCompare={toggleCompare}
          onExplain={setExplaining}
          onClearCompare={() => setCompare([])}
          onClearFilters={() => setFilters(NO_FILTERS)}
        />
      ))}
      {explained?.model && explained.setups && explainedCohort && (
        <ExplanationSheet
          result={explained}
          model={explained.model}
          setups={explained.setups}
          cohort={explainedCohort}
          scan={scan}
          source={source}
          onClose={closeExplanation}
        />
      )}
    </div>
  );
}
