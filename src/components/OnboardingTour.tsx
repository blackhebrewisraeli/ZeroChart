import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, type MotionStyle, type Transition } from 'framer-motion';
import { Compass } from 'lucide-react';
import { cn } from '@/lib/utils';

const STORAGE_KEY = 'zerochart:onboarding-seen';
const SPRING: Transition = { type: 'spring', stiffness: 320, damping: 30 };
const GAP = 16;
const TIP_MAX_WIDTH = 340;

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface TourStep {
  id: string;
  target: string;
  title: string;
  description: string;
}

const STEPS: TourStep[] = [
  {
    id: 'hero',
    target: '[data-tour="hero"]',
    title: 'Top Signal',
    description:
      'Your highest-conviction opportunity, updated live. ZeroChart surfaces the strongest signal so you can start here.',
  },
  {
    id: 'markets',
    target: '[data-tour="markets"]',
    title: 'Markets & Alerts',
    description:
      "Scan live prices across Crypto, Stocks and Forex. Tap the bell on any asset to set a price alert you don't have to babysit.",
  },
  {
    id: 'robo',
    target: '[data-tour="robo"]',
    title: 'Robo-Advisor',
    description:
      "Tell us how much to invest and your risk tolerance, and we'll build (and let you swap) a portfolio — with a long-term projection.",
  },
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function spotlightRect(rect: Rect): Rect {
  if (typeof window === 'undefined') return rect;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pad = 6;
  return {
    left: clamp(rect.left - pad, 0, vw),
    top: clamp(rect.top - pad, 0, vh),
    width: Math.min(rect.width + pad * 2, vw),
    height: Math.min(rect.height + pad * 2, vh - 32),
  };
}

function tipStyleFor(rect: Rect | null): MotionStyle {
  if (!rect || typeof window === 'undefined') return {};
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(TIP_MAX_WIDTH, vw - 32);
  const estimatedHeight = 200;
  let top = rect.top + rect.height + GAP;
  if (top + estimatedHeight > vh - 12) top = rect.top - GAP - estimatedHeight;
  const left = clamp(rect.left + rect.width / 2 - width / 2, 12, vw - width - 12);
  return { left, top: clamp(top, 12, vh - estimatedHeight - 12), width };
}

export function OnboardingTour({ ready = true }: { ready?: boolean }) {
  const [active, setActive] = useState(false);
  const [step, setStep] = useState(0);
  const [targetRect, setTargetRect] = useState<Rect | null>(null);

  const startedRef = useRef(false);
  const current = STEPS[step];

  function start() {
    setStep(0);
    setActive(true);
  }

  const finish = useCallback(() => {
    setActive(false);
    try {
      window.localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // Ignore private-mode / quota errors — the tour still dismisses.
    }
  }, []);

  function next() {
    if (step >= STEPS.length - 1) finish();
    else setStep((s) => s + 1);
  }

  function back() {
    setStep((s) => Math.max(0, s - 1));
  }

  // Auto-start once for first-time visitors, after content is ready.
  useEffect(() => {
    if (!ready || startedRef.current) return;
    startedRef.current = true;
    let seen = false;
    try {
      seen = window.localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      seen = false;
    }
    if (seen) return;
    const timer = window.setTimeout(start, 700);
    return () => window.clearTimeout(timer);
  }, [ready]);

  // Locate + track the active target, retrying until the element exists.
  useLayoutEffect(() => {
    if (!active || !current) return;
    const target = current.target;
    let cancelled = false;
    let retryTimer: number | undefined;

    function locate() {
      const el = document.querySelector<HTMLElement>(target);
      if (!el) {
        setTargetRect(null);
        if (!cancelled) retryTimer = window.setTimeout(locate, 250);
        return;
      }
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTargetRect(el.getBoundingClientRect());
    }

    locate();

    function remeasure() {
      const el = document.querySelector<HTMLElement>(target);
      if (el) setTargetRect(el.getBoundingClientRect());
    }
    window.addEventListener('resize', remeasure);
    window.addEventListener('scroll', remeasure, true);

    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      window.removeEventListener('resize', remeasure);
      window.removeEventListener('scroll', remeasure, true);
    };
  }, [active, current]);

  // Escape dismisses the tour.
  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') finish();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, finish]);

  const spotlight = targetRect ? spotlightRect(targetRect) : null;
  const tipStyle = tipStyleFor(targetRect);

  return (
    <>
      <button
        type="button"
        className="tour-trigger"
        onClick={start}
        aria-label="Start product tour"
        title="Product tour"
      >
        <Compass size={14} />
        <span className="tour-trigger-label">Tour</span>
      </button>

      {active &&
        spotlight &&
        current &&
        createPortal(
          <>
            <div className="tour-backdrop" onClick={finish} />
            <motion.div
              className="tour-spotlight"
              initial={false}
              animate={{
                x: spotlight.left,
                y: spotlight.top,
                width: spotlight.width,
                height: spotlight.height,
              }}
              transition={SPRING}
            />
            <motion.div
              key={`tip-${step}`}
              className="tour-tooltip"
              style={tipStyle}
              initial={{ opacity: 0, y: 14, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={SPRING}
              role="dialog"
              aria-label={current.title}
            >
              <div className="tour-tooltip-head">
                <span className="tour-step">
                  {step + 1} / {STEPS.length}
                </span>
                <span className="tour-title">{current.title}</span>
              </div>
              <p className="tour-desc">{current.description}</p>
              <div className="tour-dots" aria-hidden="true">
                {STEPS.map((s, i) => (
                  <span key={s.id} className={cn('tour-dot', i === step && 'is-active')} />
                ))}
              </div>
              <div className="tour-actions">
                <button type="button" className="tour-skip" onClick={finish}>
                  Skip
                </button>
                <div className="tour-nav">
                  {step > 0 && (
                    <button type="button" className="tour-back" onClick={back}>
                      Back
                    </button>
                  )}
                  <button type="button" className="tour-next" onClick={next}>
                    {step >= STEPS.length - 1 ? 'Done' : 'Next'}
                  </button>
                </div>
              </div>
            </motion.div>
          </>,
          document.body,
        )}
    </>
  );
}
