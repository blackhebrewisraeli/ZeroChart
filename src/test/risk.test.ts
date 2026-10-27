import { describe, expect, it } from 'vitest';
import {
  applyBuyTransaction,
  computePortfolioValuation,
  freshPaperContainer,
  PAPER_STARTING_CASH,
  type PortfolioContainer,
} from '@/lib/portfolioAccounting';
import {
  aggregateOpenRisk,
  checkNewEntry,
  checkSell,
  DEFAULT_ATR_STOP_MULTIPLIER,
  DEFAULT_RISK_PERCENT,
  formatShares,
  MAX_PORTFOLIO_RISK_PERCENT,
  maxDrawdown,
  recommendPositionSize,
  sharpeRatio,
  type RiskBook,
} from '@/lib/risk';

describe('maxDrawdown', () => {
  it('measures the percentage drop from the highest peak', () => {
    expect(maxDrawdown([100, 120, 60, 90])).toBeCloseTo(0.5, 10);
    expect(maxDrawdown([100, 80, 120, 60])).toBeCloseTo(0.5, 10);
    expect(maxDrawdown([100, 90, 95, 85])).toBeCloseTo(0.15, 10);
  });

  it('reports 0 for rising, flat, or too-short curves', () => {
    expect(maxDrawdown([100, 110, 120])).toBe(0);
    expect(maxDrawdown([100, 100, 100])).toBe(0);
    expect(maxDrawdown([100])).toBe(0);
    expect(maxDrawdown([])).toBe(0);
  });
});

describe('sharpeRatio', () => {
  it('annualizes the mean/volatility of period returns', () => {
    // Returns: +20%, −50%, +50% → mean 6.67%, σ 41.9%, ×√365 ≈ 3.04.
    const result = sharpeRatio([10000, 12000, 6000, 9000]);
    expect(result).toBeCloseTo(3.04, 2);
  });

  it('is negative for a steadily declining curve', () => {
    expect(sharpeRatio([120, 100, 80, 60])).toBeLessThan(0);
  });

  it('returns 0 for flat or too-short curves (no divide-by-zero)', () => {
    expect(sharpeRatio([100, 100, 100, 100])).toBe(0);
    expect(sharpeRatio([100, 110])).toBe(0);
    expect(sharpeRatio([])).toBe(0);
    expect(sharpeRatio([100, 120, 60, 90], 0)).toBe(0);
  });
});

