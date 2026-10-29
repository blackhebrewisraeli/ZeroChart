import { describe, expect, it } from 'vitest';
import {
  CANONICAL_MODEL_VERSION,
  FLAT_MOMENTUM,
  modelSetups,
  scoreFactors,
  type CanonicalScore,
  type FactorInputs,
} from '@/lib/canonicalModel';
import { evaluateScan, type ScanAssetResult, type ScanInput } from '@/lib/marketScanner';
import {
  cohortFreshness,
  explainResult,
  matchesFilters,
  NO_FILTERS,
  pineAlertNote,
  regimeRule,
  resultAsOfLabel,
  viewResults,
} from '@/lib/scanReview';
import type { TradingViewDevSource } from '@/lib/tradingViewDevScan';
import { bars, EQUITY_NOW, falling, rising, split, wave } from './usEquityFixtures';

/** A recorded reading built by the engine's own blend; `score` overrides only the rounded total. */
function model(inputs: FactorInputs, score?: number): CanonicalScore {
  const factors = scoreFactors(inputs);
  return {
    status: 'OK',
    version: CANONICAL_MODEL_VERSION,
    close: 100,
    atr: inputs.volatilityPercent * 100,
    inputs,
    ...factors,
    signal_score: score ?? factors.signal_score,
  };
}

const calm: FactorInputs = { rsi: 50, momentumPercent: 0.002, volatilityPercent: 0.01 };

function explain(m: CanonicalScore) {
  return explainResult(m, modelSetups(m));
}

function unrounded(m: CanonicalScore): number {
  const { components: c } = m;
  return (
    c.weights.rsi * c.rsiScore +
    c.weights.momentum * c.momentumScore +
    c.weights.volatility * c.volatilityScore
  );
}

describe('explainResult boundaries', () => {
  it('holds ZC LONG at exactly score 78 and +0.05% momentum, and not one step below either', () => {
    const at = explain(model({ ...calm, momentumPercent: FLAT_MOMENTUM }, 78));
    expect(at.long.holds).toBe(true);
    expect(at.long.clauses.map((clause) => clause.met)).toEqual([true, true]);

    const lowScore = explain(model({ ...calm, momentumPercent: FLAT_MOMENTUM }, 77));
    expect(lowScore.long.holds).toBe(false);
    expect(lowScore.long.clauses.map((clause) => clause.met)).toEqual([false, true]);

    const flat = explain(model({ ...calm, momentumPercent: FLAT_MOMENTUM - 1e-9 }, 90));
    expect(flat.long.holds).toBe(false);
    expect(flat.long.clauses.map((clause) => clause.met)).toEqual([true, false]);
    expect(flat.weakens.at(-1)).toMatch(/is below the \+0\.05% gate ZC LONG needs/);
  });

  it('holds ZC RISK at exactly score 28, or through the high-volatility regime alone', () => {
    expect(explain(model(calm, 28)).risk.holds).toBe(true);
    expect(explain(model(calm, 29)).risk.holds).toBe(false);

    const regimeOnly = explain(model({ ...calm, volatilityPercent: 0.04 }, 60));
    expect(regimeOnly.risk.holds).toBe(true);
    expect(regimeOnly.risk.clauses.map((clause) => clause.met)).toEqual([false, true]);
    expect(regimeOnly.focus).toBe('risk');
    // The score decides nothing here, so no factor points are offered as reasons.
    expect(regimeOnly.weighed).toBe(false);
    expect(regimeOnly.supports).toEqual([
      'ATR 4.00% of price ≥ 4.00% sets the High-volatility regime, which holds ZC RISK on its own',
    ]);
    expect(regimeOnly.weakens).toEqual(['Score 60 is above 28: only the regime clause holds']);
  });

  it('agrees with the recorded setups and splits the score margin exactly across factors', () => {
    const readings: FactorInputs[] = [];
    for (const rsi of [5, 30, 50, 70, 95])
      for (const momentumPercent of [-0.012, -0.004, 0, 0.0005, 0.006])
        for (const volatilityPercent of [0.004, 0.02, 0.039, 0.04, 0.07])
          readings.push({ rsi, momentumPercent, volatilityPercent });
    for (const inputs of readings) {
      const m = model(inputs);
      const setups = modelSetups(m);
      const explanation = explainResult(m, setups);
      for (const check of [explanation.long, explanation.risk]) {
        const met = check.clauses.map((clause) => clause.met);
        expect(check.holds).toBe(check.join === 'all' ? met.every(Boolean) : met.some(Boolean));
      }
      expect(explanation.long.holds).toBe(setups.long);
      expect(explanation.risk.holds).toBe(setups.risk);
      const sign = explanation.focus === 'long' ? 1 : -1;
      expect(explanation.margin).toBeCloseTo(sign * (unrounded(m) - explanation.threshold), 9);
      expect(explanation.factors.map((factor) => factor.score)).toEqual([
        m.components.rsiScore,
        m.components.momentumScore,
        m.components.volatilityScore,
      ]);
    }
  });

  it('weighs a result meeting neither setup against ZC LONG and names what holds it back', () => {
    const m = model({ rsi: 60, momentumPercent: -0.003, volatilityPercent: 0.02 });
    const explanation = explain(m);
    expect(explanation.long.holds || explanation.risk.holds).toBe(false);
    expect(explanation.focus).toBe('long');
    expect(explanation.threshold).toBe(78);
    expect(explanation.supports).toEqual([]);
    expect(explanation.weakens[0]).toMatch(
      /^Mean Reversion: RSI\(14\) 60\.0 scores \d+, −\d+\.\d pts vs 78$/,
    );
    expect(explanation.weakens.at(-1)).toBe(
      'MACD momentum -0.30% of price is below the +0.05% gate ZC LONG needs',
    );
  });

  it('weighs a score-driven risk warning against 28, so low components support it', () => {
    const m = model({ rsi: 92, momentumPercent: -0.009, volatilityPercent: 0.035 });
    const explanation = explain(m);
    expect(explanation.risk.holds).toBe(true);
    expect(explanation.focus).toBe('risk');
    expect(explanation.weighed).toBe(true);
    expect(explanation.supports.some((line) => line.startsWith('Momentum:'))).toBe(true);
    expect(explanation.margin).toBeCloseTo(28 - unrounded(m), 9);
  });

  it('states the first-match regime rule from the recorded readings', () => {
    expect(
      regimeRule({ rsi: 50, momentumPercent: 0.01, volatilityPercent: 0.05 }, 'HIGH_VOLATILITY'),
    ).toBe('ATR 5.00% of price ≥ 4.00%');
    expect(
      regimeRule({ rsi: 50, momentumPercent: -0.006, volatilityPercent: 0.02 }, 'TRENDING'),
    ).toBe('ATR 2.00% < 4.00%; |MACD hist| 0.60% of price ≥ 0.50%');
    expect(
      regimeRule({ rsi: 22, momentumPercent: 0.001, volatilityPercent: 0.02 }, 'MEAN_REVERTING'),
    ).toBe('ATR 2.00% < 4.00%; |MACD hist| 0.10% < 0.50%; RSI 22.0 ≤ 30');
    expect(
      regimeRule({ rsi: 81, momentumPercent: 0.001, volatilityPercent: 0.02 }, 'MEAN_REVERTING'),
    ).toMatch(/RSI 81\.0 ≥ 70$/);
    expect(
      regimeRule({ rsi: 55, momentumPercent: 0.001, volatilityPercent: 0.02 }, 'NEUTRAL'),
    ).toMatch(/RSI 55\.0 between 30 and 70$/);
  });
});

