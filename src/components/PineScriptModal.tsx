import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Copy, Download, KeyRound, LineChart, X } from 'lucide-react';
import { toast } from 'sonner';
import { formatPrice } from '@/lib/assets';
import { useAuth } from '@/lib/authStore';
import { supabase } from '@/lib/supabaseClient';
import { resolveSupabaseUrl } from '@/lib/supabaseConfig';
import {
  DEFAULT_PINE_CAPITAL,
  PINE_SCRIPT_FILENAME,
  TV_WEBHOOK_PATH,
  buildAlertMessage,
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

async function copyText(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  } catch {
    toast.error(`Couldn't copy the ${label.toLowerCase()}. Select it and copy manually.`);
  }
}

function CopyField({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="pine-field">
      <span className="pine-field-label">{label}</span>
      <input value={value} readOnly spellCheck={false} aria-label={label} />
      <button
        type="button"
        className="pine-export-button"
        onClick={() => copyText(value, label)}
        aria-label={`Copy ${label}`}
      >
        <Copy size={13} /> Copy
      </button>
    </div>
  );
}

/**
 * Webhook URL, token and alert message for TradingView → Action Center.
 * Lives inside Dialog.Content, so the plaintext token is dropped when the modal closes.
 */
function ConnectTradingView() {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function generate() {
    setBusy(true);
    const { data, error } = await supabase.rpc('rotate_signal_webhook_token');
    setBusy(false);
    if (error || !data) {
      toast.error("Couldn't generate a webhook token", { description: error?.message });
      return;
    }
    setToken(data);
  }

  return (
    <section className="pine-connect" aria-labelledby="pine-connect-title">
      <h3 id="pine-connect-title">Connect TradingView</h3>
      <p>
        Send alerts to your Action Center: in the TradingView alert, tick Webhook URL, paste the URL
        below, and use the alert message as the message.
      </p>
      <CopyField label="Webhook URL" value={`${resolveSupabaseUrl()}${TV_WEBHOOK_PATH}`} />
      {token !== null && (
        <>
          <CopyField label="Webhook token" value={token} />
          <CopyField label="Alert message" value={buildAlertMessage(token)} />
          <p className="pine-connect-note">Save the token now. It is shown only once.</p>
        </>
      )}
      <p className="pine-connect-note">
        Generating a token replaces your old one. Alerts using the old token stop working.
      </p>
      <button type="button" className="pricing-basic-button" onClick={generate} disabled={busy}>
        <KeyRound size={15} /> {token === null ? 'Generate webhook token' : 'Generate a new token'}
      </button>
    </section>
  );
}

/** One-click export of the ZeroChart Quant HUD Pine Script v6 indicator. */
export function PineScriptModal({ open, onOpenChange, capital }: Readonly<PineScriptModalProps>) {
  const { user } = useAuth();
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

          <textarea
            className="pine-code"
            value={source}
            readOnly
            wrap="off"
            spellCheck={false}
            aria-label="Pine Script source"
          />

          <div className="pine-actions">
            <button type="button" className="pricing-upgrade-button" onClick={copy}>
              <Copy size={15} /> Copy Pine Script (v6)
            </button>
            <button type="button" className="pricing-basic-button" onClick={download}>
              <Download size={15} /> Download .pine
            </button>
          </div>

          {user && <ConnectTradingView />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
