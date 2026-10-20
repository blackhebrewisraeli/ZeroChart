import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', async () => {
  const { paperDb } = await import('./paperDbFake');
  return {
    insertPaperTransaction: paperDb.insertPaperTransaction,
    loadPaperTransactions: paperDb.loadPaperTransactions,
  };
});

import { binancePaperAdapter } from '@/lib/brokers/binancePaperAdapter';
import { ibkrAdapter, ibkrCredentialsFromEnv } from '@/lib/brokers/ibkrAdapter';
import { paperDb } from './paperDbFake';

beforeEach(() => {
  paperDb.rows.length = 0;
});

it('Binance paper books orders into the paper ledger and reads the replay back', async () => {
  const broker = binancePaperAdapter('user-a');

  await expect(
    broker.placeOrder({ side: 'buy', ticker: ' btc ', shares: 0.5, price: 60_000, fee: 30 }),
  ).resolves.toEqual({ ok: true, orderId: null });
  expect(paperDb.rows[0]).toMatchObject({
    action: 'BUY',
    ticker: 'BTC',
    quantity: 0.5,
    price: 60_000,
    fees: 30,
  });

  await expect(broker.getBalances()).resolves.toEqual([{ currency: 'USD', available: 69_970 }]);
  await expect(broker.getPositions()).resolves.toEqual([
    { ticker: 'BTC', quantity: 0.5, averagePrice: 60_000 },
  ]);
  await expect(broker.cancelOrder('any')).resolves.toMatchObject({ ok: false });
});

it('Binance paper surfaces a rejected fill instead of throwing', async () => {
  paperDb.insertPaperTransaction.mockRejectedValueOnce(new Error('insufficient paper cash'));
  await expect(
    binancePaperAdapter('user-a').placeOrder({
      side: 'buy',
      ticker: 'BTC',
      shares: 10,
      price: 60_000,
      fee: 0,
    }),
  ).resolves.toEqual({ ok: false, error: 'insufficient paper cash' });
});

it('IBKR refuses every call until it is built, configured or not', async () => {
  expect(ibkrCredentialsFromEnv({ IBKR_ACCOUNT_ID: 'U1', IBKR_API_KEY: 'k' })).toBeNull();
  const credentials = ibkrCredentialsFromEnv({
    IBKR_ACCOUNT_ID: 'U1',
    IBKR_API_KEY: 'k',
    IBKR_GATEWAY_URL: 'https://localhost:5000',
  });
  expect(credentials).not.toBeNull();

  for (const broker of [ibkrAdapter(null), ibkrAdapter(credentials)]) {
    await expect(
      broker.placeOrder({ side: 'buy', ticker: 'AAPL', shares: 1, price: 200, fee: 0 }),
    ).resolves.toMatchObject({ ok: false });
    await expect(broker.getBalances()).rejects.toThrow(/Interactive Brokers/);
  }
});