/** Labeled fixture scan: synthetic equities and a crypto asset, nothing fetched. */
function fixtureScan(): ScanAssetResult[] {
  const equity = (ticker: string, path: (i: number) => number): ScanInput => ({
    ticker,
    instrument: `US:${ticker}`,
    equity: {
      provider: 'fixture-eod',
      range: { from: '2026-01-09', to: '2026-10-27' },
      series: split(bars(path)),
      fetchedAt: EQUITY_NOW,
      cached: false,
    },
  });
  return [
    ...evaluateScan(
      [
        equity('AAPL', wave),
        equity('MSFT', rising),
        equity('NVDA', falling),
        equity('SPY', (i) => (i % 2 === 0 ? 100 : 106)),
      ],
      {
        evaluationTime: EQUITY_NOW,
        universeSource: 'assets_status',
        equityProvider: 'fixture-eod',
      },
    ).results,
  ];
}

describe('views and filters', () => {
  const results = fixtureScan();

  it('keeps rank order inside one cohort and narrows to the recorded setup', () => {
    const all = viewResults(results, 'equity', 'all');
    expect(all.map((result) => result.rank)).toEqual([1, 2, 3, 4]);
    expect(viewResults(results, 'crypto', 'all')).toEqual([]);
    const risk = viewResults(results, 'equity', 'risk');
    expect(risk.length).toBeGreaterThan(0);
    expect(risk.every((result) => result.setups?.risk)).toBe(true);
    expect(viewResults(results, 'equity', 'long').every((result) => result.setups?.long)).toBe(
      true,
    );
  });

  it('matches ticker, instrument or requested symbol case-insensitively', () => {
    const aapl = results.find((result) => result.ticker === 'AAPL')!;
    expect(matchesFilters(aapl, { ...NO_FILTERS, query: ' aap ' })).toBe(true);
    expect(matchesFilters(aapl, { ...NO_FILTERS, query: 'us:aapl' })).toBe(true);
    expect(matchesFilters(aapl, { ...NO_FILTERS, query: 'nasdaq' }, 'NASDAQ:AAPL')).toBe(true);
    expect(matchesFilters(aapl, { ...NO_FILTERS, query: 'msft' })).toBe(false);
  });

  it('filters by recorded regime, momentum bias and risk-profile fit', () => {
    for (const result of results) {
      const m = result.model!;
      expect(matchesFilters(result, { ...NO_FILTERS, regime: m.regime })).toBe(true);
      const other = m.regime === 'NEUTRAL' ? 'TRENDING' : 'NEUTRAL';
      expect(matchesFilters(result, { ...NO_FILTERS, regime: other })).toBe(false);
      const fits = Object.values(result.riskProfiles!).some(Boolean);
      expect(matchesFilters(result, { ...NO_FILTERS, profile: 'none' })).toBe(!fits);
      expect(matchesFilters(result, { ...NO_FILTERS, profile: 'aggressive' })).toBe(
        result.riskProfiles!.aggressive,
      );
    }
    const bullish = results.filter((r) =>
      matchesFilters(r, { ...NO_FILTERS, momentum: 'Bullish' }),
    );
    expect(bullish.every((r) => r.model!.inputs.momentumPercent >= FLAT_MOMENTUM)).toBe(true);
  });

  it('never lets an unevaluated result through a filter', () => {
    const failed: ScanAssetResult = { ...results[0]!, status: 'FETCH_FAILED', model: null };
    expect(matchesFilters(failed, NO_FILTERS)).toBe(false);
    expect(resultAsOfLabel({ assetClass: 'equity', dataAsOf: null })).toBe('Not recorded');
  });
});

