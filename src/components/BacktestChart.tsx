import { useMemo, useState } from 'react';
import { History, Loader2 } from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatPrice, type Asset } from '@/lib/assets';
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

interface ChartPoint {
  timestamp: number;
  label: string;
  value: number;
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(timestamp);
}

function formatFullDate(timestamp: number): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(timestamp);
}

function BacktestTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: ChartPoint }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0]?.payload;
  if (!point) return null;
  return (
    <div className="backtest-tooltip">
      <span className="backtest-tooltip-date">{formatFullDate(point.timestamp)}</span>
      <span className="backtest-tooltip-value">{formatPrice(point.value)}</span>
    </div>
  );
}

export function BacktestChart({ positions, assets }: { positions: Position[]; assets: Asset[] }) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const weights = deriveWeights(positions, assets);
  const tickers = [...new Set(positions.map((position) => position.ticker))];
  const cryptoTickers = tickers.filter(isBinanceCrypto);
  const nonCryptoTickers = tickers.filter((ticker) => !isBinanceCrypto(ticker));
  const hasPositions = weights.length > 0;

  const chartData = useMemo<ChartPoint[]>(() => {
    if (!result) return [];
    return result.points.map((point) => ({
      timestamp: point.timestamp,
      label: formatDate(point.timestamp),
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
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 12, right: 8, left: 8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="backtestGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop
                        offset="5%"
                        style={{ stopColor: 'var(--signal-green)', stopOpacity: 0.35 }}
                      />
                      <stop
                        offset="95%"
                        style={{ stopColor: 'var(--signal-green)', stopOpacity: 0 }}
                      />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={28} />
                  <YAxis hide domain={['auto', 'auto']} />
                  <Tooltip content={<BacktestTooltip />} />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke="var(--signal-green)"
                    strokeWidth={2}
                    fill="url(#backtestGradient)"
                    dot={false}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
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
