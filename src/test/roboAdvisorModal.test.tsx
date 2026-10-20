import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { RoboAdvisor } from '@/components/RoboAdvisor';
import { FEE_RATE } from '@/components/TradeTicket';
import type { Asset } from '@/lib/assets';
import type { PortfolioContainer } from '@/lib/portfolioAccounting';
import { PortfolioProvider, usePortfolio } from '@/lib/portfolioStore';

const authState = vi.hoisted(() => ({ isPro: true }));

vi.mock('@/lib/authStore', () => ({
  useAuth: () => authState,
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// Lets a test make the engine reject one ticker's buy mid-invest.
const rejectBuyOf = vi.hoisted(() => ({ ticker: null as string | null }));
vi.mock('@/lib/portfolioAccounting', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/portfolioAccounting')>();
  return {
    ...actual,
    applyBuyTransaction: (...args: Parameters<typeof actual.applyBuyTransaction>) =>
      args[1].ticker === rejectBuyOf.ticker
        ? { ok: false as const, container: args[0], error: 'Simulated rejection' }
        : actual.applyBuyTransaction(...args),
  };
});

// The results phase is the unit under test — stub the quant pipeline so the
// test proves the UI surfaces the Multi-Factor Score and the ATR sizing.
vi.mock('@/lib/roboAdvisor', () => ({
  buildQuantPortfolio: vi.fn(async () => [
    {
      ticker: 'BTC',
      weight: 0.6,
      allocatedAmount: 6000,
      score: 92,
      suggestedShares: 12.5,
      regime: 'TRENDING',
      rationale: 'Bullish momentum (+0.8%) + calm volatility (1.2%) · Trending regime',
      components: {
        rsiScore: 80,
        momentumScore: 100,
        volatilityScore: 94,
        weights: { rsi: 0.3, momentum: 0.5, volatility: 0.2 },
      },
    },
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

beforeEach(() => {
  authState.isPro = true;
  localStorage.clear();
  rejectBuyOf.ticker = null;
  vi.mocked(toast.error).mockClear();
});

let sim: PortfolioContainer | undefined;
function SimProbe() {
  sim = usePortfolio().portfolios.long_term_sim;
  return null;
}

async function confirmInvest() {
  fireEvent.click(screen.getByRole('button', { name: /build portfolio/i }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: /build portfolio/i }));
  fireEvent.click(await screen.findByRole('button', { name: /simulate on paper desk/i }));
}

async function investOnce() {
  await confirmInvest();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

describe('RoboAdvisor invest', () => {
  it('funds sim cash, then books one fee-inclusive BUY per allocation', async () => {
    render(
      <PortfolioProvider>
        <RoboAdvisor assets={assets} />
        <SimProbe />
      </PortfolioProvider>,
    );

    await investOnce();

    expect(toast.error).not.toHaveBeenCalled();
    const ledger = sim!.transactions;
    expect(ledger.map((t) => [t.type, t.ticker])).toEqual([
      ['deposit', undefined],
      ['buy', 'BTC'],
      ['buy', 'ETH'],
    ]);
    expect(ledger[0]).toMatchObject({ amount: 10000, note: 'Quant Analyzer funding' });
    for (const [buy, allocated] of [
      [ledger[1]!, 6000],
      [ledger[2]!, 4000],
    ] as const) {
      expect(buy.fee).toBeCloseTo(buy.shares! * buy.price! * FEE_RATE, 9);
      expect(buy.amount).toBeLessThanOrEqual(allocated);
      expect(buy.amount).toBeGreaterThan(allocated - 0.01);
    }
    expect(ledger[1]!.price).toBe(67000);
    expect(ledger[2]!.price).toBe(3500);

    // Cash is the deposit minus exactly what the buys spent.
    expect(sim!.cashBalance).toBeCloseTo(10000 - ledger[1]!.amount - ledger[2]!.amount, 9);
    expect(sim!.cashBalance).toBeGreaterThanOrEqual(0);
    expect(sim!.positions.map((p) => [p.ticker, p.shares])).toEqual([
      ['BTC', ledger[1]!.shares],
      ['ETH', ledger[2]!.shares],
    ]);

    // Investing again merges into the same rows instead of duplicating them.
    await investOnce();
    expect(sim!.transactions.map((t) => t.type)).toEqual([
      'deposit',
      'buy',
      'buy',
      'deposit',
      'buy',
      'buy',
    ]);
    expect(sim!.positions.map((p) => p.ticker)).toEqual(['BTC', 'ETH']);
    expect(sim!.positions[0]!.shares).toBeCloseTo(ledger[1]!.shares! * 2, 8);
  });

  it('commits nothing and keeps the modal open when any buy is rejected', async () => {
    rejectBuyOf.ticker = 'ETH';
    render(
      <PortfolioProvider>
        <RoboAdvisor assets={assets} />
        <SimProbe />
      </PortfolioProvider>,
    );
    const before = structuredClone(sim);

    await confirmInvest();

    expect(toast.error).toHaveBeenCalledWith('Simulated rejection');
    expect(document.querySelector('.robo-overlay')).not.toHaveClass('is-closing');
    // The deposit and the BTC buy that ran before ETH are rolled back too.
    expect(sim).toEqual(before);
  });
});

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

    // White-box breakdown: regime badge, one-line thesis, and factor sub-scores.
    expect(screen.getByText('Trending')).toHaveAttribute('data-regime', 'TRENDING');
    expect(
      screen.getByText('Bullish momentum (+0.8%) + calm volatility (1.2%) · Trending regime'),
    ).toBeInTheDocument();
    expect(screen.getByTitle('Momentum sub-score · 50% weight')).toHaveTextContent('MACD 100');

    // The results note explains the model behind the numbers.
    expect(screen.getByText(/Multi-Factor Score \(RSI · MACD · ATR\)/)).toBeInTheDocument();
  });

  it('blurs quant insights for Basic users and opens the Pro offer', async () => {
    authState.isPro = false;
    render(
      <PortfolioProvider>
        <RoboAdvisor assets={assets} />
      </PortfolioProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /build portfolio/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /build portfolio/i }));

    const unlock = await screen.findByRole('button', {
      name: /upgrade to unlock quant insights/i,
    });
    expect(unlock.previousElementSibling).toHaveClass('is-locked');

    fireEvent.click(unlock);
    expect(await screen.findByText('Unlock the full quant stack')).toBeInTheDocument();
    expect(screen.getByText('Market Regime Detection')).toBeInTheDocument();
  });

  it('Escape closes only the Pro offer and keeps the generated results', async () => {
    authState.isPro = false;
    render(
      <PortfolioProvider>
        <RoboAdvisor assets={assets} />
      </PortfolioProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /build portfolio/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /build portfolio/i }));
    fireEvent.click(
      await screen.findByRole('button', { name: /upgrade to unlock quant insights/i }),
    );
    const offer = await screen.findByText('Unlock the full quant stack');

    fireEvent.keyDown(offer, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByText('Unlock the full quant stack')).toBeNull());
    // closeModal animates out before unmounting, so assert it never started.
    expect(document.querySelector('.robo-overlay')).not.toHaveClass('is-closing');
    expect(screen.getAllByText('Suggested size')).toHaveLength(2);
  });
});
