import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RoboAdvisor } from '@/components/RoboAdvisor';
import type { Asset } from '@/lib/assets';
import { PortfolioProvider } from '@/lib/portfolioStore';

// The results phase is the unit under test — stub the quant pipeline so the
// test proves the UI surfaces the Multi-Factor Score and the ATR sizing.
vi.mock('@/lib/roboAdvisor', () => ({
  buildQuantPortfolio: vi.fn(async () => [
    { ticker: 'BTC', weight: 0.6, allocatedAmount: 6000, score: 92, suggestedShares: 12.5 },
    { ticker: 'ETH', weight: 0.4, allocatedAmount: 4000, score: 78, suggestedShares: 40 },
  ]),
}));

function makeAsset(ticker: string, name: string, price: number): Asset {
  return {
    ticker,
    name,
    current_price: price,
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
  };
}

const assets = [makeAsset('BTC', 'Bitcoin', 67000), makeAsset('ETH', 'Ethereum', 3500)];

describe('RoboAdvisor results', () => {
  it('surfaces the Multi-Factor Score and ATR suggested position size', async () => {
    render(
      <PortfolioProvider>
        <RoboAdvisor assets={assets} />
      </PortfolioProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /build portfolio/i }));
    const dialog = await screen.findByRole('dialog');
    // F-6.1c: the engine is branded as what it is — deterministic, not "AI".
    expect(within(dialog).getByText('Quantitative Multi-Factor Engine')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /build portfolio/i }));

    // Multi-Factor score pills carry the model tooltip instead of the old
    // static signal score.
    const scorePills = await screen.findAllByTitle('Multi-Factor Score — RSI · MACD · ATR');
    expect(scorePills).toHaveLength(2);
    expect(scorePills[0]).toHaveTextContent('92');
    expect(scorePills[1]).toHaveTextContent('78');

    // Suggested position size per holding (ATR model, 2% risk).
    expect(screen.getAllByText('Suggested size')).toHaveLength(2);
    const sizeTooltips = screen.getAllByTitle(/Suggested position size/);
    expect(sizeTooltips).toHaveLength(2);
    expect(sizeTooltips[0]).toHaveTextContent('12.5 shares');
    expect(sizeTooltips[1]).toHaveTextContent('40 shares');

    // The results note explains the model behind the numbers.
    expect(screen.getByText(/Multi-Factor Score \(RSI · MACD · ATR\)/)).toBeInTheDocument();
  });
});
