import { useEffect, useRef } from 'react';
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';

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

const UP_COLOR = '#00ff41';
const DOWN_COLOR = '#ff003c';
const CROSSHAIR_COLOR = '#00E5FF';
const GRID_COLOR = 'rgba(139, 149, 167, 0.14)';
const TEXT_COLOR = '#8b95a7';

/** Shared Terminal/Cyber chart options: dark, subtle grid, neon crosshair. */
function createBaseChart(container: HTMLElement): IChartApi {
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
    timeScale: { borderColor: GRID_COLOR, timeVisible: true, secondsVisible: false },
  });
}

/**
 * High-performance Canvas candlestick chart (TradingView lightweight-charts).
 * Supports native pan/zoom and fluid resizing via `autoSize`.
 */
export function CandlestickChart({ data, height = 300 }: { data: CandlePoint[]; height?: number }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

  useEffect(() => {
    const container = containerRef.current;
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
    seriesRef.current = series;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;
    series.setData(data);
    chart.timeScale().fitContent();
  }, [data]);

  return <div ref={containerRef} className="lwc-chart" style={{ height }} />;
}

/**
 * Canvas area/line chart used for the portfolio backtest value curve.
 */
export function ValueAreaChart({ data, height = 300 }: { data: ValuePoint[]; height?: number }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createBaseChart(container);
    const series = chart.addSeries(AreaSeries, {
      lineColor: UP_COLOR,
      topColor: 'rgba(0, 255, 65, 0.28)',
      bottomColor: 'rgba(0, 255, 65, 0)',
      lineWidth: 2,
      priceLineVisible: false,
    });

    chartRef.current = chart;
    seriesRef.current = series;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;
    series.setData(data);
    chart.timeScale().fitContent();
  }, [data]);

  return <div ref={containerRef} className="lwc-chart" style={{ height }} />;
}