describe('recommendPositionSize', () => {
  it('defaults to the Pine HUD contract: 2% risk on a 2×ATR stop', () => {
    expect(DEFAULT_RISK_PERCENT).toBe(0.02);
    expect(DEFAULT_ATR_STOP_MULTIPLIER).toBe(2);
  });

  it('sizes q = risk budget / stop distance so the stop loses exactly 2% of capital', () => {
    // Stop distance = 2 × 4 = 8 → q = 200 / 8 = 25 (budget 10,000 / 100 = 100 doesn't bind).
    const size = recommendPositionSize({ capital: 10000, price: 100, atr: 4 });

    expect(size.requestedRisk).toBeCloseTo(200, 10);
    expect(size.plannedRisk).toBeCloseTo(200, 10);
    expect(size.shares).toBe(25);
    expect(size.stopPrice).toBeCloseTo(92, 10);
    expect(size.notional).toBeCloseTo(2500, 6);
    expect(size.isCapped).toBe(false);
  });

  it('takes a custom stop multiplier and risk percent', () => {
    const tight = recommendPositionSize({ capital: 10000, price: 100, atr: 4, atrStopMult: 1 });
    expect(tight.shares).toBe(50);
    expect(tight.stopPrice).toBeCloseTo(96, 10);

    const fractional = recommendPositionSize({ capital: 10000, price: 100, atr: 1.5 });
    expect(fractional.shares).toBeCloseTo(66.6667, 4);
    expect(fractional.plannedRisk).toBeCloseTo(200, 3);

    const conservative = recommendPositionSize({
      capital: 5000,
      price: 50,
      atr: 2.5,
      riskPercent: 0.01,
    });
    expect(conservative.requestedRisk).toBeCloseTo(50, 10);
    expect(conservative.shares).toBe(10);
    expect(conservative.stopPrice).toBeCloseTo(45, 10);
  });

  it('sizes to zero when market data or capital is unusable', () => {
    expect(recommendPositionSize({ capital: 10000, price: 100, atr: 0 }).shares).toBe(0);
    expect(recommendPositionSize({ capital: 10000, price: 0, atr: 4 }).shares).toBe(0);
    expect(
      recommendPositionSize({ capital: 10000, price: 100, atr: 4, atrStopMult: 0 }).shares,
    ).toBe(0);
    expect(recommendPositionSize({ capital: -1, price: 100, atr: 4 })).toMatchObject({
      shares: 0,
      requestedRisk: 0,
      plannedRisk: 0,
      notional: 0,
    });
  });

  it('caps q at total capital / entry price and reports the smaller planned risk (F-1.2a)', () => {
    // Stop distance 1: risk-optimal q = 200 → $20,000 on $10,000 capital. Caps at 100.
    const size = recommendPositionSize({ capital: 10000, price: 100, atr: 0.5 });
    expect(size.shares).toBe(100);
    expect(size.notional).toBeLessThanOrEqual(10000);
    expect(size.isCapped).toBe(true);
    // Requested 2% of capital, but 100 shares × $1 stop distance only risks $100.
    expect(size.requestedRisk).toBeCloseTo(200, 10);
    expect(size.plannedRisk).toBeCloseTo(100, 10);
  });

  it('caps notional at the per-asset allocation when provided', () => {
    // Risk-optimal 600 / 8 = 75 shares ($7,500) still exceeds a $5,000 allocation.
    const size = recommendPositionSize({
      capital: 30000,
      price: 100,
      atr: 4,
      allocatedCapital: 5000,
    });
    expect(size.shares).toBe(50);
    expect(size.notional).toBeLessThanOrEqual(5000);
    expect(size.isCapped).toBe(true);

    // Within budget, the risk model is untouched by the allocation.
    const uncapped = recommendPositionSize({
      capital: 30000,
      price: 100,
      atr: 4,
      allocatedCapital: 20000,
    });
    expect(uncapped.shares).toBe(75);
    expect(uncapped.isCapped).toBe(false);
  });

  it('never exceeds the tighter of capital and allocation, even after rounding', () => {
    // budgetShares = 10000/300 = 33.3333… → 4dp rounding must not breach.
    const size = recommendPositionSize({
      capital: 10000,
      price: 300,
      atr: 0.6,
      allocatedCapital: 10000,
    });
    expect(size.shares * 300).toBeLessThanOrEqual(10000);
    expect(size.isCapped).toBe(true);

    // 10000/562.14 = 17.78917… rounds UP to 17.7892 ($10,000.02) — must floor.
    const roundsUp = recommendPositionSize({ capital: 10000, price: 562.14, atr: 4.21605 });
    expect(roundsUp.shares).toBe(17.7891);
    expect(roundsUp.notional).toBeLessThanOrEqual(10000);

    // An allocation larger than total capital is clamped to capital.
    const clamped = recommendPositionSize({
      capital: 1000,
      price: 100,
      atr: 0.5,
      allocatedCapital: 999999,
    });
    expect(clamped.shares).toBe(10);
    expect(clamped.notional).toBeLessThanOrEqual(1000);
    expect(clamped.isCapped).toBe(true);
  });

  it('floors the stop price at zero when the stop distance exceeds the price', () => {
    const size = recommendPositionSize({ capital: 10000, price: 5, atr: 4 });
    expect(size.stopPrice).toBe(0);
    // Risk-model share count stays intact; notional remains budget-safe.
    expect(size.shares).toBe(25);
    expect(size.notional).toBeLessThanOrEqual(10000);
    // The floored stop can only lose the $5 entry per share: 25 × 5.
    expect(size.plannedRisk).toBeCloseTo(125, 10);
  });
});

