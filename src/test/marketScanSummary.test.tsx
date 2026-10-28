import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarketScanSummary } from '@/components/MarketScanSummary';
import type { Candle } from '@/lib/binance';
import { evaluateScan, type ScanInput } from '@/lib/marketScanner';

const DAY = 86_400_000;
const TODAY = Date.UTC(2026, 9, 28);
const NOW = TODAY + 17 * 60 * 60_000;

/** Labeled fixture: 199 closed daily candles of a gentle wave (no setup fires). */
function candles(): Candle[] {
  const first = TODAY - 199 * DAY;
  return Array.from({ length: 199 }, (_, i) => {
    const close = 100 + Math.sin(i / 6) * 8;
    return {
      timestamp: first + i * DAY,
      closeTime: first + i * DAY + DAY - 1,
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
    };
  });
}

const supported = (ticker: string): ScanInput => ({
  ticker,
  instrument: `BINANCE:${ticker.replace('-USD', 'USDT')}`,
  candles: candles(),
});

function scanOf(inputs: ScanInput[]) {
  return evaluateScan(inputs, { evaluationTime: NOW, universeSource: 'assets_status' });
}

function renderScan(inputs: ScanInput[]) {
  render(
    <MarketScanSummary scan={scanOf(inputs)} completedAt={NOW} scanning={false} failed={false} />,
  );
  return screen.getByRole('region', { name: 'Market scan' });
}

describe('MarketScanSummary', () => {
  it('says "none" only as a full answer when every supported asset was scored', () => {
    const panel = renderScan([
      supported('BTC-USD'),
      supported('ETH-USD'),
      { ticker: 'AAPL', instrument: null },
      { ticker: 'EURUSD=X', instrument: null },
    ]);
    expect(within(panel).getByText('Complete')).toBeInTheDocument();
    expect(within(panel).getByText('2 of 2 supported')).toBeInTheDocument();
    expect(within(panel).getByText('2 (1 equity, 1 forex)')).toBeInTheDocument();
    expect(
      within(panel).getAllByText('None — all 2 supported assets were evaluated.'),
    ).toHaveLength(2);
    expect(within(panel).getByText(/Completed 28 Oct, 17:00 UTC/)).toBeInTheDocument();
    expect(within(panel).getByText(/Candles to 27 Oct close \(UTC\)/)).toBeInTheDocument();
  });

  it('separates an incomplete scan from "no qualifying setups" and lists what failed', () => {
    const panel = renderScan([
      supported('BTC-USD'),
      {
        ticker: 'ETH-USD',
        instrument: 'BINANCE:ETHUSDT',
        error: { code: 'FETCH_FAILED', detail: 'HTTP 503' },
      },
    ]);
    expect(within(panel).getByText('Incomplete')).toBeInTheDocument();
    expect(within(panel).getByText('1 of 2 supported')).toBeInTheDocument();
    expect(
      within(panel).getAllByText(
        'None among the 1 evaluated. The scan is incomplete, so this is not a full answer.',
      ),
    ).toHaveLength(2);
    expect(within(panel).queryByText(/None — all/)).not.toBeInTheDocument();
    const failures = within(panel).getByRole('region', { name: 'Not evaluated this scan' });
    expect(within(failures).getByText('ETH-USD')).toBeInTheDocument();
    expect(within(failures).getByText('Fetch failed')).toBeInTheDocument();
    expect(within(failures).getByText('HTTP 503')).toBeInTheDocument();
  });

  it('never offers an action: no buttons or links in the panel', () => {
    const panel = renderScan([supported('BTC-USD')]);
    expect(within(panel).queryByRole('button')).not.toBeInTheDocument();
    expect(within(panel).queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows scanning and failure states without a stale result', () => {
    const { rerender } = render(
      <MarketScanSummary scan={undefined} completedAt={0} scanning failed={false} />,
    );
    expect(screen.getByText('Scanning…')).toBeInTheDocument();
    rerender(<MarketScanSummary scan={undefined} completedAt={0} scanning={false} failed />);
    expect(
      screen.getByText('The market scan could not run. Scores are unavailable.'),
    ).toBeInTheDocument();
  });
});
