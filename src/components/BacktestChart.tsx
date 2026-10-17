import { useMemo, useRef, useState } from 'react';
import type { UTCTimestamp } from 'lightweight-charts';
import { History, Loader2, LockKeyhole } from 'lucide-react';
import { formatPrice, type Asset } from '@/lib/assets';
import { ValueAreaChart, type ValuePoint } from '@/components/LightweightChart';
import { PricingModal } from '@/components/PricingModal';
import { fetchHistoricalCandles, isBinanceCrypto } from '@/lib/binance';
import {
  REALISTIC_FRICTION,
  deriveWeights,
  type AssetPriceSeries,
  type BacktestOptions,
  type BacktestResult,
} from '@/lib/backtestManager';
import { computeBacktestAsync } from '@/lib/financeClient';
import { useAuth } from '@/lib/authStore';
import type { Position } from '@/lib/portfolioManager';
import { cn } from '@/lib/utils';

const INITIAL_INVESTMENT = 10000;

type StopMode = 'off' | 'atr' | 'pct';

interface Settings {
  friction: boolean;
  stopMode: StopMode;
}

const STOP_OPTIONS: Record<
  StopMode,
  { label: string; options: Pick<BacktestOptions, 'trailingStopAtrMultiplier' | 'trailingStopPct'> }
> = {
  off: { label: 'Off', options: {} },
  atr: { label: '2× ATR', options: { trailingStopAtrMultiplier: 2 } },
  pct: { label: '5% Trailing', options: { trailingStopPct: 5 } },
};

