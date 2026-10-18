import { describe, expect, it, vi } from 'vitest';
import { tourSteps, withViewSwitching } from '@/lib/tourSteps';

describe('tourSteps', () => {
  it('walks the flagship capabilities in order', () => {
    expect(tourSteps.map((step) => step.id)).toEqual([
      'welcome',
      'live-prices',
      'multi-factor-scanner',
      'robo-advisor',
      'institutional-backtester',
      'wealth-management',
      'pnl-attribution',
    ]);
  });

  it('targets stable selectors on the right workspace tab', () => {
    expect(tourSteps.map((step) => [step.target, step.view])).toEqual([
      ['.terminal-header', undefined],
      ['.connection-status', undefined],
      ['[data-tour="markets"]', 'scanner'],
      ['[data-tour="robo"]', 'scanner'],
      ['.backtest-card', 'portfolio'],
      ['[data-tour="wealth"]', 'portfolio'],
      ['[data-tour="pnl-attribution"]', 'portfolio'],
    ]);
  });

  it('names the v3 capabilities each step is meant to showcase', () => {
    const copy = (id: string) => String(tourSteps.find((step) => step.id === id)?.content);
    expect(copy('multi-factor-scanner')).toMatch(/Market Regime/);
    expect(copy('multi-factor-scanner')).toMatch(/Web Worker/);
    expect(copy('robo-advisor')).toMatch(/ATR position sizes/);
    expect(copy('institutional-backtester')).toMatch(/slippage.*trailing stops.*buy-and-hold/s);
    expect(copy('wealth-management')).toMatch(/Simulation and Live Tracking/);
    expect(copy('wealth-management')).toMatch(/percentages only/);
    expect(copy('pnl-attribution')).toMatch(/CSV/);
  });
});

describe('withViewSwitching', () => {
  it('switches to the step tab before Joyride looks for its target', async () => {
    const onViewChange = vi.fn();
    const steps = withViewSwitching(tourSteps, onViewChange);

    expect(steps[0]?.before).toBeUndefined();
    expect(steps.every((step) => !('view' in step))).toBe(true);

    await steps[2]?.before?.({} as never);
    expect(onViewChange).toHaveBeenLastCalledWith('scanner');
    await steps[4]?.before?.({} as never);
    expect(onViewChange).toHaveBeenLastCalledWith('portfolio');
  });
});
