import { useMemo, useState } from 'react';
import type { UTCTimestamp } from 'lightweight-charts';
import { History, Loader2 } from 'lucide-react';
import { formatPrice, type Asset } from '@/lib/assets';
import { ValueAreaChart, type ValuePoint } from '@/components/LightweightChart';
import { fetchYearlyKlines, isBinanceCrypto } from '@/lib/binance';
import {
  computeBacktest,
  deriveWeights,
  type AssetPriceSeries,
  type BacktestResult,
} from '@/lib/backtestManager';
import type { Position } from '@/lib/portfolioManager';
import { cn } from '@/lib/utils';

const INITIAL_INVESTMENT = 10000;

export function BacktestChart({ positions, assets }: { positions: Position[]; assets: Asset[] }) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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

      const series: AssetPriceSeries[] = [];
      for (const item of settled) {
        if (item.status === 'fulfilled') series.push(item.value);
      }

      if (cryptoTickers.length > 0 && series.length === 0) {
        setStatus('error');
        setErrorMessage("Couldn't load historical data. Please try again.");
        return;
      }

      const computed = computeBacktest({
        weights,
        series,
        initialValue: INITIAL_INVESTMENT,
      });
      setResult(computed);
      setStatus('success');
    } catch {
      setStatus('error');
      setErrorMessage("Couldn't load historical data. Please try again.");
    }
  }

  const returnTone = result && result.totalReturnPercent >= 0 ? 'up' : 'down';

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
          Binance history only covers crypto. {nonCryptoTickers.join(', ')} will be held flat in the
          simulation.
        </p>
      )}

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
