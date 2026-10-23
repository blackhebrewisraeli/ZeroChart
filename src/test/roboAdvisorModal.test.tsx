import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { RoboAdvisor } from '@/components/RoboAdvisor';
import { FEE_RATE } from '@/components/TradeTicket';
import type { Asset } from '@/lib/assets';
import type { PortfolioContainer } from '@/lib/portfolioAccounting';
import { PortfolioProvider, usePortfolio } from '@/lib/portfolioStore';
import { buildQuantPortfolio } from '@/lib/roboAdvisor';

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
vi.mock('@/lib/roboAdvisor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/roboAdvisor')>();
  return {
    ...actual,
    buildQuantPortfolio: vi.fn(async () => [
      {
        ticker: 'BTC',
        weight: 0.6,
        allocatedAmount: 6000,
        score: 92,
        suggestedShares: 0.05,
        regime: 'TRENDING',
        rationale: 'Bullish momentum (+0.8%) + calm volatility (1.2%) · Trending regime',
        components: {
          rsiScore: 80,
          momentumScore: 100,
          volatilityScore: 94,
          weights: { rsi: 0.3, momentum: 0.5, volatility: 0.2 },
        },
      },
      { ticker: 'ETH', weight: 0.4, allocatedAmount: 4000, score: 78, suggestedShares: 0.5 },
    ]),
  };
});

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
  vi.mocked(buildQuantPortfolio).mockClear();
});

let sim: PortfolioContainer | undefined;
let paper: PortfolioContainer | undefined;
function SimProbe() {
  const portfolios = usePortfolio().portfolios;
  sim = portfolios.long_term_sim;
  paper = portfolios.paper_trading;
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
  // The receipt stays up until the user leaves it.
  expect(await screen.findByText(/Booked 2 orders in one transaction/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

describe('RoboAdvisor invest', () => {
  it('uses existing Paper Cash and never exceeds the ATR suggested shares', async () => {
    render(
      <PortfolioProvider>
        <RoboAdvisor assets={assets} />
        <SimProbe />
      </PortfolioProvider>,
    );

    await investOnce();

    expect(toast.error).not.toHaveBeenCalled();
    expect(sim!.transactions).toEqual([]);
    const ledger = paper!.transactions;
    expect(ledger.map((t) => [t.type, t.ticker])).toEqual([
      ['buy', 'BTC'],
      ['buy', 'ETH'],
    ]);
    expect(ledger[0]).toMatchObject({ shares: 0.05, price: 67000 });
    expect(ledger[1]).toMatchObject({ shares: 0.5, price: 3500 });
    for (const buy of ledger) {
      expect(buy.fee).toBeCloseTo(buy.shares! * buy.price! * FEE_RATE, 9);
    }

    expect(paper!.cashBalance).toBeCloseTo(100000 - ledger[0]!.amount - ledger[1]!.amount, 9);
    expect(paper!.positions.map((p) => [p.ticker, p.shares])).toEqual([
      ['BTC', 0.05],
      ['ETH', 0.5],
    ]);

    // Investing again merges into the same rows instead of duplicating them.
    await investOnce();
    expect(paper!.transactions.map((t) => t.type)).toEqual(['buy', 'buy', 'buy', 'buy']);
    expect(paper!.positions.map((p) => p.ticker)).toEqual(['BTC', 'ETH']);
    expect(paper!.positions[0]!.shares).toBeCloseTo(0.1, 8);
  });

  it('commits nothing and keeps the modal open when any buy is rejected', async () => {
    rejectBuyOf.ticker = 'ETH';
    render(
      <PortfolioProvider>
        <RoboAdvisor assets={assets} />
        <SimProbe />
      </PortfolioProvider>,
    );
    const before = structuredClone(paper);

    await confirmInvest();

    expect(await screen.findByText('Not booked: Simulated rejection')).toBeVisible();
    expect(document.querySelector('.robo-overlay')).not.toHaveClass('is-closing');
    // Preflight rejects the batch before the first Paper Trading row is booked.
    expect(paper).toEqual(before);
  });

  it('keeps the outcome of a Confirm clicked before React runs its effects', async () => {
    // CI's timing: Confirm is clicked the moment the results commit, before
    // React flushes that render's effects. A reset in an effect then erased
    // the refusal the click had just recorded.
    rejectBuyOf.ticker = 'ETH';
    render(
      <PortfolioProvider>
        <RoboAdvisor assets={assets} />
      </PortfolioProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /build portfolio/i }));
    const dialog = await screen.findByRole('dialog');

    const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined };
    const previous = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      const clicked = new Promise<void>((resolve) => {
        const observer = new MutationObserver(() => {
          const confirm = screen.queryByRole('button', { name: /simulate on paper desk/i });
          if (confirm instanceof HTMLButtonElement && !confirm.disabled) {
            observer.disconnect();
            confirm.click();
            resolve();
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
      });
      within(dialog)
        .getByRole('button', { name: /build portfolio/i })
        .click();
      await clicked;
      expect(await screen.findByText('Not booked: Simulated rejection')).toBeVisible();
    } finally {
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = previous;
    }
  });

  it('refuses to build with more than the actual available Paper Cash', async () => {
    render(
      <PortfolioProvider>
        <RoboAdvisor assets={assets} />
        <SimProbe />
      </PortfolioProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /build portfolio/i }));
    const dialog = await screen.findByRole('dialog');
    const amount = within(dialog).getByRole('textbox', { name: /paper cash to allocate/i });
    fireEvent.change(amount, { target: { value: '200000' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /build portfolio/i }));

    expect(await within(dialog).findByText(/available Paper Cash is \$100,000\.00/i)).toBeVisible();
    expect(buildQuantPortfolio).not.toHaveBeenCalled();
  });
});

