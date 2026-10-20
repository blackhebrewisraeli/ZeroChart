import type { Step } from 'react-joyride';

export type TourView = 'research' | 'paper';

/** A tour step plus the zone its target lives on (none = always mounted). */
export type TourStep = Step & { view?: TourView };

/** Tags each step with the zone its target lives on. */
const inZone = (view: TourView, steps: Step[]): TourStep[] =>
  steps.map((step) => ({ ...step, view }));

/** High-impact, recruiter-facing tour steps (react-joyride). */
export const tourSteps: TourStep[] = [
  {
    id: 'welcome',
    target: '.terminal-header',
    title: 'Welcome to ZeroChart',
    content:
      'A quantitative research and paper trading environment: research signals, then test them with simulated money. This tour switches between Research and the Paper Desk for you.',
    placement: 'bottom',
  },
  {
    id: 'live-prices',
    target: '.connection-status',
    title: 'Live Prices',
    content:
      'Real-time 600ms updates via Binance WebSockets, optimized with useSyncExternalStore to prevent render-churn.',
    placement: 'bottom',
  },
  ...inZone('research', [
    {
      id: 'multi-factor-scanner',
      target: '[data-tour="markets"]',
      title: 'Research · Explainable Multi-Factor Score',
      content:
        'Open any asset for its 0–100 Multi-Factor Score: RSI mean reversion, MACD momentum and ATR volatility, re-weighted by the detected Market Regime (Trending, Mean-Reverting, High-Volatility) with a one-line rationale. Indicator math runs in a Web Worker, so the UI never blocks.',
      placement: 'top',
    },
    {
      id: 'quant-analyzer',
      target: '[data-tour="robo"]',
      title: 'Quant Analyzer',
      content:
        'Builds a simulated portfolio from regime-weighted Multi-Factor Scores and suggests ATR position sizes that risk at most 2% of capital on a 1×ATR stop.',
      placement: 'bottom',
    },
  ]),
  ...inZone('paper', [
    {
      id: 'backtester',
      target: '.backtest-card',
      title: 'Strategy Backtest',
      content:
        'Replay the past year with realistic friction (commission + slippage in bps), percentage or ATR trailing stops, win rate, and alpha versus a buy-and-hold benchmark.',
      placement: 'top',
    },
    {
      id: 'simulated-portfolio',
      target: '[data-tour="sim-portfolio"]',
      title: 'Simulated Portfolio',
      content:
        'Simulated cash and fills only; holdings you track for real live under Account. Set target weights and Rebalancing suggests the trades to restore them once a holding drifts more than 5 pts. Every position keeps FIFO lots with cost basis including fees and slippage. Share Portfolio publishes a read-only link with percentages only: no balances or share counts.',
      placement: 'bottom',
    },
    {
      id: 'pnl-attribution',
      target: '[data-tour="pnl-attribution"]',
      title: 'P&L Attribution & Trade Ledger',
      content:
        'Unrealized vs. realized P&L and total execution drag, backed by a trade ledger below that exports to CSV in one click.',
      placement: 'top',
    },
  ]),
];

/**
 * Gives each step a `before` hook that switches to its zone first.
 * Joyride then waits for the target and skips the step if it never mounts
 * (e.g. the scanner is still loading), so the tour never stalls.
 */
export function withViewSwitching(
  steps: readonly TourStep[],
  onViewChange: (view: TourView) => void,
): Step[] {
  return steps.map(({ view, ...step }) =>
    view ? { ...step, before: async () => onViewChange(view) } : step,
  );
}
