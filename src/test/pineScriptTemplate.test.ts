import { createElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { auth, rpc } = vi.hoisted(() => ({
  auth: { user: null as { id: string } | null },
  rpc: vi.fn(),
}));
vi.mock('@/lib/authStore', () => ({ useAuth: () => auth }));
vi.mock('@/lib/supabaseClient', () => ({ supabase: { rpc } }));

import { PineScriptModal } from '@/components/PineScriptModal';
import { REGIME_WEIGHTS, type MarketRegime } from '@/lib/multiFactor';
import { buildAlertMessage, buildPineScript } from '@/lib/pineScriptTemplate';
import { parseSignal } from '../../supabase/functions/tv-webhook/payload';

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
      'input.string("Top Right", "HUD Position"',
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
      'table.set_position(hud, hudPos)',
      'bgcolor(longSignal ? color.new(C_GREEN, 90)',
      'text_size = size.normal',
      'size.large',
      '"SIGNAL / ACTION"',
      '"Confidence: "',
      '"Exit at $"',
      '"MARKET VIBE"',
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
      '\\"action\\": \\"BUY\\"',
      '{{plot(\\"ZC Score\\")}}',
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
    expect(screen.getByLabelText('Pine Script source')).toHaveValue(buildPineScript());
  });
});

describe('Connect TradingView', () => {
  afterEach(() => {
    auth.user = null;
    rpc.mockReset();
    vi.unstubAllEnvs();
  });

  it('builds an alert message the webhook accepts', () => {
    const body = JSON.parse(buildAlertMessage('tok').replace('{{ticker}}', 'BTCUSDT'));
    expect(parseSignal(body)).toMatchObject({ ok: true, token: 'tok' });
  });

  it('is hidden from signed-out users', () => {
    render(createElement(PineScriptModal, { open: true, onOpenChange: () => {} }));
    expect(screen.queryByText('Connect TradingView')).not.toBeInTheDocument();
  });

  it('mints a token and renders the webhook URL and alert message', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://demo.supabase.co');
    auth.user = { id: 'user-1' };
    rpc.mockResolvedValue({ data: 'tok123', error: null });

    render(createElement(PineScriptModal, { open: true, onOpenChange: () => {} }));

    expect(screen.getByLabelText('Webhook URL')).toHaveValue(
      'https://demo.supabase.co/functions/v1/tv-webhook',
    );
    expect(screen.getByText(/replaces your old one/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Webhook token')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Generate webhook token/ }));

    expect(await screen.findByLabelText('Webhook token')).toHaveValue('tok123');
    expect(rpc).toHaveBeenCalledWith('rotate_signal_webhook_token');
    expect(screen.getByLabelText('Alert message')).toHaveValue(
      '{"ticker":"{{ticker}}","action":"BUY","score":85,"size":500,"stop_loss":null,"secret_token":"tok123"}',
    );
  });
});
