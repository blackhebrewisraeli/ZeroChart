import { lazy, Suspense, useMemo, useState } from 'react';
import type { Styles } from 'react-joyride';
import { Compass } from 'lucide-react';
import { tourSteps, withViewSwitching, type TourView } from '@/lib/tourSteps';

// react-joyride loads on the first Tour click, not with the workspace.
const Joyride = lazy(() => import('react-joyride').then((m) => ({ default: m.Joyride })));

const joyrideStyles: Partial<Styles> = {
  tooltip: {
    borderRadius: 14,
    border: '1px solid rgba(255, 255, 255, 0.1)',
    boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 24px 48px -16px rgba(0, 0, 0, 0.6)',
    fontSize: 14,
    fontFamily: "'JetBrains Mono', monospace",
  },
  tooltipContainer: { textAlign: 'left' },
  tooltipTitle: {
    color: '#60ceef',
    fontSize: 15,
    fontWeight: 600,
    fontFamily: "'DM Sans', sans-serif",
  },
  tooltipContent: { color: '#a1a1aa', lineHeight: 1.55 },
  buttonPrimary: {
    backgroundColor: '#60ceef',
    color: '#022430',
    borderRadius: 10,
    fontSize: 12,
    fontWeight: 600,
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
              primaryColor: '#60ceef',
              backgroundColor: '#0f0f12',
              textColor: '#f4f4f5',
              overlayColor: 'rgba(0, 0, 0, 0.75)',
              arrowColor: '#0f0f12',
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
