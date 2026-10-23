import { useEffect, useRef } from 'react';
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  type UTCTimestamp,
} from 'lightweight-charts';
import { rsiAsync, smaAsync } from '@/lib/financeClient';

export interface CandlePoint {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ValuePoint {
  time: UTCTimestamp;
  value: number;
}

const UP_COLOR = '#61cb7c';
const DOWN_COLOR = '#f66d67';
const CROSSHAIR_COLOR = '#60ceef';
const GRID_COLOR = 'rgba(161, 161, 170, 0.1)';
const TEXT_COLOR = '#9f9fa9';
const SMA_50_COLOR = '#60ceef';
const SMA_200_COLOR = '#9d98f2';
const RSI_COLOR = '#a78bfa';
const RSI_HEIGHT = 90;
const PANE_GAP = 8;

export interface IndicatorToggles {
  sma50?: boolean;
  sma200?: boolean;
  rsi?: boolean;
}

// A failed worker calculation leaves that overlay empty; the candles still render.
function logIndicatorError(error: unknown): void {
  console.error('[LightweightChart] indicator calculation failed', error);
}

function toLineData(
  times: UTCTimestamp[],
  values: ArrayLike<number>,
): { time: UTCTimestamp; value: number }[] {
  const points: { time: UTCTimestamp; value: number }[] = [];
  const length = Math.min(times.length, values.length);
  for (let i = 0; i < length; i += 1) {
    const time = times[i];
    const value = values[i];
    if (time === undefined || value === undefined || Number.isNaN(value)) continue;
    points.push({ time, value });
  }
  return points;
}

/** Shared Terminal/Cyber chart options: dark, subtle grid, neon crosshair. */
function createBaseChart(container: HTMLElement, options?: { hideTimeScale?: boolean }): IChartApi {
  return createChart(container, {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: 'transparent' },
      textColor: TEXT_COLOR,
      fontFamily: "'JetBrains Mono', monospace",
    },
    grid: {
      vertLines: { color: GRID_COLOR },
      horzLines: { color: GRID_COLOR },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: {
        color: CROSSHAIR_COLOR,
        width: 1,
        style: LineStyle.Dashed,
        labelBackgroundColor: CROSSHAIR_COLOR,
      },
      horzLine: {
        color: CROSSHAIR_COLOR,
        width: 1,
        style: LineStyle.Dashed,
        labelBackgroundColor: CROSSHAIR_COLOR,
      },
    },
    rightPriceScale: { borderColor: GRID_COLOR },
    timeScale: options?.hideTimeScale
      ? { visible: false }
      : { borderColor: GRID_COLOR, timeVisible: true, secondsVisible: false },
  });
}

/**
 * High-performance Canvas candlestick chart (TradingView lightweight-charts)
 * with optional SMA (50/200) overlays and a synchronized RSI sub-chart.
 * The base chart is created once; toggles add/remove series without re-creating it.
 */
