import { useMemo, useState } from 'react';
import type { UTCTimestamp } from 'lightweight-charts';
import { History, Loader2 } from 'lucide-react';
import { formatPrice, type Asset } from '@/lib/assets';
import { ValueAreaChart, type ValuePoint } from '@/components/LightweightChart';
import { fetchYearlyKlines, isBinanceCrypto } from '@/lib/binance';
import {
  DEFAULT_BACKTEST_COST_MODEL,
  deriveWeights,
  type AssetPriceSeries,
  type BacktestResult,
} from '@/lib/backtestManager';
import { computeBacktestAsync } from '@/lib/financeClient';
import type { Position } from '@/lib/portfolioManager';
import { cn } from '@/lib/utils';

const INITIAL_INVESTMENT = 10000;

// Display labels for the entry-cost model applied by the engine (M1-T3, F-2.1c).
const FEE_BPS = Math.round(DEFAULT_BACKTEST_COST_MODEL.feeRate * 10000);
const SLIPPAGE_BPS = Math.round(DEFAULT_BACKTEST_COST_MODEL.slippageRate * 10000);

/** Tones the simplified Sharpe ratio: ≥1 solid, 0–1 caution, ≤0 poor. */
function sharpeTone(sharpe: number): string {
  if (sharpe >= 1) return 'backtest-risk-good';
  if (sharpe > 0) return 'backtest-risk-caution';
  return 'backtest-risk-bad';
}

export function BacktestChart({ positions, assets }: { positions: Position[]; assets: Asset[] }) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [failedTickers, setFailedTickers] = useState<string[]>([]);

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

  async function runSimulation() {
    setStatus('loading');
    setErrorMessage(null);
    setFailedTickers([]);

    try {
      const settled = await Promise.allSettled(
        cryptoTickers.map(async (ticker): Promise<AssetPriceSeries> => {
          const klines = await fetchYearlyKlines(ticker);
          return {
            ticker,
            points: klines.map((kline) => ({ timestamp: kline.timestamp, price: kline.close })),
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

      const computed = await computeBacktestAsync({
        weights,
        series,
        initialValue: INITIAL_INVESTMENT,
        costModel: DEFAULT_BACKTEST_COST_MODEL,
      });
      setResult(computed);
      setStatus('success');
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
      <p className="backtest-note">
        Net of {FEE_BPS} bps entry fee + {SLIPPAGE_BPS} bps slippage on invested capital.
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
          </div>

          {result.points.length > 0 ? (
            <div className="backtest-chart">
              <ValueAreaChart data={valueData} height={276} />
            </div>
          ) : (
            <div className="backtest-empty">No historical data available for this portfolio.</div>
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
    </div>
  );
}
