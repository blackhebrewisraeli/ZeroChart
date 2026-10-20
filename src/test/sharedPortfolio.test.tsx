import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset } from '@/lib/assets';
import type { Position } from '@/lib/portfolioManager';

const database = vi.hoisted(() => ({
  from: vi.fn(),
  insert: vi.fn(),
  maybeSingle: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('@/lib/supabaseClient', () => ({
  supabase: { from: database.from, rpc: database.rpc },
}));

const history = vi.hoisted(() => ({ fetch: vi.fn(), candles: vi.fn() }));

vi.mock('@/lib/binance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/binance')>()),
  fetchHistoricalKlines: history.fetch,
  fetchHistoricalCandles: history.candles,
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: React.ComponentProps<'a'> & { to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('recharts', () => ({
  Cell: () => null,
  Pie: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  PieChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Tooltip: () => null,
}));

import { SharedPortfolioView } from '@/components/SharedPortfolioView';
import { evaluateCandles } from '@/lib/canonicalModel';
import {
  buildSharedPortfolioSnapshot,
  fetchSharedPortfolio,
  publishSharedPortfolio,
  type SharedPortfolioRecord,
} from '@/lib/sharedPortfolio';

function makeAsset(overrides: Partial<Asset> & Pick<Asset, 'ticker'>): Asset {
  return {
    ticker: overrides.ticker,
    name: overrides.name ?? overrides.ticker,
    current_price: overrides.current_price ?? 120,
    stable_signal: null,
    radar_signal: null,
    stable_explanation: null,
    radar_explanation: null,
    risk_pct: overrides.risk_pct ?? 0.02,
    reward_pct: null,
    volume_spike: null,
    rsi_14: overrides.rsi_14 ?? 35,
    sma_50: null,
    sma_200: null,
    change_24h: overrides.change_24h ?? 0.01,
    updated_at: null,
  };
}

function makePosition(overrides: Partial<Position> & Pick<Position, 'id' | 'ticker'>): Position {
  return {
    id: overrides.id,
    ticker: overrides.ticker,
    buyPrice: overrides.buyPrice ?? 100,
    shares: overrides.shares ?? 1,
    isSimulation: overrides.isSimulation ?? true,
    dateAdded: overrides.dateAdded ?? '2026-01-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  database.from.mockReturnValue({ insert: database.insert });
  database.rpc.mockReturnValue({ maybeSingle: database.maybeSingle });
  history.fetch.mockResolvedValue([]);
  history.candles.mockResolvedValue([]);
});

/** Deterministic daily OHLC candles for the canonical engine. */
const series = (count: number, drift: number) =>
  Array.from({ length: count }, (_, i) => {
    const close = 100 + 10 * Math.sin(i / 5) + drift * i;
    return { timestamp: i * 86_400_000, open: close, high: close * 1.01, low: close * 0.99, close };
  });
const engineScore = (candles: ReturnType<typeof series>) => {
  const result = evaluateCandles(candles);
  if (result.status !== 'OK') throw new Error('fixture must be scoreable');
  return result;
};

const klines = (closes: number[], startDay = 0) =>
  closes.map((close, index) => ({ timestamp: (startDay + index) * 86_400_000, close }));

afterEach(cleanup);

describe('shared portfolio snapshots', () => {
  it('builds a percentage-only snapshot with no absolute amounts', async () => {
    const positions = [
      makePosition({ id: 'btc-1', ticker: 'BTC', buyPrice: 100, shares: 1 }),
      makePosition({ id: 'btc-2', ticker: 'BTC', buyPrice: 80, shares: 1 }),
      makePosition({ id: 'eth-1', ticker: 'ETH', buyPrice: 50, shares: 2 }),
    ];
    const assets = [
      makeAsset({ ticker: 'BTC', name: 'Bitcoin', current_price: 120 }),
      makeAsset({ ticker: 'ETH', name: 'Ethereum', current_price: 80 }),
    ];
    const btcCandles = series(200, 0.2);
    const ethCandles = series(200, -0.3);
    history.candles.mockImplementation(async (ticker: string) =>
      ticker === 'BTC' ? btcCandles : ethCandles,
    );

    const snapshot = await buildSharedPortfolioSnapshot(
      positions,
      assets,
      '2026-10-18T00:00:00.000Z',
    );

    // BTC: 240 now / 180 in · ETH: 160 now / 100 in · total: 400 now / 280 in.
    expect(snapshot.pnlPercent).toBeCloseTo((120 / 280) * 100);
    expect(snapshot.holdings.map((h) => [h.ticker, h.allocationPercent, h.pnlPercent])).toEqual([
      ['BTC', expect.closeTo(60), expect.closeTo((60 / 180) * 100)],
      ['ETH', expect.closeTo(40), expect.closeTo(60)],
    ]);
    const [btc, eth] = snapshot.holdings;
    // Holding scores are the canonical engine's, from each asset's candles.
    expect(btc).toMatchObject({
      quantScore: engineScore(btcCandles).signal_score,
      regime: engineScore(btcCandles).regime,
    });
    expect(eth?.quantScore).toBe(engineScore(ethCandles).signal_score);
    expect(snapshot.quantScore).toBeCloseTo(btc!.quantScore! * 0.6 + eth!.quantScore! * 0.4);

    // The privacy contract: these keys and nothing else. Adding a field here
    // (especially an absolute amount) must be a deliberate test change.
    expect(Object.keys(snapshot).sort()).toEqual([
      'alphaPercent',
      'createdAt',
      'holdings',
      'maxDrawdownPercent',
      'pnlPercent',
      'quantScore',
      'version',
    ]);
    for (const holding of snapshot.holdings) {
      expect(Object.keys(holding).sort()).toEqual([
        'allocationPercent',
        'name',
        'pnlPercent',
        'quantScore',
        'regime',
        'ticker',
      ]);
    }
  });

  it('reports null scores for holdings without enough candles and leaves them out of the blend', async () => {
    const candles = series(200, 0.2);
    history.candles.mockImplementation(async (ticker: string) => (ticker === 'BTC' ? candles : []));
    const snapshot = await buildSharedPortfolioSnapshot(
      [
        makePosition({ id: 'btc', ticker: 'BTC', buyPrice: 100, shares: 1 }),
        makePosition({ id: 'aapl', ticker: 'AAPL', buyPrice: 100, shares: 3 }),
      ],
      [
        makeAsset({ ticker: 'BTC', current_price: 100 }),
        makeAsset({ ticker: 'AAPL', current_price: 100 }),
      ],
      '2026-10-18T00:00:00.000Z',
    );

    expect(snapshot.holdings.find((h) => h.ticker === 'AAPL')).toMatchObject({
      quantScore: null,
      regime: null,
    });
    // 25% BTC is the only scored weight, so the blend is BTC's score alone.
    expect(snapshot.quantScore).toBe(engineScore(candles).signal_score);

    const none = await buildSharedPortfolioSnapshot(
      [makePosition({ id: 'aapl', ticker: 'AAPL' })],
      [makeAsset({ ticker: 'AAPL' })],
      '2026-10-18T00:00:00.000Z',
    );
    expect(none.quantScore).toBeNull();
  });

  it('computes max drawdown and alpha vs BTC from the allocation-weighted history', async () => {
    const closes: Record<string, number[]> = {
      BTC: [100, 120, 90, 110],
      ETH: [50, 50, 60, 70],
    };
    history.fetch.mockImplementation(async (ticker: string) => klines(closes[ticker] ?? []));

    const snapshot = await buildSharedPortfolioSnapshot(
      [
        makePosition({ id: 'btc', ticker: 'BTC', buyPrice: 100, shares: 2 }),
        makePosition({ id: 'eth', ticker: 'ETH', buyPrice: 50, shares: 2 }),
      ],
      [
        makeAsset({ ticker: 'BTC', current_price: 120 }),
        makeAsset({ ticker: 'ETH', current_price: 80 }),
      ],
      '2026-10-18T00:00:00.000Z',
    );

    // Since 2026-01-01: 290 elapsed days + today.
    expect(history.fetch).toHaveBeenCalledWith('ETH', '1d', 291);
    expect(history.fetch).toHaveBeenCalledWith('BTC', '1d', 291);
    // 60/40 curve on 10k: 10000 → 11200 → 10200 → 12200 (+22%); BTC alone +10%.
    expect(snapshot.maxDrawdownPercent).toBeCloseTo((1000 / 11200) * 100);
    expect(snapshot.alphaPercent).toBeCloseTo(12);
  });

  it('measures alpha over the portfolio window and keeps drawdown without a benchmark', async () => {
    const eth = [makePosition({ id: 'eth', ticker: 'ETH', buyPrice: 50, shares: 1 })];
    const assets = [makeAsset({ ticker: 'ETH', current_price: 60 })];
    // ETH lists two days into the lookback; BTC's earlier crash is outside its window.
    history.fetch.mockImplementation(async (ticker: string) =>
      ticker === 'ETH' ? klines([50, 60], 2) : klines([200, 100, 100, 110]),
    );

    const aligned = await buildSharedPortfolioSnapshot(eth, assets, '2026-10-18T00:00:00.000Z');

    expect(aligned.maxDrawdownPercent).toBeCloseTo(0);
    expect(aligned.alphaPercent).toBeCloseTo(20 - 10);

    history.fetch.mockImplementation(async (ticker: string) => {
      if (ticker === 'ETH') return klines([50, 40, 60]);
      throw new Error('benchmark down');
    });

    const noBenchmark = await buildSharedPortfolioSnapshot(eth, assets, '2026-10-18T00:00:00.000Z');

    expect(noBenchmark.maxDrawdownPercent).toBeCloseTo(20);
    expect(noBenchmark.alphaPercent).toBeNull();

    // BTC missing the curve's first day: no like-for-like window, so no alpha.
    history.fetch.mockImplementation(async (ticker: string) =>
      ticker === 'ETH' ? klines([50, 40, 60]) : klines([100, 110], 1),
    );

    const partial = await buildSharedPortfolioSnapshot(eth, assets, '2026-10-18T00:00:00.000Z');

    expect(partial.maxDrawdownPercent).toBeCloseTo(20);
    expect(partial.alphaPercent).toBeNull();
  });

  it('still builds the snapshot, without drawdown and alpha, when history is unavailable', async () => {
    const assets = [makeAsset({ ticker: 'BTC', current_price: 120 })];
    const btc = makePosition({ id: 'btc', ticker: 'BTC', buyPrice: 100, shares: 2 });
    history.fetch.mockRejectedValue(new Error('Binance down'));

    const failed = await buildSharedPortfolioSnapshot([btc], assets, '2026-10-18T00:00:00.000Z');

    expect(failed.pnlPercent).toBeCloseTo(20);
    expect(failed.maxDrawdownPercent).toBeNull();
    expect(failed.alphaPercent).toBeNull();

    // Equities have no Binance history: skip the fetch instead of diluting the curve.
    history.fetch.mockClear();
    const mixed = await buildSharedPortfolioSnapshot(
      [btc, makePosition({ id: 'aapl', ticker: 'AAPL', dateAdded: '2020-01-01T00:00:00.000Z' })],
      [...assets, makeAsset({ ticker: 'AAPL' })],
      '2026-10-18T00:00:00.000Z',
    );
    expect(history.fetch).not.toHaveBeenCalled();
    expect(mixed.maxDrawdownPercent).toBeNull();
    expect(mixed.alphaPercent).toBeNull();
  });

  it('publishes through the authenticated insert contract', async () => {
    database.insert.mockResolvedValue({ error: null });
    const snapshot = await buildSharedPortfolioSnapshot([], [], '2026-10-18T00:00:00.000Z');

    await publishSharedPortfolio({ id: 'share-id', userId: 'user-a', snapshot });

    expect(database.from).toHaveBeenCalledWith('shared_portfolios');
    expect(database.insert).toHaveBeenCalledWith({
      id: 'share-id',
      user_id: 'user-a',
      snapshot,
    });
  });

  it('reads one snapshot by id through the RPC and validates it', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const snapshot = await buildSharedPortfolioSnapshot([], [], '2026-10-18T00:00:00.000Z');
    database.maybeSingle.mockResolvedValue({
      data: { id, snapshot, created_at: snapshot.createdAt },
      error: null,
    });

    await expect(fetchSharedPortfolio(id)).resolves.toEqual({
      id,
      snapshot,
      createdAt: snapshot.createdAt,
    });
    expect(database.rpc).toHaveBeenCalledWith('get_shared_portfolio', { share_id: id });
    expect(database.from).not.toHaveBeenCalled();
  });

  it('drops any field outside the percentage-only contract when reading', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const snapshot = await buildSharedPortfolioSnapshot(
      [makePosition({ id: 'btc', ticker: 'BTC', buyPrice: 100, shares: 2 })],
      [makeAsset({ ticker: 'BTC', name: 'Bitcoin', current_price: 120 })],
      '2026-10-18T00:00:00.000Z',
    );
    const tampered = {
      ...snapshot,
      totalValue: 1_000_000,
      holdings: snapshot.holdings.map((holding) => ({ ...holding, value: 240, shares: 2 })),
    };
    database.maybeSingle.mockResolvedValue({
      data: { id, snapshot: tampered, created_at: snapshot.createdAt },
      error: null,
    });

    const record = await fetchSharedPortfolio(id);

    expect(record?.snapshot).toEqual(snapshot);
  });

  it('reads version 2 snapshots with drawdown and alpha as null', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const legacy = {
      version: 2,
      createdAt: '2026-10-18T00:00:00.000Z',
      pnlPercent: 5,
      quantScore: 70,
      holdings: [],
    };
    database.maybeSingle.mockResolvedValue({
      data: { id, snapshot: legacy, created_at: legacy.createdAt },
      error: null,
    });

    const record = await fetchSharedPortfolio(id);

    expect(record?.snapshot).toEqual({
      ...legacy,
      version: 3,
      maxDrawdownPercent: null,
      alphaPercent: null,
    });
  });

  it('reads null "not enough data" scores back', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const snapshot = {
      version: 3,
      createdAt: '2026-10-18T00:00:00.000Z',
      pnlPercent: 5,
      quantScore: null,
      maxDrawdownPercent: null,
      alphaPercent: null,
      holdings: [
        {
          ticker: 'AAPL',
          name: 'Apple',
          allocationPercent: 100,
          pnlPercent: 5,
          quantScore: null,
          regime: null,
        },
      ],
    };
    database.maybeSingle.mockResolvedValue({
      data: { id, snapshot, created_at: snapshot.createdAt },
      error: null,
    });

    expect((await fetchSharedPortfolio(id))?.snapshot).toEqual(snapshot);
  });

  it('skips the request for ids that are not UUIDs', async () => {
    await expect(fetchSharedPortfolio('not-a-uuid')).resolves.toBeNull();
    expect(database.rpc).not.toHaveBeenCalled();
  });
});

