/**
 * ZeroChart Quant HUD & ATR Risk Engine — the Pine Script v6 port of
 * `multiFactor.ts` / `indicators.ts` / `risk.ts` that users load into
 * TradingView. The HUD is action-first (SIGNAL / CONFIDENCE / SIZE / STOP /
 * VIBE); alerts emit JSON for `tv-webhook`. `pine/zerochart_quant_hud.pine`
 * is the single source; this module ships it and pre-fills Account Capital.
 */
import PINE_SOURCE from '../../pine/zerochart_quant_hud.pine?raw';

export const PINE_SCRIPT_FILENAME = 'zerochart_quant_hud.pine';
export const DEFAULT_PINE_CAPITAL = 10_000;

const CAPITAL_INPUT = `input.float(${DEFAULT_PINE_CAPITAL}, "Account Capital ($)"`;

/**
 * The Pine Script source with `capital` as the Account Capital default.
 * Missing, non-finite or non-positive capital keeps the $10,000 default.
 */
export function buildPineScript(capital?: number | null): string {
  if (capital == null || !Number.isFinite(capital) || capital <= 0) return PINE_SOURCE;
  // Function replacer: the input label contains "$", which a string replacement would parse.
  return PINE_SOURCE.replace(
    CAPITAL_INPUT,
    () => `input.float(${capital.toFixed(2)}, "Account Capital ($)"`,
  );
}

/** Path of the `tv-webhook` edge function under the Supabase project URL. */
export const TV_WEBHOOK_PATH = '/functions/v1/tv-webhook';

/**
 * TradingView alert message for `tv-webhook`; TradingView fills `{{ticker}}`.
 * `stop_loss` is null because the webhook rejects a stop of 0.
 */
export function buildAlertMessage(token: string): string {
  return JSON.stringify({
    ticker: '{{ticker}}',
    action: 'BUY',
    score: 85,
    size: 500,
    stop_loss: null,
    secret_token: token,
  });
}
