import { useEffect, useState, type ReactNode } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ChevronDown, NotebookText, RefreshCw } from 'lucide-react';
import { formatPrice, formatSignedPercent } from '@/lib/assets';
import { isDevAuthUser } from '@/lib/authStore';
import { loadJournalPage } from '@/lib/db';
import {
  formatElapsed,
  journalEntry,
  JOURNAL_STATES,
  STATE_LABELS,
  summarizeJournal,
  tickerQuery,
  type JournalCursor,
  type JournalEntry,
  type RecordedStatus,
} from '@/lib/decisionJournal';
import { usePortfolio } from '@/lib/portfolioStore';
import { Shares } from '@/components/Shares';
import { cn } from '@/lib/utils';

const NOT_RECORDED = 'Not recorded';
const KIND_LABELS: Record<string, string> = {
  strategy: 'Strategy',
  transport_test: 'Transport test',
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A stored timestamp in local time, with the stored ISO value as its tooltip. */
function Time({ value }: Readonly<{ value: string | null }>) {
  if (!value) return <>{NOT_RECORDED}</>;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <>{value}</>;
  return (
    <time dateTime={date.toISOString()} title={date.toISOString()}>
      {date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'long' })}
    </time>
  );
}

function Fact({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children ?? NOT_RECORDED}</dd>
    </div>
  );
}

const price = (value: number | null) => (value === null ? NOT_RECORDED : formatPrice(value));

function priceChange(pct: number | null): string {
  if (pct === null) return 'Not available: the signal price was not recorded';
  if (pct === 0) return '0.00%: the fill matched the signal price';
  return `${formatSignedPercent(pct)} (fill ${pct > 0 ? 'above' : 'below'} the signal price)`;
}

