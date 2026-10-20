import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

const candles = Array.from({ length: 200 }, (_, i) => {
  const close = 100 + 10 * Math.sin(i / 5) + 0.2 * i;
  return { timestamp: i, open: close, high: close * 1.01, low: close * 0.99, close };
});

vi.mock('@/lib/binance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/binance')>()),
  fetchHistoricalCandles: vi.fn(async (ticker: string) => (ticker === 'BTC' ? candles : [])),
}));

import { useCanonicalScores } from '@/hooks/useCanonicalScores';
import { evaluateCandles } from '@/lib/canonicalModel';

describe('useCanonicalScores', () => {
  it('maps each ticker to its canonical engine result', async () => {
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useCanonicalScores(['BTC', 'AAPL', 'BTC']), { wrapper });

    await waitFor(() => expect(result.current.size).toBe(2));
    expect(result.current.get('BTC')).toEqual(evaluateCandles(candles));
    expect(result.current.get('AAPL')).toMatchObject({ status: 'INSUFFICIENT_DATA', received: 0 });
  });
});
