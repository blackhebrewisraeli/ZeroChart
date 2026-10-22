import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { UTCTimestamp } from 'lightweight-charts';
import { LineChart } from 'lucide-react';
import { Segmented, type SegmentOption } from '@/components/Segmented';
import { TradingViewWidget } from '@/components/TradingViewWidget';
import {
  CandlestickChart,
  type CandlePoint,
  type IndicatorToggles,
} from '@/components/LightweightChart';
import { fetchHistoricalCandles, isBinanceCrypto, type Candle } from '@/lib/binance';
import { toTradingViewSymbol } from '@/lib/tradingViewSymbol';
import { cn } from '@/lib/utils';

const INDICATOR_OPTIONS = [
  { key: 'sma50', label: 'SMA 50' },
  { key: 'sma200', label: 'SMA 200' },
  { key: 'rsi', label: 'RSI' },
] as const;

type ChartMode = 'quant' | 'tradingview';

const CHART_MODES: SegmentOption<ChartMode>[] = [
  { value: 'quant', label: 'ZeroChart Quant' },
  { value: 'tradingview', label: 'TradingView Pro' },
];

/**
 * ZeroChart Quant (Binance daily candles + indicators, crypto only) ↔
 * TradingView Pro (theme-synced embed) chart switcher, shared by the asset
 * details modal and the Paper Trading terminal. Key it by ticker to reset the
 * mode when the symbol changes.
 */
export function AssetChart({
  ticker,
  quantHeight = 276,
  actions,
}: Readonly<{
  ticker: string;
  quantHeight?: number;
  /** Extra controls shown beside the chart-mode toggle. */
  actions?: ReactNode;
}>) {
  const isCrypto = isBinanceCrypto(ticker);
  // Our own candles are crypto-only, so other assets open on TradingView.
  const [chartMode, setChartMode] = useState<ChartMode>(isCrypto ? 'quant' : 'tradingview');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [candles, setCandles] = useState<Candle[]>([]);
  const [indicators, setIndicators] = useState<IndicatorToggles>({
    sma50: true,
    sma200: false,
    rsi: false,
  });

  useEffect(() => {
    if (!isCrypto) {
      setStatus('idle');
      setCandles([]);
      return;
    }
    let cancelled = false;
    setStatus('loading');
    fetchHistoricalCandles(ticker)
      .then((data) => {
        if (cancelled) return;
        setCandles(data);
        setStatus('success');
      })
      .catch(() => {
        if (cancelled) return;
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [ticker, isCrypto]);

  const candleData = useMemo<CandlePoint[]>(
    () =>
      candles.map((candle) => ({
        time: Math.floor(candle.timestamp / 1000) as UTCTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      })),
    [candles],
  );

  let chart: ReactNode;
  if (chartMode === 'tradingview') {
    chart = <TradingViewWidget symbol={toTradingViewSymbol(ticker)} />;
  } else if (!isCrypto) {
    chart = (
      <div className="asset-chart-fallback">
        <LineChart size={22} />
        <span>
          Quant charts are available for crypto assets. Switch to TradingView Pro for live charts.
        </span>
      </div>
    );
  } else if (status === 'loading') {
    chart = <div className="asset-chart-fallback">Loading historical data…</div>;
  } else if (status === 'error') {
    chart = (
      <div className="asset-chart-fallback">
        <LineChart size={22} />
        <span>Couldn't load chart data. Please try again.</span>
      </div>
    );
  } else {
    chart = <CandlestickChart data={candleData} height={quantHeight} indicators={indicators} />;
  }

  return (
    <>
      <div className="chart-mode-bar">
        <Segmented
          value={chartMode}
          options={CHART_MODES}
          onChange={setChartMode}
          ariaLabel="Chart mode"
        />
        {actions}
      </div>

      {chartMode === 'quant' && isCrypto && status === 'success' && (
        <div className="indicator-toggles" role="group" aria-label="Technical indicators">
          {INDICATOR_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              className={cn('indicator-pill', indicators[option.key] && 'is-active')}
              aria-pressed={indicators[option.key]}
              onClick={() =>
                setIndicators((prev) => ({ ...prev, [option.key]: !prev[option.key] }))
              }
            >
              {option.label}
            </button>
          ))}
        </div>
      )}

      <section
        className={cn('asset-details-chart', chartMode === 'tradingview' && 'is-tradingview')}
        aria-label={`${ticker} historical chart`}
      >
        {chart}
      </section>

      <p className="asset-chart-source">
        {chartMode === 'tradingview'
          ? 'Chart: TradingView live market data'
          : 'Data: Binance public REST API · Daily candles (30 days)'}
      </p>
    </>
  );
}