function EntryItem({ entry }: Readonly<{ entry: JournalEntry }>) {
  const { signal, fill, comparison, state, notes } = entry;
  return (
    <li>
      <details className="journal-entry" data-state={state}>
        <summary>
          <span className="journal-when">
            <Time value={signal.created_at} />
            <small>Server receipt</small>
          </span>
          <span className="journal-signal">
            <span className="ledger-side" data-side={signal.action === 'BUY' ? 'buy' : 'sell'}>
              {signal.action}
            </span>
            <strong>{signal.ticker}</strong>
            <span className="journal-kind">
              {signal.signal_kind
                ? (KIND_LABELS[signal.signal_kind] ?? signal.signal_kind)
                : 'Kind not recorded'}
            </span>
          </span>
          <span className="journal-badges">
            <span className="journal-state" data-state={state}>
              {STATE_LABELS[state]}
            </span>
            {!entry.provenanceComplete && (
              <span className="journal-incomplete">Provenance incomplete</span>
            )}
          </span>
          {comparison && (
            <span className="journal-headline">
              {price(comparison.signalPrice)} → {price(comparison.fillPrice)}
            </span>
          )}
          <ChevronDown size={16} className="journal-chevron" aria-hidden="true" />
        </summary>
        <div className="journal-detail">
          {notes.length > 0 && (
            <ul className="journal-notes" aria-label="Evidence findings">
              {notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
          <section aria-label="Provenance">
            <h4>Provenance</h4>
            <dl>
              <Fact label="Exchange">{signal.exchange}</Fact>
              <Fact label="Timeframe">{signal.timeframe}</Fact>
              <Fact label="Model">{signal.model_version}</Fact>
              <Fact label="Delivery ID">{signal.event_id}</Fact>
            </dl>
          </section>
          <section aria-label="Timestamps">
            <h4>Timestamps</h4>
            <dl>
              <Fact label="Bar time (bar open)">
                <Time value={signal.bar_time} />
              </Fact>
              <Fact label="Provider event time">{NOT_RECORDED}</Fact>
              <Fact label="Server receipt">
                <Time value={signal.created_at} />
              </Fact>
              <Fact label="Fill time (booking)">
                {fill ? <Time value={fill.created_at} /> : 'No linked fill'}
              </Fact>
            </dl>
          </section>
          <section aria-label="Signal">
            <h4>Signal</h4>
            <dl>
              <Fact label="Recorded status">{signal.status}</Fact>
              <Fact label="Model Signal Score">{`${signal.signal_score} / 100`}</Fact>
              <Fact label="Quantity">
                <Shares value={signal.quantity} /> units
              </Fact>
              <Fact label="Signal price">{price(signal.price)}</Fact>
              <Fact label="Planned stop">
                {signal.stop_loss === null ? null : price(signal.stop_loss)}
              </Fact>
              {signal.status === 'DISMISSED' && (
                <Fact label="Dismissal time and reason">{NOT_RECORDED}</Fact>
              )}
              {state === 'awaiting' && (
                <Fact label="Current eligibility">
                  Checked when you review it in the Action Center
                </Fact>
              )}
            </dl>
          </section>
          <section aria-label="Execution">
            <h4>Execution</h4>
            {fill && comparison ? (
              <>
                <dl>
                  <Fact label="Booked as">{fill.ticker}</Fact>
                  <Fact label="Executed quantity">
                    {fill.quantity === null ? null : (
                      <>
                        <Shares value={fill.quantity} /> units
                      </>
                    )}
                  </Fact>
                  <Fact label="Executed price">{price(comparison.fillPrice)}</Fact>
                  <Fact label="Recorded fee">{formatPrice(comparison.fees)}</Fact>
                  <Fact label="Signal-to-fill price change">
                    {priceChange(comparison.priceChangePct)}
                  </Fact>
                  <Fact label="Receipt to booking">
                    {comparison.elapsedMs === null ? null : formatElapsed(comparison.elapsedMs)}
                  </Fact>
                  <Fact label="Historical risk checks">{NOT_RECORDED}</Fact>
                </dl>
                <p className="journal-caveat">
                  A simulated paper fill: it doesn&apos;t show what a real exchange would have
                  filled. The price change includes the market&apos;s move and the time before the
                  trade was executed, so it isn&apos;t execution slippage.
                </p>
              </>
            ) : (
              <p className="journal-caveat">No fill is linked to this signal.</p>
            )}
          </section>
        </div>
      </details>
    </li>
  );
}

function Summary({
  entries,
  total,
  asOf,
}: Readonly<{ entries: JournalEntry[]; total: number | null; asOf: number }>) {
  const summary = summarizeJournal(entries);
  return (
    <p className="journal-summary" aria-live="polite">
      <span>
        Showing {summary.loaded}
        {total === null ? '' : ` of ${total}`} {total === 1 ? 'signal' : 'signals'}
      </span>
      {JOURNAL_STATES.filter((state) => summary.states[state] > 0).map((state) => (
        <span key={state} className="journal-state" data-state={state}>
          {summary.states[state]} {STATE_LABELS[state].toLowerCase()}
        </span>
      ))}
      {summary.provenanceIncomplete > 0 && (
        <span className="journal-incomplete">
          {summary.provenanceIncomplete} provenance incomplete
        </span>
      )}
      <span className="journal-asof">
        As of <Time value={new Date(asOf).toISOString()} />
      </span>
    </p>
  );
}

function useJournal(userId: string | null, ticker: string, status: RecordedStatus | null) {
  return useInfiniteQuery({
    queryKey: ['decision-journal', userId, ticker, status],
    queryFn: ({ pageParam }) => loadJournalPage(userId ?? '', { ticker, status }, pageParam),
    initialPageParam: null as JournalCursor | null,
    getNextPageParam: (page) => page.next,
    // The dev stub has no session to read with.
    enabled: userId !== null && !isDevAuthUser(userId),
    // postgrest-js already retries a GET that fails on the network.
    retry: false,
  });
}

type JournalQuery = ReturnType<typeof useJournal>;

function JournalList({
  query,
  entries,
}: Readonly<{ query: JournalQuery; entries: JournalEntry[] }>) {
  return (
    <>
      <Summary
        entries={entries}
        total={query.data?.pages[0]?.total ?? null}
        asOf={query.dataUpdatedAt}
      />
      <ol className="journal-list" aria-label="Signals, newest first">
        {entries.map((entry) => (
          <EntryItem key={entry.signal.id} entry={entry} />
        ))}
      </ol>
      {query.isError && (
        <p className="journal-error" role="alert">
          {query.isFetchNextPageError
            ? "Couldn't load older signals"
            : "Couldn't refresh, so this is the list as of the time above"}
          : {errorMessage(query.error)}
        </p>
      )}
      {query.hasNextPage && (
        <button
          type="button"
          className="portfolio-cash-btn journal-more"
          aria-disabled={query.isFetchingNextPage || undefined}
          onClick={() => {
            if (!query.isFetchingNextPage) void query.fetchNextPage();
          }}
        >
          {query.isFetchingNextPage ? 'Loading…' : 'Load older signals'}
        </button>
      )}
    </>
  );
}

function JournalBody({ query, filtered }: Readonly<{ query: JournalQuery; filtered: boolean }>) {
  const entries = (query.data?.pages ?? []).flatMap((page) => page.rows.map(journalEntry));
  if (query.isPending) return <output className="journal-status">Loading signal journal…</output>;
  if (query.isError && entries.length === 0) {
    return (
      <div className="journal-error" role="alert">
        <p>
          Couldn&apos;t load the signal journal: {errorMessage(query.error)}. Nothing is shown, so
          no outcome is guessed.
        </p>
        <button type="button" className="portfolio-cash-btn" onClick={() => void query.refetch()}>
          Retry
        </button>
      </div>
    );
  }
  if (entries.length > 0) return <JournalList query={query} entries={entries} />;
  return (
    <div className="holdings-empty">
      <NotebookText size={26} aria-hidden="true" />
      <span className="holdings-empty-title">
        {filtered ? 'No signals match these filters' : 'No signals recorded yet'}
      </span>
      <span className="holdings-empty-sub">
        {filtered
          ? 'Clear the asset or status filter to see the rest.'
          : 'TradingView alerts appear here once tv-webhook records them.'}
      </span>
    </div>
  );
}

/**
 * Signal Journal: every TradingView signal with what was recorded about it and
 * the paper fill linked to it. Read-only: there is no action here, and trades
 * still go through the Action Center's review.
 */
export function DecisionJournal() {
  const { scopeUserId: userId } = usePortfolio();
  const [status, setStatus] = useState<RecordedStatus | null>(null);
  const [assetText, setAssetText] = useState('');
  const [ticker, setTicker] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setTicker(tickerQuery(assetText)), 300);
    return () => clearTimeout(timer);
  }, [assetText]);

  const query = useJournal(userId, ticker, status);

  if (userId === null || isDevAuthUser(userId)) {
    return (
      <section className="journal" aria-label="Signal journal">
        <div className="holdings-empty">
          <NotebookText size={26} aria-hidden="true" />
          <span className="holdings-empty-title">Sign in to see your signal journal</span>
          <span className="holdings-empty-sub">
            The journal reads your account&apos;s recorded signals and fills.
            {userId !== null && ' The ?devAuth preview has no session to read them with.'}
          </span>
        </div>
      </section>
    );
  }

  return (
    <section className="journal" aria-label="Signal journal">
      <div className="journal-head">
        <p className="journal-sub">
          What was recorded for each TradingView signal and the paper fill linked to it. Read-only:
          execute or dismiss signals in the Action Center.
        </p>
        <div className="journal-filters">
          <input
            className="portfolio-cash-input"
            type="search"
            aria-label="Filter by asset"
            placeholder="Asset"
            value={assetText}
            onChange={(event) => setAssetText(event.target.value)}
          />
          <select
            className="portfolio-cash-input"
            aria-label="Filter by recorded status"
            value={status ?? ''}
            onChange={(event) => setStatus((event.target.value || null) as RecordedStatus | null)}
          >
            <option value="">All statuses</option>
            <option value="PENDING">Pending</option>
            <option value="EXECUTED">Executed</option>
            <option value="DISMISSED">Dismissed</option>
          </select>
          <button
            type="button"
            className="portfolio-cash-btn"
            aria-disabled={query.isFetching || undefined}
            onClick={() => {
              if (!query.isFetching) void query.refetch();
            }}
          >
            <RefreshCw size={13} className={cn(query.isFetching && 'journal-spin')} /> Refresh
          </button>
        </div>
      </div>
      <JournalBody query={query} filtered={ticker !== '' || status !== null} />
      <p className="journal-footnote">
        Not recorded for any signal: the provider&apos;s event time, the risk checks that applied
        when it was decided, when or why it was dismissed, and whether a fill was recovered after a
        lost response.
      </p>
    </section>
  );
}
