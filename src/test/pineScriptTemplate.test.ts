import { createElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PineScriptModal } from '@/components/PineScriptModal';
import { REGIME_WEIGHTS, type MarketRegime } from '@/lib/multiFactor';
import { buildPineScript } from '@/lib/pineScriptTemplate';

const DEFAULT_CAPITAL_INPUT = 'input.float(10000, "Account Capital ($)"';

describe('buildPineScript', () => {
  const source = buildPineScript();

  it('emits a Pine Script v6 overlay indicator with the required inputs', () => {
    expect(source.startsWith('//@version=6\n')).toBe(true);
    expect(source).toContain(
      'indicator("ZeroChart Quant HUD & Risk Engine", shorttitle = "ZC Quant", overlay = true)',
    );
    for (const input of [
      DEFAULT_CAPITAL_INPUT,
      'input.float(2.0, "Risk per Trade (%)"',
      'input.int(14, "ATR Period"',
      'input.float(2.0, "ATR Trailing Stop Multiplier"',
      'input.bool(true, "Show ZeroChart Quant HUD Table"',
      'input.bool(true, "Plot ATR Trailing Stop"',
      'input.bool(true, "Show High-Conviction Signal Labels"',
    ]) {
      expect(source).toContain(input);
    }
  });

  it('carries every factor, sizing, overlay and alert equation', () => {
    for (const fragment of [
      'ta.rsi(close, 14)',
      'ta.macd(close, 12, 26, 9)',
      'ta.atr(atrPeriod)',
      'macdHist / close',
      'atrValue / close',
      // RSI mean-reversion curve control points.
      '100.0 + (95.0 - 100.0)',
      '95.0 + (55.0 - 95.0)',
      '55.0 + (15.0 - 55.0)',
      '15.0 + (0.0 - 15.0)',
      // ±1% momentum saturation and the 0.5%–5.5% volatility band.
      'MOMENTUM_SATURATION      = 0.01',
      'LOW_VOLATILITY           = 0.005',
      'HIGH_VOLATILITY          = 0.055',
      'REGIME_HIGH_VOLATILITY   = 0.04',
      'REGIME_TRENDING_MOMENTUM = 0.005',
      'riskDollars = accountCapital * (riskPct / 100.0)',
      'stopDistance = atrValue * atrStopMult',
      'riskDollars / stopDistance',
      'close - stopDistance',
      'table.new(position.top_right',
      '#101828',
      '#1e293b',
      '#00e5ff',
      '#00e676',
      '#ff5252',
      'text = "ZC LONG"',
      'text = "ZC RISK"',
      'score >= 78',
      'score <= 28',
      'score >= 80',
    ]) {
      expect(source).toContain(fragment);
    }
    expect(source.match(/^alertcondition\(/gm)).toHaveLength(3);
  });

  it('tilts weights exactly like REGIME_WEIGHTS in multiFactor.ts', () => {
    const read = (text: string, name: string) =>
      Number(text.match(new RegExp(`${name} :?= ([\\d.]+)`))?.[1]);
    const neutral = {
      rsi: read(source, 'float wRsi'),
      momentum: read(source, 'float wMomentum'),
      volatility: read(source, 'float wVolatility'),
    };
    for (const regime of Object.keys(REGIME_WEIGHTS) as MarketRegime[]) {
      // The regime's if-branch: its line plus the 4-space-indented lines after it.
      const marker = source.indexOf(`regime := "${regime}"`);
      const branch =
        regime === 'NEUTRAL' ? '' : (source.slice(marker).split(/\n(?! {4})/)[0] ?? '');
      const pick = (name: string, fallback: number) =>
        branch.includes(`${name} :=`) ? read(branch, name) : fallback;
      expect({
        rsi: pick('wRsi', neutral.rsi),
        momentum: pick('wMomentum', neutral.momentum),
        volatility: pick('wVolatility', neutral.volatility),
      }).toEqual(REGIME_WEIGHTS[regime]);
    }
  });

  it('injects positive portfolio capital and keeps the $10k default otherwise', () => {
    const injected = buildPineScript(25_000.5);
    expect(injected).toContain('input.float(25000.50, "Account Capital ($)"');
    expect(injected).not.toContain(DEFAULT_CAPITAL_INPUT);

    for (const invalid of [undefined, null, 0, -500, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(buildPineScript(invalid)).toBe(source);
    }
  });
});

describe('PineScriptModal', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('copies the capital-injected Pine Script to the clipboard', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(createElement(PineScriptModal, { open: true, onOpenChange: () => {}, capital: 42_000 }));

    expect(screen.getByText(/pre-filled from your portfolio: \$42,000\.00/)).toBeInTheDocument();
    expect(screen.getByText('Open TradingView → Pine Editor')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Copy Pine Script \(v6\)/ }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0]?.[0] ?? '';
    expect(copied.startsWith('//@version=6')).toBe(true);
    expect(copied).toContain('input.float(42000.00, "Account Capital ($)"');
  });

  it('falls back to the default capital when none is provided', () => {
    render(createElement(PineScriptModal, { open: true, onOpenChange: () => {} }));
    expect(screen.getByText(/defaults to \$10,000\.00/)).toBeInTheDocument();
    expect(screen.getByLabelText('Pine Script source')).toHaveTextContent(DEFAULT_CAPITAL_INPUT);
  });
});
