import { lazy, Suspense, useMemo, useState } from 'react';
import type { Styles } from 'react-joyride';
import { Compass } from 'lucide-react';
import { tourSteps, withViewSwitching, type TourView } from '@/lib/tourSteps';

// react-joyride loads on the first Tour click, not with the workspace.
const Joyride = lazy(() => import('react-joyride').then((m) => ({ default: m.Joyride })));

const joyrideStyles: Partial<Styles> = {
  tooltip: {
    borderRadius: 14,
    border: '1px solid rgba(0, 229, 255, 0.25)',
    boxShadow: '0 0 40px rgba(0, 229, 255, 0.16)',
    fontSize: 14,
    fontFamily: "'JetBrains Mono', monospace",
  },
  tooltipContainer: { textAlign: 'left' },
  tooltipTitle: {
    color: '#00e5ff',
    fontSize: 15,
    fontWeight: 700,
    fontFamily: "'DM Sans', sans-serif",
  },
  tooltipContent: { color: '#c9d4e0', lineHeight: 1.55 },
  buttonPrimary: {
    backgroundColor: '#00e5ff',
    color: '#022430',
    borderRadius: 10,
    fontSize: 12,
    fontWeight: 700,
    fontFamily: "'JetBrains Mono', monospace",
  },
  buttonBack: { color: '#9aa4b2', fontSize: 12 },
  buttonSkip: { color: '#9aa4b2', fontSize: 12 },
};

export function TourGuide({ onViewChange }: { onViewChange: (view: TourView) => void }) {
  const [run, setRun] = useState(false);
  const steps = useMemo(() => withViewSwitching(tourSteps, onViewChange), [onViewChange]);

  return (
    <>
      <button
        type="button"
        className="tour-trigger"
        onClick={() => setRun(true)}
        aria-label="Start product tour"
        title="Product tour"
      >
        <Compass size={14} />
        <span className="tour-trigger-label">Tour</span>
      </button>

      {run && (
        <Suspense fallback={null}>
          <Joyride
            run
            steps={steps}
            continuous
            scrollToFirstStep
            styles={joyrideStyles}
            onEvent={(data) => {
              if (data.status === 'finished' || data.status === 'skipped') {
                setRun(false);
              }
            }}
            options={{
              showProgress: true,
              buttons: ['back', 'skip', 'primary'],
              primaryColor: '#00e5ff',
              backgroundColor: '#101828',
              textColor: '#e6edf3',
              overlayColor: 'rgba(2, 6, 16, 0.72)',
              arrowColor: '#101828',
              zIndex: 10000,
              width: 360,
              spotlightRadius: 12,
              spotlightPadding: 8,
            }}
          />
        </Suspense>
      )}
    </>
  );
}
