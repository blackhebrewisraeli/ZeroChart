import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BacktestChart } from '@/components/BacktestChart';
import type { Asset } from '@/lib/assets';
import type { BacktestResult } from '@/lib/backtestManager';
import { fetchHistoricalCandles } from '@/lib/binance';
import { computeBacktestAsync } from '@/lib/financeClient';
import type { Position } from '@/lib/portfolioManager';

// Keep the test hermetic: no canvas charts, no Binance network, no worker.
vi.mock('@/components/LightweightChart', () => ({
  ValueAreaChart: () => <div data-testid="value-area-chart" />,
}));

vi.mock('@/lib/binance', () => ({
  fetchHistoricalCandles: vi.fn(async () => [
    { timestamp: 1_700_000_000_000, open: 99, high: 102, low: 98, close: 100 },
    { timestamp: 1_700_086_400_000, open: 100, high: 112, low: 99, close: 110 },
  ]),
  isBinanceCrypto: (ticker: string) => ticker === 'BTC-USD',
}));

function makeResult(overrides: Partial<BacktestResult> = {}): BacktestResult {
  const points = [
    { timestamp: 1_700_000_000_000, value: 10000 },
    { timestamp: 1_700_086_400_000, value: 11500 },
  ];
  return {
    points,
    initialValue: 10000,
    finalValue: 11500,
    totalReturnPercent: 15,
    maxDrawdownPercent: 18.4,
    sharpeRatio: 1.87,
    coverageWeight: 1,
    coverage: [{ ticker: 'BTC-USD', weight: 1, status: 'covered' }],
    benchmarkReturnPct: 11.2,
    alphaPct: 3.8,
    winRatePct: 64,
    totalTrades: 11,
    benchmarkCurve: points,
    ...overrides,
  };
}

vi.mock('@/lib/financeClient', () => ({
  computeBacktestAsync: vi.fn(async () => makeResult()),
}));

beforeEach(() => {
  vi.mocked(computeBacktestAsync).mockClear();
  vi.mocked(fetchHistoricalCandles).mockClear();
});

const positions: Position[] = [
  {
    id: 'p1',
    ticker: 'BTC-USD',
    buyPrice: 60000,
    shares: 0.1,
    isSimulation: true,
    dateAdded: '2026-01-01',
  },
];

const assets: Asset[] = [
  {
    ticker: 'BTC-USD',
    name: 'Bitcoin',
    current_price: 67000,
    stable_signal: null,
    radar_signal: null,
    stable_explanation: null,
    radar_explanation: null,
    risk_pct: 0.03,
    reward_pct: 0.05,
    volume_spike: null,
    rsi_14: null,
    sma_50: null,
    sma_200: null,
    change_24h: null,
    updated_at: null,
  },
];

describe('BacktestChart risk metrics', () => {
  it('surfaces Max Drawdown and Sharpe Ratio after a simulation run', async () => {
    render(<BacktestChart positions={positions} assets={assets} />);

    fireEvent.click(screen.getByRole('button', { name: /simulate past year/i }));

    // Return summary keeps rendering alongside the new risk row.
    expect(await screen.findByText('1-Year Return')).toBeInTheDocument();
    expect(screen.getByText('+15.00%')).toBeInTheDocument();

    const riskRow = await screen.findByLabelText('Risk metrics');
    expect(riskRow).toBeInTheDocument();
    expect(screen.getByText('Max Drawdown')).toBeInTheDocument();
    expect(screen.getByText('-18.4%')).toBeInTheDocument();
    expect(screen.getByText('Sharpe Ratio')).toBeInTheDocument();
    expect(screen.getByText('1.87')).toBeInTheDocument();

    // Full coverage: cost disclosure shown, no partial-data banner (M1-T3).
    expect(
      screen.getByText('Net of 10 bps fee + 5 bps slippage on every fill.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Partial data/)).toBeNull();
    expect(screen.getByText(/Annualized, risk-free = 0$/)).toBeInTheDocument();
  });

  it('flags partial coverage with a warning and relabels risk stats', async () => {
    const aaplAsset: Asset = {
      ...assets[0]!,
      ticker: 'AAPL',
      name: 'Apple',
      current_price: 200,
    };
    const aaplPosition: Position = {
      id: 'p2',
      ticker: 'AAPL',
      buyPrice: 180,
      shares: 10,
      isSimulation: true,
      dateAdded: '2026-01-01',
    };
    // Simulate the engine reporting AAPL as uncovered (no Binance history).
    vi.mocked(computeBacktestAsync).mockResolvedValueOnce(
      makeResult({
        coverageWeight: 0.79,
        coverage: [
          { ticker: 'BTC-USD', weight: 0.79, status: 'covered' },
          { ticker: 'AAPL', weight: 0.21, status: 'missing' },
        ],
      }),
    );

    render(
      <BacktestChart positions={[...positions, aaplPosition]} assets={[...assets, aaplAsset]} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /simulate past year/i }));

    // The data gap is flagged, never silent (M1-T3, F-2.1a/b).
    const banner = await screen.findByText(/Partial data:/);
    expect(banner).toBeInTheDocument();
    expect(screen.getByText(/AAPL had no usable history/)).toBeInTheDocument();
    expect(screen.getByText(/Annualized, risk-free = 0 · partial data/)).toBeInTheDocument();
    // Non-crypto exclusion is disclosed up front too.
    expect(screen.getByText(/AAPL will be excluded and/)).toBeInTheDocument();
  });
});