export function CandlestickChart({
  data,
  height = 276,
  indicators = {},
}: Readonly<{
  data: CandlePoint[];
  height?: number;
  indicators?: IndicatorToggles;
}>) {
  const mainContainerRef = useRef<HTMLDivElement | null>(null);
  const rsiContainerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candlesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const sma50Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const sma200Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const rsiChartRef = useRef<IChartApi | null>(null);
  const rsiSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const dataRef = useRef(data);

  const showRsi = !!indicators.rsi;
  const mainHeight = showRsi ? height - RSI_HEIGHT - PANE_GAP : height;

  // Create the base candlestick chart exactly once.
  useEffect(() => {
    const container = mainContainerRef.current;
    if (!container) return;

    const chart = createBaseChart(container);
    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      borderUpColor: UP_COLOR,
      borderDownColor: DOWN_COLOR,
      wickUpColor: UP_COLOR,
      wickDownColor: DOWN_COLOR,
    });

    chartRef.current = chart;
    candlesRef.current = series;

    return () => {
      chart.remove();
      chartRef.current = null;
      candlesRef.current = null;
    };
  }, []);

  // Refresh candles + any visible indicator data on every data change.
  useEffect(() => {
    dataRef.current = data;

    const chart = chartRef.current;
    if (!chart) return;

    candlesRef.current?.setData(data);
    chart.timeScale().fitContent();

    const times = data.map((candle) => candle.time);
    const closes = data.map((candle) => candle.close);
    let cancelled = false;

    (async () => {
      const [sma50Values, sma200Values, rsiValues] = await Promise.all([
        smaAsync(closes, 50),
        smaAsync(closes, 200),
        rsiAsync(closes, 14),
      ]);
      if (cancelled) return;
      sma50Ref.current?.setData(toLineData(times, sma50Values));
      sma200Ref.current?.setData(toLineData(times, sma200Values));
      rsiSeriesRef.current?.setData(toLineData(times, rsiValues));
      rsiChartRef.current?.timeScale().fitContent();
    })().catch(logIndicatorError);

    return () => {
      cancelled = true;
    };
  }, [data]);

  // Add/remove SMA overlays in response to toggles (base chart stays alive).
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const closes = dataRef.current.map((candle) => candle.close);
    const times = dataRef.current.map((candle) => candle.time);
    let cancelled = false;

    (async () => {
      if (indicators.sma50 && !sma50Ref.current) {
        const values = await smaAsync(closes, 50);
        if (cancelled) return;
        const series = chart.addSeries(LineSeries, {
          color: SMA_50_COLOR,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: true,
        });
        series.setData(toLineData(times, values));
        sma50Ref.current = series;
      } else if (!indicators.sma50 && sma50Ref.current) {
        chart.removeSeries(sma50Ref.current);
        sma50Ref.current = null;
      }

      if (indicators.sma200 && !sma200Ref.current) {
        const values = await smaAsync(closes, 200);
        if (cancelled) return;
        const series = chart.addSeries(LineSeries, {
          color: SMA_200_COLOR,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: true,
        });
        series.setData(toLineData(times, values));
        sma200Ref.current = series;
      } else if (!indicators.sma200 && sma200Ref.current) {
        chart.removeSeries(sma200Ref.current);
        sma200Ref.current = null;
      }
    })().catch(logIndicatorError);

    return () => {
      cancelled = true;
    };
  }, [indicators.sma50, indicators.sma200]);

  // Create/destroy the synchronized RSI sub-chart.
  useEffect(() => {
    if (!showRsi) {
      if (rsiChartRef.current) {
        rsiChartRef.current.remove();
        rsiChartRef.current = null;
        rsiSeriesRef.current = null;
      }
      return;
    }

    const rsiContainer = rsiContainerRef.current;
    const mainChart = chartRef.current;
    if (!rsiContainer || !mainChart || rsiChartRef.current) return;

    const rsiChart = createBaseChart(rsiContainer, { hideTimeScale: true });
    const rsiSeries = rsiChart.addSeries(LineSeries, {
      color: RSI_COLOR,
      lineWidth: 2,
      priceLineVisible: false,
    });
    rsiSeries.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });
    rsiSeries.createPriceLine({
      price: 70,
      color: 'rgba(139, 149, 167, 0.5)',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: false,
      title: '',
    });
    rsiSeries.createPriceLine({
      price: 30,
      color: 'rgba(139, 149, 167, 0.5)',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: false,
      title: '',
    });

    const closes = dataRef.current.map((candle) => candle.close);
    const times = dataRef.current.map((candle) => candle.time);
    let cancelled = false;

    rsiAsync(closes, 14)
      .then((values) => {
        if (!cancelled) rsiSeries.setData(toLineData(times, values));
      })
      .catch(logIndicatorError);

    const syncHandler = (range: LogicalRange | null) => {
      if (range) rsiChart.timeScale().setVisibleLogicalRange(range);
    };
    mainChart.timeScale().subscribeVisibleLogicalRangeChange(syncHandler);

    rsiChartRef.current = rsiChart;
    rsiSeriesRef.current = rsiSeries;

    return () => {
      cancelled = true;
      mainChart.timeScale().unsubscribeVisibleLogicalRangeChange(syncHandler);
    };
  }, [showRsi]);

  return (
    <div className="lwc-chart lwc-chart-stack" style={{ height }}>
      <div ref={mainContainerRef} className="lwc-chart-pane" style={{ height: mainHeight }} />
      {showRsi && (
        <div ref={rsiContainerRef} className="lwc-chart-pane" style={{ height: RSI_HEIGHT }} />
      )}
    </div>
  );
}

/**
 * Canvas area/line chart used for the portfolio backtest value curve.
 */
export function ValueAreaChart({
  data,
  compareData,
  height = 300,
}: Readonly<{
  data: ValuePoint[];
  /** Optional dashed overlay, e.g. a buy-and-hold benchmark. */
  compareData?: ValuePoint[];
  height?: number;
}>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);
  const compareRef = useRef<ISeriesApi<'Line'> | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createBaseChart(container);
    const series = chart.addSeries(AreaSeries, {
      lineColor: UP_COLOR,
      topColor: 'rgba(97, 203, 124, 0.2)',
      bottomColor: 'rgba(97, 203, 124, 0)',
      lineWidth: 2,
      priceLineVisible: false,
    });
    const compare = chart.addSeries(LineSeries, {
      color: TEXT_COLOR,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    chartRef.current = chart;
    seriesRef.current = series;
    compareRef.current = compare;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      compareRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;
    series.setData(data);
    compareRef.current?.setData(compareData ?? []);
    chart.timeScale().fitContent();
  }, [data, compareData]);

  return <div ref={containerRef} className="lwc-chart" style={{ height }} />;
}
