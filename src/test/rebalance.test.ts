import { describe, expect, it } from 'vitest';
import { computeRebalancePlan } from '@/lib/rebalance';
import type { Position } from '@/lib/portfolioAccounting';

function holding(ticker: string, shares: number, buyPrice = 100): Position {
  return { id: ticker, ticker, shares, buyPrice, isSimulation: true, dateAdded: '2026-01-01' };
}

describe('computeRebalancePlan', () => {
  it('stays quiet while every holding is inside the 5-point band', () => {
    // 62/38 against 60/40: 2 points of drift.
    const plan = computeRebalancePlan(
      [holding('AAPL', 62), holding('NVDA', 38)],
      { AAPL: 0.6, NVDA: 0.4 },
      new Map([
        ['AAPL', 100],
        ['NVDA', 100],
      ]),
    );

    expect(plan.breached).toBe(false);
    expect(plan.trades).toEqual([]);
    expect(plan.rows.map((row) => Number(row.drift.toFixed(2)))).toEqual([0.02, -0.02]);
  });

  it('restores exact targets once a holding leaves the band, sells first', () => {
    // AAPL rallied: $7,000 / $3,000 = 70/30 against 60/40.
    const plan = computeRebalancePlan(
      [holding('AAPL', 50), holding('NVDA', 30)],
      { AAPL: 60, NVDA: 40 }, // percentages normalize like fractions
      new Map([
        ['AAPL', 140],
        ['NVDA', 100],
      ]),
    );

    expect(plan.breached).toBe(true);
    expect(plan.totalValue).toBe(10_000);
    expect(plan.trades).toEqual([
      { ticker: 'AAPL', side: 'sell', amount: 1000, price: 140 },
      { ticker: 'NVDA', side: 'buy', amount: 1000, price: 100 },
    ]);
  });

  it('exits holdings without a target and buys targets not yet held', () => {
    const plan = computeRebalancePlan(
      [holding('OLD', 10)],
      { NEW: 1 },
      new Map([
        ['OLD', 100],
        ['NEW', 50],
      ]),
    );

    expect(plan.trades).toEqual([
      { ticker: 'OLD', side: 'sell', amount: 1000, price: 100 },
      { ticker: 'NEW', side: 'buy', amount: 1000, price: 50 },
    ]);
  });

  it('values an unpriced holding at cost but never trades it', () => {
    const plan = computeRebalancePlan(
      [holding('AAPL', 80), holding('DARK', 20, 100)],
      { AAPL: 0.5, DARK: 0.5 },
      new Map([['AAPL', 100]]),
    );

    expect(plan.rows.find((row) => row.ticker === 'DARK')).toMatchObject({
      priced: false,
      value: 2000,
    });
    expect(plan.trades).toEqual([{ ticker: 'AAPL', side: 'sell', amount: 3000, price: 100 }]);
  });

  it('counts cash in the base, so a sale keeps the follow-up buy on the list', () => {
    const prices = new Map([
      ['AAPL', 100],
      ['NVDA', 100],
    ]);
    // After selling $200 of AAPL from 70/30: holdings 50/30 + $200 cash.
    const plan = computeRebalancePlan(
      [holding('AAPL', 5), holding('NVDA', 3)],
      { AAPL: 0.5, NVDA: 0.5 },
      prices,
      200,
    );

    expect(plan.totalValue).toBe(1000);
    expect(plan.cashWeight).toBe(0.2);
    expect(plan.trades).toEqual([{ ticker: 'NVDA', side: 'buy', amount: 200, price: 100 }]);
    // Idle cash alone past the band also asks to be deployed.
    expect(computeRebalancePlan([holding('AAPL', 9)], { AAPL: 1 }, prices, 100).trades).toEqual([
      { ticker: 'AAPL', side: 'buy', amount: 100, price: 100 },
    ]);
  });

  it('merges multiple rows of one ticker and ignores dust under 0.1% of the portfolio', () => {
    const plan = computeRebalancePlan(
      // A: two rows worth $5,004, $2 over its $5,002 target (< 0.1% of $10,004).
      [holding('A', 25.02), holding('A', 25.02), holding('B', 31), holding('C', 19)],
      { A: 0.5, B: 0.25, C: 0.25 },
      new Map([
        ['A', 100],
        ['B', 100],
        ['C', 100],
      ]),
    );

    expect(plan.rows.find((row) => row.ticker === 'A')?.value).toBeCloseTo(5004, 6);
    expect(plan.trades.map((trade) => `${trade.side} ${trade.ticker}`)).toEqual([
      'sell B',
      'buy C',
    ]);
    expect(computeRebalancePlan([], { AAPL: 1 }, new Map()).breached).toBe(false);
  });
});
