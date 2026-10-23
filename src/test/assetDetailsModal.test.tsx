import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetDetailsModal } from '@/components/AssetDetailsModal';
import type { Asset } from '@/lib/assets';
import { evaluateCandles, type CanonicalResult } from '@/lib/canonicalModel';
import { okResult, STRONG_INPUTS } from './canonicalFixtures';

const engine = vi.hoisted(() => ({ scores: new Map<string, CanonicalResult>() }));
vi.mock('@/hooks/useCanonicalScores', () => ({ useCanonicalScores: () => engine.scores }));

vi.mock('@/lib/authStore', () => ({ useAuth: () => ({ isPro: true }) }));

// Keep the test hermetic: no canvas chart, no Binance network, no worker.
vi.mock('@/components/LightweightChart', () => ({
  CandlestickChart: () => <div data-testid="quant-chart" />,
}));

vi.mock('@/lib/binance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/binance')>()),
  fetchHistoricalCandles: vi.fn(async () => [
    { timestamp: 1_700_000_000_000, open: 99, high: 102, low: 98, close: 100 },
  ]),
}));

function makeAsset(ticker: string): Asset {
  return {
    ticker,
    name: ticker,
    current_price: 100,
    stable_signal: null,
    radar_signal: null,
    stable_explanation: null,
    radar_explanation: null,
    risk_pct: 0.03,
    reward_pct: 0.05,
    volume_spike: null,
    rsi_14: 55,
    sma_50: null,
    sma_200: null,
    change_24h: 1.2,
    updated_at: null,
  };
}

beforeEach(() => {
  engine.scores = new Map([
    ['BTC', okResult(STRONG_INPUTS)],
    ['AAPL', evaluateCandles([])],
  ]);
});

describe('AssetDetailsModal quant breakdown', () => {
  it('shows the canonical Signal Score and ATR size when the engine has a score', () => {
    render(<AssetDetailsModal asset={makeAsset('BTC')} onClose={() => {}} />);

    const score = okResult(STRONG_INPUTS).signal_score;
    expect(screen.getByTitle('Signal Score (0–100)')).toHaveTextContent(String(score));
    expect(screen.getByText(/ATR position size/)).toBeInTheDocument();
    expect(screen.queryByText('Not Enough Data')).not.toBeInTheDocument();
  });

  it('shows a Not Enough Data badge instead of a score when the engine has too few candles', () => {
    render(<AssetDetailsModal asset={makeAsset('AAPL')} onClose={() => {}} />);

    expect(screen.getByText('Not Enough Data')).toBeInTheDocument();
    expect(screen.getByText(/needs 34 daily candles to score AAPL and has 0/)).toBeInTheDocument();
    expect(screen.queryByTitle('Signal Score (0–100)')).not.toBeInTheDocument();
    expect(screen.queryByText(/ATR position size/)).not.toBeInTheDocument();
  });

  it('says it is computing while the engine result is loading', () => {
    engine.scores = new Map();
    render(<AssetDetailsModal asset={makeAsset('BTC')} onClose={() => {}} />);
    expect(screen.getByText('Computing signal…')).toBeInTheDocument();
  });
});

describe('AssetDetailsModal chart mode', () => {
  it('switches between ZeroChart Quant and TradingView Pro, keeping the quant breakdown', async () => {
    render(<AssetDetailsModal asset={makeAsset('BTC')} onClose={() => {}} />);

    const quantTab = screen.getByRole('tab', { name: 'ZeroChart Quant' });
    const tvTab = screen.getByRole('tab', { name: 'TradingView Pro' });
    expect(quantTab).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByTestId('quant-chart')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Technical indicators' })).toBeInTheDocument();

    fireEvent.click(tvTab);
    expect(tvTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('quant-chart')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Technical indicators' })).not.toBeInTheDocument();
    expect(screen.getByTestId('tradingview-placeholder')).toHaveTextContent('BINANCE:BTCUSDT');
    expect(screen.getByText('Model Signal Score')).toBeInTheDocument();
    expect(await screen.findByText(/ATR position size/)).toBeInTheDocument();
    // The placeholder never loads TradingView's script under test.
    expect(document.querySelector('script[src*="tradingview"]')).toBeNull();

    fireEvent.click(quantTab);
    expect(screen.getByTestId('quant-chart')).toBeInTheDocument();
    expect(screen.queryByTestId('tradingview-placeholder')).not.toBeInTheDocument();
  });

  it('opens equities on TradingView Pro, since quant candles are crypto-only', () => {
    render(<AssetDetailsModal asset={makeAsset('AAPL')} onClose={() => {}} />);

    expect(screen.getByRole('tab', { name: 'TradingView Pro' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('tradingview-placeholder')).toHaveTextContent('NASDAQ:AAPL');
  });

  it('opens the TradingView Pine export pre-filled with Pro portfolio capital', () => {
    render(
      <AssetDetailsModal asset={makeAsset('BTC')} onClose={() => {}} portfolioCapital={50_000} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'TradingView Indicator' }));
    expect(
      screen.getByRole('dialog', { name: 'ZeroChart Quant HUD for TradingView' }),
    ).toBeVisible();
    expect(screen.getByText(/pre-filled from your portfolio: \$50,000\.00/)).toBeInTheDocument();
  });
});
