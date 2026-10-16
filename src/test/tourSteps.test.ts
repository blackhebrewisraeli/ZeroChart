import { describe, expect, it } from 'vitest';
import { tourSteps } from '@/lib/tourSteps';

describe('tourSteps', () => {
  it('defines the four recruiter-facing steps in order', () => {
    expect(tourSteps).toHaveLength(4);
    expect(tourSteps.map((step) => step.id)).toEqual([
      'welcome',
      'live-prices',
      'advanced-charting',
      'robo-advisor',
    ]);
  });

  it('targets stable, unique UI selectors', () => {
    expect(tourSteps.map((step) => step.target)).toEqual([
      '.terminal-header',
      '.connection-status',
      '.backtest-card',
      '[data-tour="robo"]',
    ]);
  });
});
