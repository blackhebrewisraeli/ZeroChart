import * as Dialog from '@radix-ui/react-dialog';
import { Copy, Download, LineChart, X } from 'lucide-react';
import { toast } from 'sonner';
import { formatPrice } from '@/lib/assets';
import {
  DEFAULT_PINE_CAPITAL,
  PINE_SCRIPT_FILENAME,
  buildPineScript,
} from '@/lib/pineScriptTemplate';

interface PineScriptModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Portfolio capital to pre-fill (Pro); null/undefined keeps the $10k default. */
  capital?: number | null;
}

const STEPS = [
  'Open TradingView → Pine Editor',
  'Paste & click “Add to chart”',
  'Set your Account Capital & risk % in the indicator settings',
] as const;

/** One-click export of the ZeroChart Quant HUD Pine Script v6 indicator. */
export function PineScriptModal({ open, onOpenChange, capital }: PineScriptModalProps) {
  const prefilled = capital != null && Number.isFinite(capital) && capital > 0 ? capital : null;
  const source = buildPineScript(prefilled);

  async function copy() {
    try {
      // Inside the async body, a missing Clipboard API (insecure context) rejects instead of throwing.
      await navigator.clipboard.writeText(source);
      toast.success('Pine Script copied', {
        description: 'Paste it into the TradingView Pine Editor.',
      });
    } catch {
      toast.error(`Couldn't copy. Download ${PINE_SCRIPT_FILENAME} instead.`);
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = PINE_SCRIPT_FILENAME;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="pricing-overlay" />
        <Dialog.Content className="pricing-modal pine-modal" aria-describedby="pine-description">
          <div className="pricing-scanline" aria-hidden="true" />
          <Dialog.Close className="pricing-close" aria-label="Close Pine Script export">
            <X size={18} />
          </Dialog.Close>

          <header className="pricing-header">
            <span className="pricing-icon" aria-hidden="true">
              <LineChart size={18} />
            </span>
            <div>
              <Dialog.Title className="pricing-title">
                ZeroChart Quant HUD for TradingView
              </Dialog.Title>
              <Dialog.Description id="pine-description" className="pricing-description">
                Pine Script v6 overlay running the same RSI · MACD · ATR multi-factor score,
                market-regime detection and ATR position sizing as ZeroChart.
              </Dialog.Description>
            </div>
          </header>

          <p className="pine-capital">
            <span className="pricing-pro-badge">Flagship</span>
            {prefilled !== null
              ? `Account Capital pre-filled from your portfolio: ${formatPrice(prefilled)}`
              : `Account Capital defaults to ${formatPrice(DEFAULT_PINE_CAPITAL)} — Pro pre-fills it from your portfolio.`}
          </p>

          <ol className="pine-steps">
            {STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>

          <pre className="pine-code" tabIndex={0} aria-label="Pine Script source">
            <code>{source}</code>
          </pre>

          <div className="pine-actions">
            <button type="button" className="pricing-upgrade-button" onClick={copy}>
              <Copy size={15} /> Copy Pine Script (v6)
            </button>
            <button type="button" className="pricing-basic-button" onClick={download}>
              <Download size={15} /> Download .pine
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