describe('public portfolio view', () => {
  it('shows portfolio essentials and never renders trading or credential controls', async () => {
    const snapshot = await buildSharedPortfolioSnapshot(
      [makePosition({ id: 'btc', ticker: 'BTC', buyPrice: 100, shares: 2 })],
      [makeAsset({ ticker: 'BTC', name: 'Bitcoin', current_price: 120 })],
      '2026-10-18T00:00:00.000Z',
    );
    const record: SharedPortfolioRecord = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      createdAt: snapshot.createdAt,
      snapshot,
    };

    const { container } = render(<SharedPortfolioView record={record} />);

    expect(screen.getByRole('heading', { name: 'Quant Portfolio Snapshot' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Asset allocation' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Quant scores' })).toBeVisible();
    expect(
      screen.getAllByRole('link', {
        name: /Built with ZeroChart - Create your own Quant Portfolio/i,
      }),
    ).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /trade/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/api key/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/deposit|withdraw/i)).not.toBeInTheDocument();

    // Percentage-only: returns render, dollar amounts never do.
    expect(screen.getByText('Total return')).toBeVisible();
    expect(screen.getAllByText('+20.00%').length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/\$/);
  });

  it('shows max drawdown and alpha, or an em dash when they are unavailable', async () => {
    const snapshot = await buildSharedPortfolioSnapshot([], [], '2026-10-18T00:00:00.000Z');
    const record = (risk: Partial<SharedPortfolioRecord['snapshot']>): SharedPortfolioRecord => ({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      createdAt: snapshot.createdAt,
      snapshot: { ...snapshot, ...risk },
    });

    const { rerender } = render(<SharedPortfolioView record={record({})} />);
    expect(screen.getByText('Max drawdown')).toBeVisible();
    expect(screen.getByText('Alpha')).toBeVisible();
    expect(screen.getAllByText('—')).toHaveLength(2);

    rerender(
      <SharedPortfolioView record={record({ maxDrawdownPercent: 8.5, alphaPercent: -3.25 })} />,
    );
    expect(screen.getByText('-8.50%')).toBeVisible();
    expect(screen.getByText('-3.25%')).toBeVisible();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });
});
