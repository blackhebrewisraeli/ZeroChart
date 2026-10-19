/**
 * ZeroChart Quant HUD & ATR Risk Engine — the Pine Script v6 port of
 * `multiFactor.ts` / `indicators.ts` / `risk.ts` that users load into
 * TradingView. `pine/zerochart_quant_hud.pine` is the single source; this
 * module only ships it to the app and pre-fills the Account Capital input.
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
