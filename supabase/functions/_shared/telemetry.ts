// Run telemetry shared by the three feed functions: no Deno or Supabase
// imports, so vitest covers it from src/test. A run that misses some tickers
// still answers 200 and those tickers keep their old data, so each run logs
// what it skipped and returns a summary a monitor can alert on.

/** One JSON line per event, so the Edge Function log explorer can filter on any field. */
export function log(
  level: 'info' | 'warn',
  fn: string,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  console[level](JSON.stringify({ fn, event, ...fields }));
}

/**
 * GET a JSON body; null (and a logged reason) on a timeout, a network error or
 * a non-2xx answer such as Yahoo's 429 or Binance's 451. Yahoo answers 429 to
 * non-browser user agents.
 */
export async function fetchJson(fn: string, url: string, timeoutMs: number): Promise<unknown> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return await res.json();
    log('warn', fn, 'upstream_error', {
      url,
      status: res.status,
      body: (await res.text()).slice(0, 200),
    });
  } catch (error) {
    log('warn', fn, 'fetch_failed', { url, error: String(error) });
  }
  return null;
}

export interface FeedSummary {
  status: 200;
  expected: number;
  updated: number;
  skipped: number;
  /** Minutes since the stalest expected ticker's data; null when none has any. */
  oldest_data_age_mins: number | null;
}

/**
 * Logs each skipped ticker and the run summary, and returns the summary.
 * `stored` holds each ticker's data time before the run and `written` what
 * this run wrote; a ticker with no time at all (never written) counts as
 * skipped but cannot age the summary.
 */
export function report(
  fn: string,
  expected: readonly string[],
  stored: ReadonlyMap<string, string | null>,
  written: ReadonlyMap<string, string>,
  now = Date.now(),
): FeedSummary {
  const skipped = expected.filter((ticker) => !written.has(ticker));
  for (const ticker of skipped) {
    log('warn', fn, 'ticker_skipped', { ticker, data_at: stored.get(ticker) ?? null });
  }
  const times = expected
    .map((ticker) => Date.parse(written.get(ticker) ?? stored.get(ticker) ?? ''))
    .filter(Number.isFinite);
  const summary: FeedSummary = {
    status: 200,
    expected: expected.length,
    updated: expected.length - skipped.length,
    skipped: skipped.length,
    oldest_data_age_mins: times.length > 0 ? Math.round((now - Math.min(...times)) / 60_000) : null,
  };
  log(skipped.length > 0 ? 'warn' : 'info', fn, 'run_summary', { ...summary });
  return summary;
}