describe('aggregateOpenRisk', () => {
  it('sums (entry − stop) × quantity across open positions', () => {
    expect(
      aggregateOpenRisk([
        { shares: 10, buyPrice: 100, stopPrice: 90 },
        { shares: 2, buyPrice: 50, stopPrice: 45 },
      ]),
    ).toBeCloseTo(110, 10);
    expect(aggregateOpenRisk([])).toBe(0);
  });

  it('counts a missing stop as the whole entry and a stop above entry as no risk', () => {
    expect(aggregateOpenRisk([{ shares: 3, buyPrice: 100 }])).toBe(300);
    expect(aggregateOpenRisk([{ shares: 3, buyPrice: 100, stopPrice: Number.NaN }])).toBe(300);
    expect(aggregateOpenRisk([{ shares: 3, buyPrice: 100, stopPrice: 120 }])).toBe(0);
  });
});

describe('checkNewEntry (portfolio risk manager)', () => {
  // A $100,000 paper account and four volatile assets, each with a 5% daily ATR.
  const market = {
    BTC: { price: 60_000, atr: 3_000 },
    ETH: { price: 3_000, atr: 150 },
    SOL: { price: 150, atr: 7.5 },
    AVAX: { price: 30, atr: 1.5 },
  };
  type Ticker = keyof typeof market;
  const prices = Object.fromEntries(Object.entries(market).map(([t, m]) => [t, m.price]));

  function riskBook(account: PortfolioContainer): RiskBook {
    return {
      equity: computePortfolioValuation(account, prices).totalEquity,
      cash: account.cashBalance,
      openRisk: aggregateOpenRisk(
        account.positions.map((position) => ({
          ...position,
          stopPrice:
            position.buyPrice - DEFAULT_ATR_STOP_MULTIPLIER * market[position.ticker as Ticker].atr,
        })),
      ),
    };
  }

  it('rejects a 4th position that would breach the aggregate risk limit', () => {
    let account = freshPaperContainer();

    /** Sizes a 1.75%-risk signal, asks the manager, and books it only when cleared. */
    function enter(ticker: Ticker) {
      const { price, atr } = market[ticker];
      const size = recommendPositionSize({
        capital: PAPER_STARTING_CASH,
        price,
        atr,
        riskPercent: 0.0175,
      });
      const fee = size.notional * 0.0025;
      const order = { shares: size.shares, price, fee, stopPrice: size.stopPrice };
      const check = checkNewEntry(riskBook(account), order);
      if (check.ok) {
        const fill = applyBuyTransaction(account, { ticker, ...order, requireCash: true });
        if (!fill.ok) throw new Error(fill.error);
        account = fill.container;
      }
      return check;
    }

    expect(enter('BTC')).toEqual({ ok: true });
    expect(enter('ETH')).toEqual({ ok: true });
    expect(enter('SOL')).toEqual({ ok: true });
    const book = riskBook(account);
    expect(book.openRisk / book.equity).toBeCloseTo(0.0525, 3); // 3 × 1.75%, under the 6% cap

    // A 4th 1.75% entry would take the portfolio to ~7%: denied, never booked.
    const fourth = enter('AVAX');
    expect(MAX_PORTFOLIO_RISK_PERCENT).toBe(0.06);
    expect(fourth).toEqual({
      ok: false,
      reason: 'Portfolio max risk reached: 5.3% open + 1.8% new would pass the 6% limit.',
    });
    expect(account.positions.map((position) => position.ticker)).toEqual(['BTC', 'ETH', 'SOL']);
    // Cash was never the problem: the $17,500 AVAX order was affordable.
    expect(account.cashBalance).toBeGreaterThan(17_500 * 1.0025);

    // A smaller entry that keeps the portfolio under 6% is still allowed.
    expect(checkNewEntry(book, { shares: 100, price: 30, fee: 0, stopPrice: 27 })).toEqual({
      ok: true,
    });
  });

  it('rejects an entry the free cash cannot cover', () => {
    const book = { equity: 10_000, cash: 1_000, openRisk: 0 };
    expect(checkNewEntry(book, { shares: 10, price: 100, fee: 2.5, stopPrice: 99 })).toEqual({
      ok: false,
      reason: 'Not enough cash: this order needs $1,002.50, $1,000.00 available.',
    });
    expect(checkNewEntry(book, { shares: 9, price: 100, fee: 2.5, stopPrice: 99 })).toEqual({
      ok: true,
    });
  });

  it('treats an entry without a stop as risking its whole notional', () => {
    const book = { equity: 100_000, cash: 100_000, openRisk: 0 };
    expect(checkNewEntry(book, { shares: 50, price: 100, fee: 0 }).ok).toBe(true); // 5%
    expect(checkNewEntry(book, { shares: 70, price: 100, fee: 0 }).ok).toBe(false); // 7%
  });
});

