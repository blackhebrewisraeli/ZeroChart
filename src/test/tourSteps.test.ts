import { describe, expect, it, vi } from 'vitest';
import { tourSteps, withViewSwitching } from '@/lib/tourSteps';

describe('tourSteps', () => {
  it('walks the flagship capabilities in order', () => {
    expect(tourSteps.map((step) => step.id)).toEqual([
      'welcome',
      'live-prices',
      'multi-factor-scanner',
      'quant-analyzer',
      'backtester',
      'simulated-portfolio',
      'pnl-attribution',
    ]);
  });

  it('targets stable selectors in the right zone', () => {
    expect(tourSteps.map((step) => [step.target, step.view])).toEqual([
      ['.terminal-header', undefined],
      ['.connection-status', undefined],
      ['[data-tour="markets"]', 'research'],
      ['[data-tour="robo"]', 'research'],
      ['.backtest-card', 'paper'],
      ['[data-tour="sim-portfolio"]', 'paper'],
      ['[data-tour="pnl-attribution"]', 'paper'],
    ]);
  });

  it('names the v3 capabilities each step is meant to showcase', () => {
    const copy = (id: string) => String(tourSteps.find((step) => step.id === id)?.content);
    expect(copy('multi-factor-scanner')).toMatch(/Market Regime/);
    expect(copy('multi-factor-scanner')).toMatch(/Web Worker/);
    expect(copy('quant-analyzer')).toMatch(/ATR position sizes/);
    expect(copy('backtester')).toMatch(/slippage.*trailing stops.*buy-and-hold/s);
    expect(copy('simulated-portfolio')).toMatch(/Simulated cash.*under Account/s);
    expect(copy('simulated-portfolio')).toMatch(/percentages only/);
    expect(copy('pnl-attribution')).toMatch(/CSV/);
  });
});

describe('withViewSwitching', () => {
  it('switches to the step zone before Joyride looks for its target', async () => {
    const onViewChange = vi.fn();
    const steps = withViewSwitching(tourSteps, onViewChange);

    expect(steps[0]?.before).toBeUndefined();
    expect(steps.every((step) => !('view' in step))).toBe(true);

    await steps[2]?.before?.({} as never);
    expect(onViewChange).toHaveBeenLastCalledWith('research');
    await steps[4]?.before?.({} as never);
    expect(onViewChange).toHaveBeenLastCalledWith('paper');
  });
});
