import {
  Activity,
  ArrowRight,
  Bot,
  Cloud,
  History,
  ShieldCheck,
  Sparkles,
  Zap,
  type LucideIcon,
} from 'lucide-react';

interface Feature {
  icon: LucideIcon;
  title: string;
  description: string;
}

const FEATURES: Feature[] = [
  {
    icon: Bot,
    title: 'AI Robo-Advisor',
    description:
      'Turn a risk profile and capital into a balanced, signal-ranked portfolio in one click.',
  },
  {
    icon: Activity,
    title: 'Live Binance Data',
    description:
      'Stream real-time crypto prices over WebSockets with deterministic green/red flashes.',
  },
  {
    icon: History,
    title: '1-Year Backtesting',
    description:
      'Replay any allocation against a year of daily history to see how it would have grown.',
  },
  {
    icon: Cloud,
    title: 'Cloud Sync',
    description:
      'Save your portfolio to Supabase and pick up right where you left off on any device.',
  },
];

const STATS = [
  { value: '3', label: 'Asset classes' },
  { value: '365d', label: 'Backtest window' },
  { value: 'Live', label: 'Binance feed' },
  { value: 'Cloud', label: 'Synced portfolios' },
];

function BrandMark() {
  return (
    <a href="/" className="flex shrink-0 items-center gap-2.5" aria-label="ZeroChart home">
      <span className="brand-mark">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
          <path
            d="M4 6.5h16L4 17.5h16"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span className="brand-wordmark font-semibold">
        zerochart<span className="text-primary">.</span>
      </span>
    </a>
  );
}

export function LandingPage({
  onSignIn,
  onGetStarted,
}: {
  onSignIn: () => void;
  onGetStarted: () => void;
}) {
  return (
    <div className="landing">
      <header className="landing-header">
        <div className="page-width landing-nav">
          <BrandMark />
          <div className="landing-nav-actions">
            <button type="button" className="landing-ghost-button" onClick={onSignIn}>
              Sign In
            </button>
            <button type="button" className="landing-cta-button" onClick={onGetStarted}>
              Get Started <ArrowRight size={15} />
            </button>
          </div>
        </div>
      </header>

      <main>
        <section className="landing-hero">
          <div className="landing-hero-glow" aria-hidden="true" />
          <div className="page-width landing-hero-inner">
            <span className="landing-badge">
              <Sparkles size={14} /> The zero-knowledge terminal
            </span>
            <h1 className="landing-headline">
              Algorithmic Portfolio Management.
              <span className="landing-headline-accent"> Zero Knowledge Required.</span>
            </h1>
            <p className="landing-subheadline">
              ZeroChart turns raw market data into one high-signal workspace — AI portfolios, live
              Binance prices, and one-year backtests, wrapped in a terminal you&apos;ll actually
              enjoy using.
            </p>
            <div className="landing-cta">
              <button
                type="button"
                className="landing-cta-button landing-cta-button-lg"
                onClick={onGetStarted}
              >
                Get Started Free <ArrowRight size={16} />
              </button>
              <a href="#features" className="landing-ghost-button landing-ghost-button-lg">
                Explore Features
              </a>
            </div>
            <div className="landing-stats">
              {STATS.map((stat) => (
                <div key={stat.label} className="landing-stat">
                  <span className="landing-stat-value">{stat.value}</span>
                  <span className="landing-stat-label">{stat.label}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="features" className="landing-features">
          <div className="page-width">
            <div className="landing-section-head">
              <h2 className="landing-section-title">Built for the signal, not the noise</h2>
              <p className="landing-section-sub">
                Everything you need to research, build, and stress-test a portfolio — without
                touching a single spreadsheet.
              </p>
            </div>
            <div className="landing-grid">
              {FEATURES.map(({ icon: Icon, title, description }) => (
                <div key={title} className="landing-card">
                  <span className="landing-card-icon">
                    <Icon size={20} />
                  </span>
                  <h3 className="landing-card-title">{title}</h3>
                  <p className="landing-card-desc">{description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="landing-final-cta">
          <div className="page-width">
            <div className="landing-final-card">
              <ShieldCheck size={22} className="landing-final-icon" />
              <h2 className="landing-final-title">Your terminal is one click away</h2>
              <p className="landing-final-sub">
                Create a free account and start simulating your first portfolio in seconds.
              </p>
              <button
                type="button"
                className="landing-cta-button landing-cta-button-lg"
                onClick={onGetStarted}
              >
                Get Started Free <ArrowRight size={16} />
              </button>
            </div>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="page-width landing-footer-inner">
          <div className="flex items-center gap-2">
            <Zap size={13} />
            <span>Algorithmic signals. Live charts. Zero noise.</span>
          </div>
          <span>AI analysis is informational. Not financial advice.</span>
          <span className="font-mono text-[10px]">ZEROCHART</span>
        </div>
      </footer>
    </div>
  );
}