describe('formatShares', () => {
  it("shows a quantity at the ledger's 1e-8 precision, trailing zeros trimmed", () => {
    expect(formatShares(25)).toBe('25');
    expect(formatShares(66.6667)).toBe('66.6667');
    expect(formatShares(1234.567)).toBe('1,234.567');
    expect(formatShares(0.5)).toBe('0.5');
    expect(formatShares(0)).toBe('—');
    expect(formatShares(-1)).toBe('—');
    expect(formatShares(Number.NaN)).toBe('—');
  });

  it('never rounds a quantity near a whole number into it', () => {
    // The acceptance pass: 1.99501247 ZCTB read "2" next to its $100.00 cost.
    expect(formatShares(1.99501247)).toBe('1.99501247');
    expect(formatShares(1.99999999)).toBe('1.99999999');
    expect(formatShares(2.00000001)).toBe('2.00000001');
    expect(formatShares(99.99999999)).toBe('99.99999999');
    expect(formatShares(124.6882793)).toBe('124.6882793');
  });

  it('keeps a very small positive holding visible instead of showing 0', () => {
    expect(formatShares(0.00000001)).toBe('0.00000001');
    expect(formatShares(0.00004)).toBe('0.00004');
    expect(formatShares(4e-9)).toBe('<0.00000001');
  });

  it('marks real rounding with ≈, and not float noise', () => {
    expect(formatShares(44.42263272 - 25)).toBe('19.42263272'); // 19.422632720000003
    expect(formatShares(0.1 + 0.2)).toBe('0.3');
    // Browser-side quantities finer than 1e-8, e.g. a $100 ticket at $50.123.
    expect(formatShares(100 / 50.123)).toBe('≈1.99509207');
    expect(formatShares(10 / 3)).toBe('≈3.33333333');
  });
});

describe('checkSell', () => {
  const holding = (shares: number) =>
    applyBuyTransaction(freshPaperContainer(), { ticker: 'ZCTA-USD', shares, price: 100 })
      .container;

  it('allows a sell of up to the whole holding, within the server tolerance', () => {
    expect(checkSell(holding(19.21131636), 'ZCTA-USD', 19.21131636)).toEqual({ ok: true });
    expect(checkSell(holding(19.21131636), 'zcta-usd', 5)).toEqual({ ok: true });
    // check_paper_transaction allows held + 1e-9.
    expect(checkSell(holding(1), 'ZCTA-USD', 1 + 5e-10)).toEqual({ ok: true });
  });

  it('names what is held, never shortening the order, when the sell is larger', () => {
    expect(checkSell(holding(19.21131636), 'ZCTA-USD', 25, 103)).toEqual({
      ok: false,
      reason: 'Only 19.21131636 ZCTA-USD available to sell ($1,978.77).',
    });
    expect(checkSell(holding(0.00000001), 'ZCTA-USD', 0.00000002)).toEqual({
      ok: false,
      reason: 'Only 0.00000001 ZCTA-USD available to sell.',
    });
  });

  it('refuses a sell with no open position: no short selling', () => {
    expect(checkSell(freshPaperContainer(), 'ZCTA-USD', 1)).toEqual({
      ok: false,
      reason: 'No open ZCTA-USD position to sell.',
    });
  });
});
