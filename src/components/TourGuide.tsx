import { useState } from 'react';
import { Joyride, STATUS, type Styles } from 'react-joyride';
import { Compass } from 'lucide-react';
import { tourSteps } from '@/lib/tourSteps';

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

export function TourGuide({ onBeforeStart }: { onBeforeStart?: () => void }) {
  const [run, setRun] = useState(false);

  function startTour() {
    onBeforeStart?.();
    setRun(true);
  }

  return (
    <>
      <button
        type="button"
        className="tour-trigger"
        onClick={startTour}
        aria-label="Start product tour"
        title="Product tour"
      >
        <Compass size={14} />
        <span className="tour-trigger-label">Tour</span>
      </button>

      <Joyride
        run={run}
        steps={tourSteps}
        continuous
        scrollToFirstStep
        styles={joyrideStyles}
        onEvent={(data) => {
          if (data.status === STATUS.FINISHED || data.status === STATUS.SKIPPED) {
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
    </>
  );
}
