/**
 * ZeroChart Quant HUD & ATR Risk Engine — the Pine Script v6 port of
 * `multiFactor.ts` / `indicators.ts` / `risk.ts` that users load into
 * TradingView. The HUD is action-first (SIGNAL / SIGNAL SCORE / SIZE / STOP /
 * VIBE); alerts emit the `tv-webhook` JSON contract. `pine/zerochart_quant_hud.pine`
 * is the single source; this module ships it with Account Capital and the
 * webhook token pre-filled.
 */
import PINE_SOURCE from '../../pine/zerochart_quant_hud.pine?raw';
import { SECRET_PLACEHOLDER } from '../../supabase/functions/tv-webhook/payload';

export const PINE_SCRIPT_FILENAME = 'zerochart_quant_hud.pine';
export const DEFAULT_PINE_CAPITAL = 10_000;

const CAPITAL_INPUT = `input.float(${DEFAULT_PINE_CAPITAL}, "Account Capital ($)"`;
/** rotate_signal_webhook_token() mints hex; anything else could break out of a Pine string. */
const SAFE_TOKEN = /^[A-Za-z0-9_-]+$/;

/**
 * The Pine Script source with `capital` as the Account Capital default and
 * `token` in place of USER_SECRET_PLACEHOLDER in every alert payload.
 * Missing, non-finite or non-positive capital keeps the $10,000 default;
 * a missing or malformed token keeps the placeholder.
 */
export function buildPineScript(capital?: number | null, token?: string | null): string {
  let source = PINE_SOURCE;
  if (capital != null && Number.isFinite(capital) && capital > 0) {
    // Function replacer: the input label contains "$", which a string replacement would parse.
    source = source.replace(
      CAPITAL_INPUT,
      () => `input.float(${capital.toFixed(2)}, "Account Capital ($)"`,
    );
  }
  if (token && SAFE_TOKEN.test(token)) source = source.replaceAll(SECRET_PLACEHOLDER, token);
  return source;
}

/** Path of the `tv-webhook` edge function under the Supabase project URL. */
export const TV_WEBHOOK_PATH = '/functions/v1/tv-webhook';
