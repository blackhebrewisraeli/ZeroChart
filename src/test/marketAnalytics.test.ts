import { describe, expect, it } from 'vitest';
import { candlesUrl, toRow } from '../../supabase/functions/market-analytics/analytics';

describe('market-analytics', () => {
  it('fetches crypto from Binance and everything else from Yahoo', () => {
    expect(candlesUrl('BTC-USD')).toBe(
      'https://api.binance.com/api/v3/klines?interval=1d&limit=365&symbol=BTCUSDT',
    );
    expect(candlesUrl('EURUSD=X')).toBe(
      'https://query1.finance.yahoo.com/v8/finance/chart/EURUSD%3DX?range=1y&interval=1d',
    );
  });

  it('turns a year of adjusted Yahoo candles into the scanner signals', () => {
    // An uptrend: 200 days at 100, 49 at 110, then 112. One 20-day high of 120
    // and doubled volume over the last 3 days trigger the radar.
    const close = [...Array<number>(200).fill(100), ...Array<number>(49).fill(110), 112];
    const high = close.map((value, i) => (i === 245 ? 120 : value));
    const volume = close.map((_, i) => (i >= 247 ? 2000 : 1000));
    // Yahoo's raw series sits at twice the adjusted one, after a leading gap.
    const body = {
      chart: {
        result: [
          {
            indicators: {
              quote: [
                {
                  close: [null, ...close.map((value) => value * 2)],
                  high: [null, ...high.map((value) => value * 2)],
                  volume: [null, ...volume],
                },
              ],
              adjclose: [{ adjclose: [null, ...close] }],
            },
          },
        ],
      },
    };

    expect(toRow('AAPL', body)).toEqual({
      ticker: 'AAPL',
      rsi_14: 100,
      sma_50: 110.04,
      sma_200: 102.51,
      volume_spike: 2,
      risk_pct: 0.0175,
      reward_pct: 0.071429,
      stable_signal: 'Green',
      stable_explanation:
        'The 50-day SMA (110.04) is above the 200-day SMA (102.51), confirming an upward long-term trend.',
      radar_signal: 'Green',
      radar_explanation:
        'Radar triggered: reward/risk ratio is 4.08x (>= 3.0x), volume spike is 2.00x (> 1.5x), and the price (112.00) is above its 50-day SMA.',
    });
  });

  it("drops Binance's open candle and reports short history as unavailable", () => {
    const klines = [
      [0, '10', '12', '9', '10', '5', 1000],
      [1001, '10', '13', '10', '11', '6', 2000],
      [2001, '11', '99', '11', '50', '7', 9999],
    ];

    expect(toRow('BTC-USD', klines, 5000)).toEqual({
      ticker: 'BTC-USD',
      rsi_14: null,
      sma_50: null,
      sma_200: null,
      volume_spike: null,
      risk_pct: null,
      reward_pct: 0.181818,
      stable_signal: 'Red',
      stable_explanation: 'Insufficient history to compute the 50/200-day moving averages.',
      radar_signal: 'Yellow',
      radar_explanation:
        'Radar not triggered: reward/risk n/a (needs >= 3.0x); volume spike n/a (needs > 1.5x); price vs 50-day SMA: below.',
    });
  });

  it('skips tickers whose candles request failed', () => {
    expect(toRow('AAPL', { chart: { result: null, error: { code: 'Not Found' } } })).toBeNull();
    expect(toRow('BTC-USD', { code: -1121, msg: 'Invalid symbol.' })).toBeNull();
    expect(toRow('AAPL', null)).toBeNull();
  });
});
