# Equity and ETF daily data: provider decision and candle contract

Status on 2026-10-28: **blocked on a licensed provider.** The 90 configured US equities and ETFs
stay `UNSUPPORTED` in every live scan. The candle contract (`us-equity-daily-v1`) and a
provider-neutral pipeline are implemented and tested on labeled fixtures only. Fixture tests are
not market coverage.

Code: `src/lib/usEquityDaily.ts` (calendar, policy, provider seam), `src/lib/marketScanner.ts`
(equity cohort), `src/test/usEquityDaily.test.ts`, `src/test/marketScanner.test.ts`,
`scripts/marketScanStore.test.ts`.

## 1. What the repository already has

| Source                                                           | Where                                                                                        | Used for                                                                        | Can it feed the scanner?                                                                                                                                                                                                              |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Yahoo Finance `v7/finance/spark`                                 | `supabase/functions/equity-forex-price-feed`                                                 | Last price every 15 min                                                         | No. Keyless and unofficial. Yahoo's API terms say a developer shall not "derive income from the use or provision of the Yahoo APIs" without Yahoo's express written permission. ZeroChart has a Pro tier and holds no such permission |
| Yahoo Finance `v8/finance/chart` (1y, 1d)                        | `supabase/functions/market-analytics`                                                        | RSI, ATR, SMA and the archived Stable/Radar signals, stored as a separate field | No, for the same reason. It also uses dividend-adjusted closes and drops null bars, which this contract forbids                                                                                                                       |
| Binance spot klines                                              | `src/lib/binance.ts`                                                                         | Crypto candles                                                                  | Crypto only                                                                                                                                                                                                                           |
| TradingView (owner's local MCP tools, chart widget, Pine alerts) | Owner's machine; `tv-webhook`                                                                | Cross-checks and per-chart alerts                                               | No. Screener and technicals ratings are TradingView's own figures on the unclosed bar, not ZeroChart scores, and not a licensed data feed for the app                                                                                 |
| Credentials for any equity data vendor                           | Checked `.env`, `.env.local`, Vercel env names, every `Deno.env.get` in `supabase/functions` | —                                                                               | None exist. `supabase secrets list` for the production project timed out from this machine, so deployed secret names were not seen; no function reads a provider key either way                                                       |

## 2. Provider comparison

Primary sources, retrieved 2026-10-28. "Display" means showing the data, or scores derived from
it, to users of a commercial app. Coverage of all 90 tickers was **not verified** against any
provider: that needs an account and a key, and none was created or bought.

| Provider                                                                                | Coverage of the 90                                                                        | Permitted in a user-facing commercial scanner?                                                                                                                                                                                                                               | Timestamps and completed bars                                                                                                                                                                                                              | Adjustment                                                                                                  | Limits, cost, auth                                                                                               |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [Yahoo](https://legal.yahoo.com/us/en/yahoo/terms/product-atos/apiforydn/index.html)    | Yes in practice (the feed already quotes them)                                            | **No**: income from the APIs needs Yahoo's prior written permission                                                                                                                                                                                                          | Undocumented                                                                                                                                                                                                                               | Undocumented; `adjclose` includes dividends                                                                 | No published limits                                                                                              |
| [Alpaca Market Data](https://docs.alpaca.markets/docs/about-market-data-api)            | US stocks and ETFs; free Basic is IEX-only for recent data, SIP history older than 15 min | **No**: Alpaca support: "you cannot redistribute Alpaca API data" ([2022](https://alpaca.markets/support/redistribute-alpaca-api)). Broker API partners get custom licensing via sales                                                                                       | Bars stamped in RFC 3339 ([reference](https://docs.alpaca.markets/reference/stockbars))                                                                                                                                                    | `adjustment`: `raw` (default), `split`, `dividend`, `spin-off`, `all`                                       | Basic free, 200 calls/min; Algo Trader Plus $99/mo, 10,000/min. Key + secret headers. Needs an Alpaca account    |
| [Massive (was Polygon.io)](https://massive.com/docs/rest/stocks/aggregates/custom-bars) | "All US stock tickers"                                                                    | **Not on individual plans**: those cover "personal, individual, and non-business use" ([terms](https://massive.com/terms)). [Stocks Business](https://massive.com/business) is $2,499/mo ("No Exchange Fees or Approvals"); its display terms were not published on the page | `t` = start of the window in ms; daily bars start at midnight ET. Free tier serves a day only "after midnight ET" ([KB](https://massive.com/knowledge-base/article/on-the-free-basic-plan-when-can-i-pull-the-previous-trading-days-data)) | `adjusted=true` (default) adjusts "for splits" only                                                         | Basic free: 5 calls/min, 2 years; individual $29–$199/mo. API key                                                |
| [Tiingo EOD](https://www.tiingo.com/documentation/end-of-day)                           | US equities (ETF coverage not stated on the EOD page; metadata endpoint per ticker)       | **Not on Starter/Power**: "Internal Use Only", "you may not display or share the data with another person or organization" ([pricing](https://www.tiingo.com/about/pricing)). Redistribution via sales                                                                       | Date only, no zone stated. Prices around 17:30 ET, corrections until 20:00 ET                                                                                                                                                              | Raw OHLC plus `adjOpen/High/Low/Close` (splits **and** dividends, CRSP method) and `splitFactor`, `divCash` | Starter free: 50 req/h, 1,000/day, 500 symbols/month. Power $30/mo individual, $50/mo internal commercial. Token |
| [Twelve Data](https://twelvedata.com/terms)                                             | Not checked                                                                               | **No** on free and standard tiers: free-tier data may not be used commercially; external display needs a "Redistribution Rights Add-On"                                                                                                                                      | Not checked                                                                                                                                                                                                                                | Not checked                                                                                                 | Not checked                                                                                                      |
| [EODHD](https://eodhd.com/financial-apis/terms-conditions)                              | Not checked                                                                               | **No** on personal plans ("displaying, or granting access to the Information" is prohibited); commercial/B2B plans via sales                                                                                                                                                 | Not checked                                                                                                                                                                                                                                | Not checked                                                                                                 | Not checked                                                                                                      |
| [Alpha Vantage](https://www.alphavantage.co/premium/)                                   | Not checked                                                                               | **Unknown**: the terms are a PDF that could not be read here; the premium page has no display terms                                                                                                                                                                          | Not checked                                                                                                                                                                                                                                | Not checked                                                                                                 | Free 25 requests/day; premium $49.99–$249.99/mo                                                                  |

### Decision

No provider is already authorized, and no self-serve tier found permits showing equity data or
scores derived from it to users of a commercial app. Nothing was bought and no licence is claimed.

Live equity coverage stays `UNSUPPORTED`. What shipped instead:

- the `us-equity-daily-v1` contract (section 3);
- the provider seam `EquityDailyProvider`: one adapter maps a vendor's response into
  `{ adjustment, bars: [{ session, open, high, low, close, volume }], splits }`;
- the equity cohort in the scanner: explicit instrument map, bounded requests, rate-limit stop,
  cache, structured outcomes, evidence and offline reproduction, tested on fixtures.

### Integration prerequisite

To turn equities on, the owner has to:

1. **Get a written licence** that covers displaying daily OHLC, or scores derived from it, to
   users of a commercial app. Candidates in order of fit: Massive Stocks Business (split-only
   adjustment is native, US-wide coverage) or a Tiingo redistribution licence (split factors are
   provided). Ask either vendor in writing whether derived scores count as display.
2. **Confirm coverage** of all 90 tickers with the vendor's ticker list, including `XYZ` (Block),
   the ETFs, and any symbol with a class suffix.
3. **Write one adapter** (about 40 lines) implementing `EquityDailyProvider`: request
   `range.from`–`range.to`, return split-adjusted OHLC keyed by New York session date, and the
   vendor's split events. Throw `ProviderRateLimitError` on 429.
4. **Run it server-side only.** The key goes in a Supabase secret or the CLI's process
   environment, never a `VITE_` variable. The Markets page would read stored scan results, not
   the vendor's raw bars. That needs a scheduled function and a results table with RLS. Neither
   is in this PR: without a vendor, its shape would be guesswork.
5. **Re-check limits.** The scan sends at most one request per equity per new session, and none
   for a cached range. At Massive Basic's 5 calls/min, 90 tickers would take 18 minutes, so a
   paid tier is needed.

## 3. The `us-equity-daily-v1` candle contract

Crypto's `binance-daily-v1` assumes 24h UTC days that close at 23:59:59.999 every day. An equity
bar is a trading session, so that policy is not reused.

| Topic                     | Rule                                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instruments and exchanges | The 90 tickers in `US_EQUITY_INSTRUMENTS` (71 stocks, 19 ETFs), US-listed on NYSE, Nasdaq, NYSE Arca or Cboe and traded on the consolidated tape. Instrument `US:<ticker>`. A ticker not in the map is `UNSUPPORTED`, never inferred                                                                                                               |
| Session                   | Regular session only, 09:30–16:00 America/New_York. Early closes at 13:00. No pre- or post-market bars                                                                                                                                                                                                                                             |
| Calendar                  | NYSE's published holidays and early closes for 2026–2028 ([nyse.com](https://www.nyse.com/markets/hours-calendars), retrieved 2026-10-28). A scan or bar outside them is `CALENDAR_OUT_OF_RANGE`, never guessed. Extend the table when NYSE publishes 2029                                                                                         |
| Bar identity              | One bar per session, keyed by its New York date `YYYY-MM-DD`. The engine candle's `timestamp` is the session open and `closeTime` the session close, both in UTC ms                                                                                                                                                                                |
| Time zone and DST         | Open and close come from the runtime's America/New_York time-zone data, so EST/EDT shifts (8 Mar and 1 Nov 2026) move the UTC times, not the session                                                                                                                                                                                               |
| Completed bar             | A bar counts once its session is **final**: 9h after the scheduled close (01:00 ET, or 22:00 ET after an early close). That clears the closing auction, late reports, Tiingo's 20:00 ET corrections and Massive's free-tier midnight release. Bars for later sessions (today's open session, or one closed under 9h ago) are excluded and counted  |
| Weekends and holidays     | Never sessions. A provider bar dated on one is `NON_SESSION_BAR`                                                                                                                                                                                                                                                                                   |
| Duplicates and gaps       | A repeated session is `DUPLICATE_SESSION`; a calendar session absent between two bars is `MISSING_SESSION`. Neither is deduplicated, forward-filled or interpolated. A full-day trading halt therefore makes the asset `DATA_INVALID`                                                                                                              |
| OHLC validity             | Finite, positive, `high ≥ low`, open and close within `[low, high]` (shared with `binance-daily-v1`). Volume is not used by the model and not validated                                                                                                                                                                                            |
| Adjustment                | **Split-adjusted OHLC only** (`SPLIT`): all four prices divided by the same cumulative split factor, no dividend adjustment. Any other declared basis is `ADJUSTMENT_BASIS_MISMATCH`. An adjusted close mixed with raw high/low fails `CLOSE_OUTSIDE_RANGE`. A provider-reported split whose price step is still in the bars is `UNADJUSTED_SPLIT` |
| Freshness                 | Counted in sessions. The latest bar must be the latest final session or the one before it, the same one-candle slack crypto's 48h bound allows. Older is `STALE_DATA`. A weekend or holiday never makes data stale                                                                                                                                 |
| History window            | The last 199 final sessions. Fewer is `INSUFFICIENT_HISTORY`. The provider is asked for 200 sessions, so one session of lag still leaves a full window                                                                                                                                                                                             |
| Caching                   | One entry per provider, symbol and session range. A new final session changes the range, so a cached series is never extended with new bars: an adjusted history is always fetched whole, and a split between fetches cannot mix two adjustment bases. Each result carries `fetchedAt` and `cached`, and the panel shows the age                   |

Why split-only: an unadjusted split is a fake 50–90% crash in RSI, MACD and ATR, so split
adjustment is required. Dividend adjustment changes every past bar a little on each ex-date. It
is a modelling choice, and Massive's aggregates cannot supply it. With split-only, the last bar's
prices are the traded prices. The archived `market-analytics` function uses Yahoo's
dividend-adjusted close; its figures are a separate field and not comparable.

The model is scale-invariant on a consistently adjusted series (RSI, MACD ÷ close, ATR ÷ close),
so a split-adjusted history scores the same at any share basis. A test checks it.

### The 199 versus 200 window

App scores rest on **199 closed candles**: the 200-candle Binance request includes today's open
candle, which is dropped. Pine `1.0.0-pw200` sees **200** bars at a bar close. The windows differ
by one bar, and parity is bounded, not exact (`docs/PINE_PARITY_ASSESSMENT.md`). Equities keep the
app's 199 so both cohorts rest on the same window length. This PR does not change either side,
and claims no Pine parity for equities: no Pine run on an equity chart has been compared.

## 4. Ranking and labels

- Equities and ETFs rank only among themselves; crypto ranks only among crypto. Ranks restart at
  1 in each class, the Markets "Signals" sort lists each class's ranking in turn, and the CLI
  summary tags every rank with its class. The same formula does not establish comparable risk or
  predictive value across classes.
- Model weights and thresholds are unchanged. Long setup stays score ≥ 78 with momentum ≥ +0.05%;
  risk setup stays score ≤ 28 or a high-volatility regime.
- The equity section says the model's predictive performance on equities is unvalidated, and
  that a setup is not evidence of an undervalued company.

## 5. Coverage, before and after

Live scans of the 100-asset `assets_status` universe, read-only (public `assets_status` read,
public Binance klines):

| Asset class     | Before (#105–#107)                       | After (this PR)                                                       |
| --------------- | ---------------------------------------- | --------------------------------------------------------------------- |
| Crypto          | 5 of 5 evaluated                         | 5 of 5 evaluated, ranked within crypto                                |
| Equities & ETFs | 90 `UNSUPPORTED` ("no validated source") | 90 `UNSUPPORTED` ("no licensed provider configured; policy in place") |
| Forex           | 5 `UNSUPPORTED`                          | 5 `UNSUPPORTED`                                                       |

Actual coverage did not change: 5 of 100 assets are scored. What changed is that equities can be
switched on by adding one licensed adapter, with the contract, outcomes, ranking separation and
evidence already tested.