describe('RoboAdvisor results', () => {
  it('explains a legitimate no-eligibility result without changing the selected profile', async () => {
    vi.mocked(buildQuantPortfolio).mockImplementationOnce(async (options) => {
      options.onDiagnostics?.({
        totalCandidates: 2,
        eligible: 0,
        insufficientData: 0,
        networkFailures: 0,
        belowMinimumScore: 2,
        highVolatility: 0,
        nonPositiveMomentum: 0,
      });
      return [];
    });
    render(
      <PortfolioProvider>
        <RoboAdvisor assets={assets} />
      </PortfolioProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /build portfolio/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /build portfolio/i }));

    expect(await within(dialog).findByText('No qualifying assets')).toBeVisible();
    expect(within(dialog).getByText('Moderate')).toBeVisible();
    expect(within(dialog).getByText('60 / 100')).toBeVisible();
    expect(within(dialog).getByText(/This can be a normal result/)).toBeVisible();
    expect(within(dialog).getByText(/Paper Cash is unchanged/)).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: /review configuration/i }));
    expect(within(dialog).getByRole('radio', { name: /Moderate/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('separates a candle-history network failure from no qualifying assets', async () => {
    vi.mocked(buildQuantPortfolio).mockImplementationOnce(async (options) => {
      options.onDiagnostics?.({
        totalCandidates: 2,
        eligible: 0,
        insufficientData: 0,
        networkFailures: 2,
        belowMinimumScore: 0,
        highVolatility: 0,
        nonPositiveMomentum: 0,
      });
      return [];
    });
    render(
      <PortfolioProvider>
        <RoboAdvisor assets={assets} />
      </PortfolioProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /build portfolio/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /build portfolio/i }));

    expect(await within(dialog).findByText('Market history unavailable')).toBeVisible();
    expect(within(dialog).queryByText('No qualifying assets')).toBeNull();
    expect(within(dialog).getByRole('button', { name: /retry analysis/i })).toBeEnabled();
  });

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
    expect(sizeTooltips[0]).toHaveTextContent('0.05 shares');
    expect(sizeTooltips[1]).toHaveTextContent('0.5 shares');

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
