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
  });
});
