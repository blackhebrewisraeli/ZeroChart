import type { Step } from 'react-joyride';

export type TourView = 'scanner' | 'portfolio';

/** A tour step plus the workspace tab its target lives on (none = always mounted). */
export type TourStep = Step & { view?: TourView };

/** High-impact, recruiter-facing tour steps (react-joyride). */
export const tourSteps: TourStep[] = [
  {
    id: 'welcome',
    target: '.terminal-header',
    title: 'Welcome to ZeroChart',
    content:
      'One engine, zero noise: a quant terminal for signals, backtests and portfolio accounting. This tour switches between the Scanner and Portfolio workspaces for you.',
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
  {
    id: 'multi-factor-scanner',
    view: 'scanner',
    target: '[data-tour="markets"]',
    title: 'Scanner · Explainable Multi-Factor Score',
    content:
      'Open any asset for its 0–100 Multi-Factor Score: RSI mean reversion, MACD momentum and ATR volatility, re-weighted by the detected Market Regime (Trending, Mean-Reverting, High-Volatility) with a one-line rationale. Indicator math runs in a Web Worker, so the UI never blocks.',
    placement: 'top',
  },
  {
    id: 'robo-advisor',
    view: 'scanner',
    target: '[data-tour="robo"]',
    title: 'Robo-Advisor',
    content:
      'Builds a portfolio from regime-weighted Multi-Factor Scores and suggests ATR position sizes that risk at most 2% of capital on a 1×ATR stop.',
    placement: 'bottom',
  },
  {
    id: 'institutional-backtester',
    view: 'portfolio',
    target: '.backtest-card',
    title: 'Institutional Backtester',
    content:
      'Replay the past year with realistic friction (commission + slippage in bps), percentage or ATR trailing stops, win rate, and alpha versus a buy-and-hold benchmark.',
    placement: 'top',
  },
  {
    id: 'wealth-management',
    view: 'portfolio',
    target: '[data-tour="wealth"]',
    title: 'Wealth Management',
    content:
      'Switch between Simulation and Live Tracking. Set target weights and Rebalancing suggests the trades to restore them once a holding drifts more than 5 pts. Every position keeps FIFO lots with cost basis including fees and slippage. Share Portfolio publishes a read-only link with percentages only: no balances or share counts.',
    placement: 'bottom',
  },
  {
    id: 'pnl-attribution',
    view: 'portfolio',
    target: '[data-tour="pnl-attribution"]',
    title: 'P&L Attribution & Trade Ledger',
    content:
      'Unrealized vs. realized P&L and total execution drag, backed by a trade ledger below that exports to CSV in one click.',
    placement: 'top',
  },
];

/**
 * Gives each step a `before` hook that switches to its workspace tab first.
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
