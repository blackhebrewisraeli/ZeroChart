import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyBuyTransaction,
  applySellTransaction,
  computePortfolioValuation,
  type PortfolioContainer,
} from '@/lib/portfolioAccounting';
import { PortfolioProvider, usePortfolio, type PortfolioStateV3 } from '@/lib/portfolioStore';

function emptyContainer(
  type: PortfolioContainer['type'] = 'paper_trading',
  cashBalance = 5_000,
): PortfolioContainer {
  return {
    type,
    positions: [],
    cashBalance,
    cashLedger: [],
    transactions: [],
    realizedPnl: 0,
  };
}

describe('portfolio accounting', () => {
  it('aggregates multiple buy lots at their weighted-average cost without mutating input', () => {
    const initial = emptyContainer();
    const first = applyBuyTransaction(initial, {
      ticker: ' aapl ',
      name: 'Apple',
      shares: 10,
      price: 100,
      fee: 2,
      slippage: 3,
      timestamp: '2026-01-01T00:00:00.000Z',
      transactionId: 'buy-1',
      lotId: 'lot-1',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = applyBuyTransaction(first.container, {
      ticker: 'AAPL',
      shares: 5,
      price: 130,
      timestamp: '2026-02-01T00:00:00.000Z',
      transactionId: 'buy-2',
      lotId: 'lot-2',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(initial).toEqual(emptyContainer());
    expect(second.container.positions).toHaveLength(1);
    expect(second.container.positions[0]).toMatchObject({
      ticker: 'AAPL',
      shares: 15,
      buyPrice: 110,
    });
    expect(second.container.positions[0]?.lots).toEqual([
      {
        id: 'lot-1',
        shares: 10,
        buyPrice: 100,
        feePaid: 5,
        acquiredAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'lot-2',
        shares: 5,
        buyPrice: 130,
        acquiredAt: '2026-02-01T00:00:00.000Z',
      },
    ]);
    expect(second.container.cashBalance).toBe(3_345);
    expect(second.container.transactions.map((transaction) => transaction.amount)).toEqual([
      1_005, 650,
    ]);
  });

  it('sells FIFO across partial and full lots with exact fees, slippage, and realized P&L', () => {
    const withLots: PortfolioContainer = {
      ...emptyContainer('paper_trading', 0),
      positions: [
        {
          id: 'position-aapl',
          ticker: 'AAPL',
          name: 'Apple',
          shares: 15,
          buyPrice: 110,
          isSimulation: true,
          dateAdded: '2026-01-01T00:00:00.000Z',
          lots: [
            {
              id: 'lot-1',
              shares: 10,
              buyPrice: 100,
              acquiredAt: '2026-01-01T00:00:00.000Z',
            },
            {
              id: 'lot-2',
              shares: 5,
              buyPrice: 130,
              acquiredAt: '2026-02-01T00:00:00.000Z',
            },
          ],
        },
      ],
    };

    const partial = applySellTransaction(withLots, {
      ticker: 'aapl',
      shares: 12,
      price: 150,
      fee: 4,
      slippage: 2,
      timestamp: '2026-03-01T00:00:00.000Z',
      transactionId: 'sell-1',
    });
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;

    expect(partial.realizedPnl).toBe(534);
    expect(partial.costBasisSold).toBe(1_260);
    expect(partial.container.cashBalance).toBe(1_794);
    expect(partial.container.positions[0]).toMatchObject({ shares: 3, buyPrice: 130 });
    expect(partial.container.positions[0]?.lots).toEqual([
      {
        id: 'lot-2',
        shares: 3,
        buyPrice: 130,
        acquiredAt: '2026-02-01T00:00:00.000Z',
      },
    ]);

    const full = applySellTransaction(partial.container, {
      ticker: 'AAPL',
      shares: 3,
      price: 120,
      timestamp: '2026-04-01T00:00:00.000Z',
      transactionId: 'sell-2',
    });
    expect(full.ok).toBe(true);
    if (!full.ok) return;

    expect(full.realizedPnl).toBe(-30);
    expect(full.container.realizedPnl).toBe(504);
    expect(full.container.positions).toEqual([]);
    expect(full.container.cashBalance).toBe(2_154);
  });

  it('carries buy fees and slippage in cost basis, allocated pro rata on sells', () => {
    const buy = applyBuyTransaction(emptyContainer('paper_trading', 2_000), {
      ticker: 'AAPL',
      shares: 10,
      price: 100,
      fee: 2,
      slippage: 3,
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    expect(buy.ok).toBe(true);
    if (!buy.ok) return;
    expect(buy.container.cashBalance).toBe(995);

    const partial = applySellTransaction(buy.container, {
      ticker: 'AAPL',
      shares: 4,
      price: 100,
      timestamp: '2026-02-01T00:00:00.000Z',
    });
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;
    expect(partial.costBasisSold).toBe(402);
    expect(partial.realizedPnl).toBe(-2);
    expect(computePortfolioValuation(partial.container, { AAPL: 100 })).toMatchObject({
      investedCostBasis: 603,
      unrealizedPnl: -3,
    });

    const full = applySellTransaction(partial.container, {
      ticker: 'AAPL',
      shares: 6,
      price: 100,
      timestamp: '2026-03-01T00:00:00.000Z',
    });
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    expect(full.container.realizedPnl).toBe(-5);
    expect(full.container.cashBalance).toBe(1_995);
  });

  it('rejects unfunded buys and oversells without changing the container', () => {
    const initial = emptyContainer('paper_trading', 100);
    const buy = applyBuyTransaction(initial, {
      ticker: 'MSFT',
      shares: 2,
      price: 100,
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    expect(buy).toMatchObject({ ok: false, error: 'Insufficient cash' });
    expect(buy.container).toBe(initial);

    const funded = applyBuyTransaction(initial, {
      ticker: 'MSFT',
      shares: 1,
      price: 100,
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    expect(funded.ok).toBe(true);
    if (!funded.ok) return;

    const sell = applySellTransaction(funded.container, {
      ticker: 'MSFT',
      shares: 2,
      price: 110,
      timestamp: '2026-01-02T00:00:00.000Z',
    });
    expect(sell).toMatchObject({ ok: false, error: 'Insufficient shares' });
    expect(sell.container).toBe(funded.container);
  });

  it('computes realized and unrealized P&L while missing prices fall back to cost', () => {
    const container: PortfolioContainer = {
      ...emptyContainer('real_tracking', 500),
      realizedPnl: 40,
      positions: [
        {
          id: 'aapl',
          ticker: 'AAPL',
          shares: 2,
          buyPrice: 100,
          isSimulation: false,
          dateAdded: '2026-01-01',
        },
        {
          id: 'missing',
          ticker: 'MISSING',
          shares: 4,
          buyPrice: 50,
          isSimulation: false,
          dateAdded: '2026-01-02',
        },
      ],
    };

    expect(computePortfolioValuation(container, { AAPL: 125 })).toEqual({
      investedCostBasis: 400,
      marketValue: 450,
      unrealizedPnl: 50,
      unrealizedPnlPct: 12.5,
      realizedPnl: 40,
      cashBalance: 500,
      totalEquity: 950,
      missingPriceCount: 1,
    });
  });
});

let store: ReturnType<typeof usePortfolio>;

function StoreProbe() {
  store = usePortfolio();
  return null;
}

function renderStore() {
  return render(
    <PortfolioProvider>
      <StoreProbe />
    </PortfolioProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(cleanup);

describe('portfolio store v3', () => {
  it('strictly isolates cash and trades between all three containers', () => {
    renderStore();
    const realBefore = structuredClone(store.getPortfolio('real_tracking'));
    const longTermBefore = structuredClone(store.getPortfolio('long_term_sim'));

    act(() => {
      expect(
        store.executeBuy('paper_trading', {
          ticker: 'NVDA',
          shares: 5,
          price: 100,
          timestamp: '2026-03-01T00:00:00.000Z',
        }).ok,
      ).toBe(true);
      expect(
        store.executeSell('paper_trading', {
          ticker: 'NVDA',
          shares: 2,
          price: 120,
          timestamp: '2026-03-02T00:00:00.000Z',
        }).ok,
      ).toBe(true);
      expect(store.withdrawPortfolioCash('paper_trading', 250, 'reserve')).toBe(true);
      store.setTargetAllocations('paper_trading', { NVDA: 1 });
    });

    expect(store.getPortfolio('paper_trading')).toMatchObject({
      cashBalance: 9_490,
      realizedPnl: 40,
      targetAllocations: { NVDA: 1 },
    });
    expect(store.getPortfolio('paper_trading').positions).toHaveLength(1);
    expect(store.getPortfolio('paper_trading').positions[0]?.shares).toBe(3);
    expect(
      store.getPortfolio('paper_trading').transactions.map((transaction) => transaction.type),
    ).toEqual(['buy', 'sell', 'withdrawal']);
    expect(store.getPortfolio('real_tracking')).toEqual(realBefore);
    expect(store.getPortfolio('long_term_sim')).toEqual(longTermBefore);
  });

  it('migrates mixed v1 positions into normalized real and long-term containers', () => {
    window.localStorage.setItem(
      'zerochart:portfolio-positions',
      JSON.stringify([
        {
          id: 'real',
          ticker: ' msft ',
          buyPrice: 100,
          shares: 2,
          isSimulation: false,
          dateAdded: '2026-01-01',
        },
        {
          id: 'sim',
          ticker: 'qqq',
          buyPrice: 400,
          shares: 3,
          isSimulated: true,
          dateAdded: '2026-01-02',
        },
      ]),
    );

    renderStore();

    expect(store.getPortfolio('real_tracking').positions).toHaveLength(1);
    expect(store.getPortfolio('real_tracking').positions[0]).toMatchObject({
      ticker: 'MSFT',
      shares: 2,
    });
    expect(store.getPortfolio('real_tracking').positions[0]?.lots).toHaveLength(1);
    expect(store.getPortfolio('long_term_sim').positions).toHaveLength(1);
    expect(store.getPortfolio('long_term_sim').positions[0]).toMatchObject({ ticker: 'QQQ' });
    expect(store.positions.map((position) => position.ticker)).toEqual(['MSFT', 'QQQ']);
    expect(store.getPortfolio('real_tracking').cashBalance).toBe(2_500);
    expect(store.getPortfolio('paper_trading').cashBalance).toBe(10_000);
  });

  it('folds duplicate Simulation rows into one position per ticker on load', () => {
    const row = (id: string, ticker: string, buyPrice: number, shares: number, sim: boolean) => ({
      id,
      ticker,
      buyPrice,
      shares,
      isSimulation: sim,
      dateAdded: '2026-01-01',
    });
    window.localStorage.setItem(
      'zerochart:portfolio-positions',
      JSON.stringify({
        version: 3,
        activePortfolioType: 'long_term_sim',
        portfolios: {
          real_tracking: {
            type: 'real_tracking',
            positions: [row('a', 'MSFT', 100, 1, false), row('b', 'MSFT', 120, 1, false)],
          },
          long_term_sim: {
            type: 'long_term_sim',
            positions: [
              row('robo-btc-1', 'BTC', 60_000, 0.1, true),
              row('robo-eth-1', 'ETH', 3_000, 1, true),
              row('robo-btc-2', 'btc', 70_000, 0.3, true),
            ],
          },
        },
      }),
    );

    renderStore();

    const sim = store.getPortfolio('long_term_sim').positions;
    expect(sim.map((position) => position.ticker)).toEqual(['BTC', 'ETH']);
    expect(sim[0]).toMatchObject({ id: 'robo-btc-1', shares: 0.4 });
    expect(sim[0]?.buyPrice).toBeCloseTo(67_500, 6);
    expect(sim[0]?.lots?.map((lot) => lot.shares)).toEqual([0.1, 0.3]);

    // Selling by ticker now sees the whole holding instead of the first row.
    act(() => {
      expect(
        store.executeSell('long_term_sim', { ticker: 'BTC', shares: 0.4, price: 80_000 }).ok,
      ).toBe(true);
    });
    expect(store.getPortfolio('long_term_sim').positions.map((p) => p.ticker)).toEqual(['ETH']);

    // Real-tracking rows are user-entered and closed by id, so they stay apart.
    expect(store.getPortfolio('real_tracking').positions.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('migrates v2 cash and ledger without loss and persists a v3 envelope', () => {
    window.localStorage.setItem(
      'zerochart:portfolio-positions',
      JSON.stringify({
        version: 2,
        positions: [
          {
            id: 'legacy',
            ticker: 'AAPL',
            buyPrice: 120,
            shares: 4,
            isSimulation: false,
            dateAdded: '2026-01-01',
          },
        ],
        cashBalance: 1_234,
        cashLedger: [
          {
            id: 'legacy-deposit',
            type: 'deposit',
            amount: 1_234,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    );

    renderStore();

    expect(store.cashBalance).toBe(1_234);
    expect(store.cashLedger).toEqual([
      {
        id: 'legacy-deposit',
        type: 'deposit',
        amount: 1_234,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    expect(store.getPortfolio('real_tracking').positions[0]?.lots).toHaveLength(1);
    const persisted = JSON.parse(
      window.localStorage.getItem('zerochart:portfolio-positions') ?? '{}',
    ) as { version?: number; portfolios?: unknown };
    expect(persisted.version).toBe(3);
    expect(persisted.portfolios).toBeDefined();
  });

  it('hydrates a cloud v2 or v3 envelope through the same migration boundary', () => {
    renderStore();

    act(() => {
      store.replacePortfolioState({
        version: 2,
        positions: [
          {
            id: 'cloud-sim',
            ticker: 'SPY',
            buyPrice: 500,
            shares: 2,
            isSimulation: true,
            dateAdded: '2026-02-01',
          },
        ],
        cashBalance: 777,
        cashLedger: [],
      });
    });
    expect(store.getPortfolio('long_term_sim').positions[0]?.ticker).toBe('SPY');
    expect(store.getPortfolio('real_tracking').cashBalance).toBe(777);

    act(() => {
      // Saved before Paper Trading had its own terminal, when it was a Core mode.
      store.replacePortfolioState({
        version: 3,
        activePortfolioType: 'paper_trading',
        portfolios: {
          real_tracking: emptyContainer('real_tracking', 111),
          long_term_sim: emptyContainer('long_term_sim', 222),
          paper_trading: emptyContainer('paper_trading', 333),
        },
      } as unknown as PortfolioStateV3);
    });
    expect(store.activePortfolioType).toBe('long_term_sim');
    expect(store.getPortfolio('real_tracking').cashBalance).toBe(111);
    expect(store.getPortfolio('long_term_sim').cashBalance).toBe(222);
    expect(store.getPortfolio('paper_trading').cashBalance).toBe(333);
  });

  it('keeps every portfolio isolated across user A, sign-out, and user B scope changes', () => {
    renderStore();

    act(() => {
      store.switchScope('user-a');
    });
    act(() => {
      expect(store.depositPortfolioCash('long_term_sim', 2_000, 'plan')).toBe(true);
      expect(
        store.executeBuy('paper_trading', {
          ticker: 'BTC-USD',
          shares: 0.01,
          price: 50_000,
          timestamp: '2026-01-01T00:00:00.000Z',
        }).ok,
      ).toBe(true);
      expect(
        store.executeBuy('real_tracking', {
          ticker: 'TSLA',
          shares: 1,
          price: 200,
          requireCash: false,
          timestamp: '2026-01-01T00:00:00.000Z',
        }).ok,
      ).toBe(true);
    });

    act(() => {
      store.switchScope(null); // sign-out path
      store.switchScope('user-b');
    });
    expect(store.scopeUserId).toBe('user-b');
    expect(store.getPortfolio('long_term_sim').cashBalance).toBe(0);
    expect(store.getPortfolio('paper_trading').positions).toEqual([]);
    expect(
      store.getPortfolio('real_tracking').positions.some((position) => position.ticker === 'TSLA'),
    ).toBe(false);

    act(() => {
      store.switchScope('user-a');
    });
    expect(store.getPortfolio('long_term_sim').cashBalance).toBe(2_000);
    expect(store.getPortfolio('paper_trading').positions[0]?.ticker).toBe('BTC-USD');
    expect(
      store.getPortfolio('real_tracking').positions.some((position) => position.ticker === 'TSLA'),
    ).toBe(true);
  });

  it('preserves lot history across unchanged and aggregate holding edits', () => {
    renderStore();
    act(() => {
      store.executeBuy('real_tracking', {
        ticker: 'AMD',
        shares: 10,
        price: 100,
        fee: 5,
        timestamp: '2026-01-01T00:00:00.000Z',
      });
      store.executeBuy('real_tracking', {
        ticker: 'AMD',
        shares: 10,
        price: 120,
        timestamp: '2026-02-01T00:00:00.000Z',
      });
    });
    const amd = () =>
      store.getPortfolio('real_tracking').positions.find((position) => position.ticker === 'AMD');
    const before = amd();
    expect(before?.lots).toHaveLength(2);

    act(() => store.updatePosition(before!.id, { shares: 20, buyPrice: 110 }));
    expect(amd()).toEqual(before);

    act(() => store.updatePosition(before!.id, { shares: 15, buyPrice: 110 }));
    expect(amd()).toMatchObject({ shares: 15, buyPrice: 110 });
    expect(amd()?.lots).toEqual([
      expect.objectContaining({
        id: before!.lots![0]!.id,
        shares: 7.5,
        buyPrice: 100,
        feePaid: 5,
        acquiredAt: '2026-01-01T00:00:00.000Z',
      }),
      expect.objectContaining({
        id: before!.lots![1]!.id,
        shares: 7.5,
        buyPrice: 120,
        acquiredAt: '2026-02-01T00:00:00.000Z',
      }),
    ]);

    act(() => store.updatePosition(before!.id, { shares: 15, buyPrice: 132 }));
    expect(amd()).toMatchObject({ shares: 15, buyPrice: 132 });
    expect(amd()?.lots).toEqual([
      expect.objectContaining({
        id: before!.lots![0]!.id,
        shares: 7.5,
        buyPrice: 120,
        feePaid: 5,
        acquiredAt: '2026-01-01T00:00:00.000Z',
      }),
      expect.objectContaining({
        id: before!.lots![1]!.id,
        shares: 7.5,
        buyPrice: 144,
        acquiredAt: '2026-02-01T00:00:00.000Z',
      }),
    ]);
  });
});
