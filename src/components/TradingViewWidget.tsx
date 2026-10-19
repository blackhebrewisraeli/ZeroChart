import { useEffect, useRef } from 'react';
import { useTheme } from 'next-themes';
import { CandlestickChart } from 'lucide-react';

const SCRIPT_SRC = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';

// Vitest runs with MODE 'test': render a placeholder so tests never fetch
// third-party scripts. Vite inlines MODE, so this branch is dropped in builds.
const IS_TEST = import.meta.env.MODE === 'test';

const PALETTE = {
  dark: { background: '#101828', grid: 'rgba(255, 255, 255, 0.06)' },
  light: { background: '#ffffff', grid: 'rgba(16, 24, 40, 0.06)' },
} as const;

/**
 * TradingView's free Advanced Chart embed (drawing tools, volume, RSI/MACD,
 * interval selector), re-mounted whenever the symbol or app theme changes.
 * Fills its parent, which must have a defined height.
 */
export function TradingViewWidget({ symbol }: { symbol: string }) {
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === 'light' ? 'light' : 'dark';
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const widget = document.createElement('div');
    widget.className = 'tradingview-widget-container__widget';
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.type = 'text/javascript';
    script.async = true;
    // The embed script reads its own body as the widget config.
    script.textContent = JSON.stringify({
      autosize: true,
      symbol,
      interval: 'D',
      timezone: 'Etc/UTC',
      theme,
      style: '1',
      locale: 'en',
      backgroundColor: PALETTE[theme].background,
      gridColor: PALETTE[theme].grid,
      allow_symbol_change: true,
      hide_side_toolbar: false,
      withdateranges: true,
      calendar: false,
      studies: ['STD;RSI', 'STD;MACD'],
      support_host: 'https://www.tradingview.com',
    });
    const settled = new Promise<void>((resolve) => {
      script.onload = script.onerror = () => resolve();
    });
    host.replaceChildren(widget, script);
    // The async embed script reads `script.parentNode` and its iframe's
    // contentWindow when it runs, and throws/logs if a fast unmount (chart
    // toggle, modal close) detached them first. Park the old nodes in a hidden,
    // attached holder (same class, so the script builds its iframe in place)
    // until the script has run, then drop them.
    return () => {
      const parked = document.createElement('div');
      parked.className = 'tradingview-widget-container';
      parked.hidden = true;
      parked.append(...host.childNodes);
      document.body.append(parked);
      void settled.then(() => parked.remove());
    };
  }, [symbol, theme]);

  return (
    <div className="tv-widget" style={{ background: PALETTE[theme].background }}>
      {IS_TEST ? (
        <div className="asset-chart-fallback" data-testid="tradingview-placeholder">
          <CandlestickChart size={22} />
          <span>TradingView Pro · {symbol}</span>
        </div>
      ) : (
        <div ref={hostRef} className="tradingview-widget-container" />
      )}
      <a
        className="tv-widget-copyright"
        href="https://www.tradingview.com/"
        target="_blank"
        rel="noopener nofollow noreferrer"
      >
        Charts by TradingView
      </a>
    </div>
  );
}
