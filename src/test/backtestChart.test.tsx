import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BacktestChart } from '@/components/BacktestChart';
import type { Asset } from '@/lib/assets';
import type { Position } from '@/lib/portfolioManager';

// Keep the test hermetic: no canvas charts, no Binance network, no worker.
vi.mock('@/components/LightweightChart', () => ({
  ValueAreaChart: () => <div data-testid="value-area-chart" />,
}));

vi.mock('@/lib/binance', () => ({
  fetchYearlyKlines: vi.fn(async () => [
    { timestamp: 1_700_000_000_000, close: 100 },
    { timestamp: 1_700_086_400_000, close: 110 },
  ]),
  isBinanceCrypto: (ticker: string) => ticker === 'BTC-USD',
}));

vi.mock('@/lib/financeClient', () => ({
  computeBacktestAsync: vi.fn(async () => ({
    points: [
      { timestamp: 1_700_000_000_000, value: 10000 },
      { timestamp: 1_700_086_400_000, value: 11500 },
    ],
    initialValue: 10000,
    finalValue: 11500,
    totalReturnPercent: 15,
    maxDrawdownPercent: 18.4,
    sharpeRatio: 1.87,
    coverageWeight: 1,
    coverage: [{ ticker: 'BTC-USD', weight: 1, status: 'covered' }],
  })),
}));

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
    expect(screen.getByText(/Net of 25 bps entry fee \+ 10 bps slippage/)).toBeInTheDocument();
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
    const { computeBacktestAsync } = await import('@/lib/financeClient');
    vi.mocked(computeBacktestAsync).mockResolvedValueOnce({
      points: [
        { timestamp: 1_700_000_000_000, value: 10000 },
        { timestamp: 1_700_086_400_000, value: 11500 },
      ],
      initialValue: 10000,
      finalValue: 11500,
      totalReturnPercent: 15,
      maxDrawdownPercent: 18.4,
      sharpeRatio: 1.87,
      coverageWeight: 0.79,
      coverage: [
        { ticker: 'BTC-USD', weight: 0.79, status: 'covered' },
        { ticker: 'AAPL', weight: 0.21, status: 'missing' },
      ],
    });

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
