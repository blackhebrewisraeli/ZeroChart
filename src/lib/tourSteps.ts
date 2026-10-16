import type { Step } from 'react-joyride';

/** High-impact, recruiter-facing tour steps (react-joyride). */
export const tourSteps: Step[] = [
  {
    id: 'welcome',
    target: '.terminal-header',
    title: 'Welcome to ZeroChart',
    content: "Let's explore the enterprise-grade financial engine.",
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
    id: 'advanced-charting',
    target: '.backtest-card',
    title: 'Advanced Charting',
    content:
      '60FPS Canvas rendering with Web Worker-offloaded SMA, RSI, and backtest calculations.',
    placement: 'top',
  },
  {
    id: 'robo-advisor',
    target: '[data-tour="robo"]',
    title: 'Robo-Advisor',
    content: 'Quantitative scoring model using inverse volatility and technical indicators.',
    placement: 'bottom',
  },
];