describe('BacktestChart benchmark alpha and win rate', () => {
  it('shows positive alpha in green with a + and the Buy & Hold return', async () => {
    render(<BacktestChart positions={positions} assets={assets} />);
    fireEvent.click(screen.getByRole('button', { name: /simulate past year/i }));

    expect(await screen.findByText('Alpha vs. Hold')).toBeInTheDocument();
    expect(screen.getByText('+3.80%')).toHaveClass('backtest-risk-good');
    expect(screen.getByText('Buy & Hold +11.20%')).toBeInTheDocument();
    expect(screen.getByText('Win Rate')).toBeInTheDocument();
    expect(
      screen.getByText((_, element) => element?.textContent === '64% · 11 trades'),
    ).toBeInTheDocument();
  });

  it('shows underperformance in red without a + sign', async () => {
    vi.mocked(computeBacktestAsync).mockResolvedValueOnce(
      makeResult({ alphaPct: -4.5, benchmarkReturnPct: 19.5, winRatePct: 0, totalTrades: 1 }),
    );
    render(<BacktestChart positions={positions} assets={assets} />);
    fireEvent.click(screen.getByRole('button', { name: /simulate past year/i }));

    expect(await screen.findByText('-4.50%')).toHaveClass('backtest-risk-bad');
    expect(screen.getByText('Buy & Hold +19.50%')).toBeInTheDocument();
    expect(
      screen.getByText((_, element) => element?.textContent === '0% · 1 trade'),
    ).toBeInTheDocument();
  });
});

describe('BacktestChart friction and trailing-stop controls', () => {
  it('runs with realistic friction and OHLC history by default, no stop', async () => {
    render(<BacktestChart positions={positions} assets={assets} />);

    expect(screen.getByRole('switch', { name: /realistic friction/i })).toBeChecked();
    expect(screen.getByRole('combobox', { name: /trailing stop/i })).toHaveValue('off');

    fireEvent.click(screen.getByRole('button', { name: /simulate past year/i }));
    await screen.findByText('Alpha vs. Hold');

    expect(fetchHistoricalCandles).toHaveBeenCalledWith('BTC-USD', '1d', 365);
    const options = vi.mocked(computeBacktestAsync).mock.calls[0]?.[0];
    expect(options).toMatchObject({ feeBps: 10, slippageBps: 5, initialValue: 10000 });
    expect(options).not.toHaveProperty('trailingStopAtrMultiplier');
    expect(options).not.toHaveProperty('trailingStopPct');
    // High/low ride along so the engine can compute ATR(14).
    expect(options?.series[0]?.points[1]).toEqual({
      timestamp: 1_700_086_400_000,
      price: 110,
      high: 112,
      low: 99,
    });
  });

  it('re-runs from cached history when the stop or friction setting changes', async () => {
    render(<BacktestChart positions={positions} assets={assets} />);
    fireEvent.click(screen.getByRole('button', { name: /simulate past year/i }));
    await screen.findByText('Alpha vs. Hold');

    fireEvent.change(screen.getByRole('combobox', { name: /trailing stop/i }), {
      target: { value: 'atr' },
    });
    await waitFor(() => expect(computeBacktestAsync).toHaveBeenCalledTimes(2));
    expect(vi.mocked(computeBacktestAsync).mock.calls[1]?.[0]).toMatchObject({
      feeBps: 10,
      trailingStopAtrMultiplier: 2,
    });

    fireEvent.change(screen.getByRole('combobox', { name: /trailing stop/i }), {
      target: { value: 'pct' },
    });
    await waitFor(() => expect(computeBacktestAsync).toHaveBeenCalledTimes(3));
    expect(vi.mocked(computeBacktestAsync).mock.calls[2]?.[0]).toMatchObject({
      trailingStopPct: 5,
    });

    fireEvent.click(screen.getByRole('switch', { name: /realistic friction/i }));
    await waitFor(() => expect(computeBacktestAsync).toHaveBeenCalledTimes(4));
    const gross = vi.mocked(computeBacktestAsync).mock.calls[3]?.[0];
    expect(gross).not.toHaveProperty('feeBps');
    expect(gross).toMatchObject({ trailingStopPct: 5 });
    expect(await screen.findByText('Gross of fees and slippage.')).toBeInTheDocument();

    // History was fetched once; every setting change reused it.
    expect(fetchHistoricalCandles).toHaveBeenCalledTimes(1);
  });

  it('applies settings chosen before the first run without fetching early', () => {
    render(<BacktestChart positions={positions} assets={assets} />);
    fireEvent.change(screen.getByRole('combobox', { name: /trailing stop/i }), {
      target: { value: 'pct' },
    });

    expect(computeBacktestAsync).not.toHaveBeenCalled();
    expect(fetchHistoricalCandles).not.toHaveBeenCalled();
  });
});