/** Signed percent rounded to cents, so "+0.00%" never shows up as a win. */
function signedPercent(value: number): string {
  const rounded = Number(value.toFixed(2));
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(2)}%`;
}

function alphaTone(alpha: number): string | undefined {
  const rounded = Number(alpha.toFixed(2));
  if (rounded > 0) return 'backtest-risk-good';
  if (rounded < 0) return 'backtest-risk-bad';
  return undefined;
}

/** Tones the simplified Sharpe ratio: ≥1 solid, 0–1 caution, ≤0 poor. */
function sharpeTone(sharpe: number): string {
  if (sharpe >= 1) return 'backtest-risk-good';
  if (sharpe > 0) return 'backtest-risk-caution';
  return 'backtest-risk-bad';
}

export function BacktestChart({ positions, assets }: { positions: Position[]; assets: Asset[] }) {
  const { isPro } = useAuth();
  const [pricingOpen, setPricingOpen] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [failedTickers, setFailedTickers] = useState<string[]>([]);
  const [settings, setSettings] = useState<Settings>({ friction: isPro, stopMode: 'off' });
  // Latest settings for a fetch that finishes after the user changed a control.
  const settingsRef = useRef(settings);
  // Last fetched history, so toggling a control re-runs without refetching.
  const seriesRef = useRef<AssetPriceSeries[] | null>(null);

  const weights = deriveWeights(positions, assets);
  const tickers = [...new Set(positions.map((position) => position.ticker))];
  const cryptoTickers = tickers.filter(isBinanceCrypto);
  const nonCryptoTickers = tickers.filter((ticker) => !isBinanceCrypto(ticker));
  const hasPositions = weights.length > 0;

  const valueData = useMemo<ValuePoint[]>(() => {
    if (!result) return [];
    return result.points.map((point) => ({
      time: Math.floor(point.timestamp / 1000) as UTCTimestamp,
      value: point.value,
    }));
  }, [result]);

  const benchmarkData = useMemo<ValuePoint[]>(() => {
    if (!result) return [];
    return result.benchmarkCurve.map((point) => ({
      time: Math.floor(point.timestamp / 1000) as UTCTimestamp,
      value: point.value,
    }));
  }, [result]);

  async function compute(series: AssetPriceSeries[], { friction, stopMode }: Settings) {
    const computed = await computeBacktestAsync({
      weights,
      series,
      initialValue: INITIAL_INVESTMENT,
      ...(friction ? REALISTIC_FRICTION : {}),
      ...STOP_OPTIONS[stopMode].options,
    });
    setResult(computed);
    setStatus('success');
  }

  function changeSettings(next: Settings) {
    settingsRef.current = next;
    setSettings(next);
    // Mid-fetch changes are picked up by `runSimulation` through the ref; a
    // previous compute error can still be recovered from cached history.
    const series = seriesRef.current;
    if (!series || status === 'loading') return;
    compute(series, next).catch(() => {
      setStatus('error');
      setErrorMessage("Couldn't run the simulation. Please try again.");
    });
  }

  async function runSimulation() {
    // A failed refetch must not leave stale history for later reruns.
    seriesRef.current = null;
    setStatus('loading');
    setErrorMessage(null);
    setFailedTickers([]);

    try {
      const settled = await Promise.allSettled(
        cryptoTickers.map(async (ticker): Promise<AssetPriceSeries> => {
          // Full OHLC so the trailing stop can size itself off ATR(14).
          const candles = await fetchHistoricalCandles(ticker, '1d', 365);
          return {
            ticker,
            points: candles.map((candle) => ({
              timestamp: candle.timestamp,
              price: candle.close,
              high: candle.high,
              low: candle.low,
            })),
          };
        }),
      );

      // Failed fetches are surfaced (M1-T3, F-2.1b), never silently dropped:
      // the engine marks them `missing` and holds their weight as cash.
      const series: AssetPriceSeries[] = [];
      const failed: string[] = [];
      settled.forEach((item, index) => {
        if (item.status === 'fulfilled') series.push(item.value);
        else failed.push(cryptoTickers[index] ?? 'unknown');
      });
      setFailedTickers(failed);

      if (cryptoTickers.length > 0 && series.length === 0) {
        setStatus('error');
        setErrorMessage("Couldn't load historical data. Please try again.");
        return;
      }

      seriesRef.current = series;
      await compute(series, settingsRef.current);
    } catch {
      setStatus('error');
      setErrorMessage("Couldn't load historical data. Please try again.");
    }
  }

  const returnTone = result && result.totalReturnPercent >= 0 ? 'up' : 'down';
  // Weighted tickers the engine could not back (no usable history) — flagged
  // explicitly instead of silently simulated at flat prices (F-2.1a/b).
  const missingCoverage = result?.coverage.filter((entry) => entry.status === 'missing') ?? [];
  const hasPartialData = missingCoverage.length > 0;

  return (
    <div className="backtest-card">
      <div className="backtest-head">
        <div>
          <span className="backtest-eyebrow">Historical Simulation</span>
          <p className="backtest-description">
            Replay the past year with your current allocation, starting from a $10,000 principal.
          </p>
        </div>
        <button
          type="button"
          className="backtest-button"
          onClick={runSimulation}
          disabled={status === 'loading' || !hasPositions}
        >
          {status === 'loading' ? (
            <Loader2 size={15} className="backtest-spinner" />
          ) : (
            <History size={15} />
          )}
          {status === 'loading' ? 'Simulating…' : 'Simulate Past Year'}
        </button>
      </div>

      {nonCryptoTickers.length > 0 && (
        <p className="backtest-note">
          Binance history only covers crypto. {nonCryptoTickers.join(', ')} will be excluded and
          held as cash in the simulation.
        </p>
      )}

      <div className="backtest-controls" aria-label="Simulation settings">
        <div className="backtest-control-row">
          <label className={cn('backtest-control', !isPro && 'is-locked')}>
            Realistic Friction
            <input
              type="checkbox"
              role="switch"
              className="backtest-toggle"
              checked={settings.friction}
              disabled={!isPro}
              onChange={(event) => changeSettings({ ...settings, friction: event.target.checked })}
            />
          </label>
          {!isPro && (
            <button
              type="button"
              className="backtest-pro-lock"
              onClick={() => setPricingOpen(true)}
              aria-label="Unlock Realistic Friction with Pro"
              title="Pro feature"
            >
              <LockKeyhole size={13} />
            </button>
          )}
        </div>
        <div className="backtest-control-row">
          <label className={cn('backtest-control', !isPro && 'is-locked')}>
            Trailing Stop
            <select
              className="backtest-select"
              value={settings.stopMode}
              disabled={!isPro}
              onChange={(event) =>
                changeSettings({ ...settings, stopMode: event.target.value as StopMode })
              }
            >
              {(Object.keys(STOP_OPTIONS) as StopMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {STOP_OPTIONS[mode].label}
                </option>
              ))}
            </select>
          </label>
          {!isPro && (
            <button
              type="button"
              className="backtest-pro-lock"
              onClick={() => setPricingOpen(true)}
              aria-label="Unlock Trailing Stop with Pro"
              title="Pro feature"
            >
              <LockKeyhole size={13} />
            </button>
          )}
        </div>
      </div>
      <p className="backtest-note">
        {settings.friction
          ? `Net of ${REALISTIC_FRICTION.feeBps} bps fee + ${REALISTIC_FRICTION.slippageBps} bps slippage on every fill.`
          : 'Gross of fees and slippage.'}
      </p>

      {status === 'success' && result && (
        <>
          <div
            className={cn(
              'backtest-summary',
              returnTone === 'up' ? 'backtest-summary-up' : 'backtest-summary-down',
            )}
          >
            <span className="backtest-summary-label">1-Year Return</span>
            <span className="backtest-summary-value">
              {result.totalReturnPercent >= 0 ? '+' : ''}
              {result.totalReturnPercent.toFixed(2)}%
            </span>
            <span className="backtest-summary-sub">
              {formatPrice(result.initialValue)} → {formatPrice(result.finalValue)}
            </span>
          </div>

          {hasPartialData && (
            <div className="backtest-coverage-warning" role="alert">
              <strong>Partial data:</strong>{' '}
              {missingCoverage
                .map(
                  (entry) =>
                    `${entry.ticker}${failedTickers.includes(entry.ticker) ? ' (fetch failed)' : ''}`,
                )
                .join(', ')}{' '}
              had no usable history — excluded and held as cash. Risk stats reflect the covered
              sleeve plus cash, not the missing holdings.
            </div>
          )}

          <div className="backtest-risk" aria-label="Risk metrics">
            <div className="backtest-risk-item">
              <span className="backtest-risk-label">Max Drawdown</span>
              <span className="backtest-risk-value backtest-risk-bad">
                {result.maxDrawdownPercent > 0 ? `-${result.maxDrawdownPercent.toFixed(1)}` : '0.0'}
                %
              </span>
              <span className="backtest-risk-sub">Peak-to-trough decline</span>
            </div>
            <div className="backtest-risk-item">
              <span className="backtest-risk-label">Sharpe Ratio</span>
              <span className={cn('backtest-risk-value', sharpeTone(result.sharpeRatio))}>
                {result.sharpeRatio.toFixed(2)}
              </span>
              <span className="backtest-risk-sub">
                Annualized, risk-free = 0{hasPartialData ? ' · partial data' : ''}
              </span>
            </div>
            <div className="backtest-risk-item">
              <span className="backtest-risk-label">Alpha vs. Hold</span>
              <span className={cn('backtest-risk-value', alphaTone(result.alphaPct))}>
                {signedPercent(result.alphaPct)}
              </span>
              <span className="backtest-risk-sub">
                Buy &amp; Hold {signedPercent(result.benchmarkReturnPct)}
              </span>
            </div>
            <div className="backtest-risk-item">
              <span className="backtest-risk-label">Win Rate</span>
              <span className="backtest-risk-value">
                {result.winRatePct.toFixed(0)}%
                <span className="backtest-risk-unit">
                  {' '}
                  · {result.totalTrades} {result.totalTrades === 1 ? 'trade' : 'trades'}
                </span>
              </span>
              <span className="backtest-risk-sub">Closed round trips, net of friction</span>
            </div>
          </div>

          {result.points.length > 0 ? (
            <div className="backtest-chart">
              <ValueAreaChart data={valueData} compareData={benchmarkData} height={276} />
            </div>
          ) : (
            <div className="backtest-empty">No historical data available for this portfolio.</div>
          )}
          {result.points.length > 0 && (
            <p className="backtest-note">Solid: strategy · Dashed: Buy &amp; Hold benchmark</p>
          )}
        </>
      )}

      {status === 'error' && <div className="backtest-empty">{errorMessage}</div>}

      {status !== 'success' && status !== 'error' && (
        <div className="backtest-empty">
          {hasPositions
            ? 'Press “Simulate Past Year” to replay the last 12 months.'
            : 'Add positions to run a historical simulation.'}
        </div>
      )}

      <PricingModal open={pricingOpen} onOpenChange={setPricingOpen} />
    </div>
  );
}