describe('cohortFreshness', () => {
  const HOUR = 3_600_000;
  // 27 Oct 2026 16:00 New York: the close of the fixture's latest session.
  const close27 = Date.UTC(2026, 9, 27, 20);

  it('keeps equities fresh through the one-session grace, then calls them stale', () => {
    const cohort = {
      assetClass: 'equity' as const,
      dataAsOf: { oldest: close27, newest: close27 },
    };
    expect(cohortFreshness(cohort, EQUITY_NOW)).toEqual({
      stale: false,
      detail: 'No newer session is final yet',
    });
    // 28 Oct is final from 01:00 New York on 29 Oct.
    expect(cohortFreshness(cohort, Date.UTC(2026, 9, 29, 12))?.stale).toBe(false);
    expect(cohortFreshness(cohort, Date.UTC(2026, 9, 30, 12))).toEqual({
      stale: true,
      detail: 'Stale: 2 newer sessions are final, and this scan does not refresh',
    });
  });

  it('applies the 48h bound to crypto and says nothing without data or calendar', () => {
    const newest = Date.UTC(2026, 9, 27, 23, 59, 59, 999);
    const cohort = { assetClass: 'crypto' as const, dataAsOf: { oldest: newest, newest } };
    expect(cohortFreshness(cohort, newest + 48 * HOUR)?.stale).toBe(false);
    expect(cohortFreshness(cohort, newest + 48 * HOUR + 1)).toEqual({
      stale: true,
      detail: 'Stale: latest candle closed 48h 00m ago, past 48h',
    });
    expect(
      cohortFreshness({ assetClass: 'crypto', dataAsOf: { oldest: null, newest: null } }, 0),
    ).toBeNull();
    expect(
      cohortFreshness(
        { assetClass: 'equity', dataAsOf: { oldest: close27, newest: close27 } },
        Date.UTC(2099, 0, 1),
      ),
    ).toBeNull();
  });
});

describe('pineAlertNote', () => {
  const source: TradingViewDevSource = {
    tool: 'get_ohlcv',
    interval: '1D',
    retrieval: { startedAt: '2026-10-28T16:58:00.000Z', completedAt: '2026-10-28T17:00:00.000Z' },
    symbols: { AAPL: 'NASDAQ:AAPL' },
    notice: 'regular session only; prices are split-adjusted only.',
    selectionRule: 'Labeled fixture universe.',
    pineAlerts: { checkedAt: '2026-10-28T17:01:00.000Z', symbols: [] },
  };

  it('says only what was checked, and never calls a setup an alert', () => {
    expect(pineAlertNote(undefined, 'BTC-USD')).toMatch(/does not read TradingView alerts/);
    expect(pineAlertNote({ ...source, pineAlerts: null }, 'AAPL')).toBe(
      'TradingView alerts were not checked for this import.',
    );
    expect(pineAlertNote(source, 'MSFT')).toBe(
      'No TradingView symbol was recorded for this ticker.',
    );
    expect(pineAlertNote(source, 'AAPL')).toBe(
      'No TradingView alert existed on NASDAQ:AAPL when checked (28 Oct, 17:01 UTC), so Pine emitted nothing for it.',
    );
    const alerted = { ...source, pineAlerts: { ...source.pineAlerts!, symbols: ['NASDAQ:AAPL'] } };
    expect(pineAlertNote(alerted, 'AAPL')).toBe(
      'A TradingView alert exists on NASDAQ:AAPL. This scan cannot tell whether it fired.',
    );
  });
});
