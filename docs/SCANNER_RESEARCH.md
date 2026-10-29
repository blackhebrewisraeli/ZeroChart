# Retrospective scanner study

Does the market scanner's ranking, or its setup conditions, say anything about what prices did
next? This study replays the existing scanner (`market-scan-v2`, model `1.0.0`,
`us-equity-daily-v1`) over the history in the private TradingView export of the 50-instrument
development scan and compares its signals with same-date baselines.

It is **retrospective historical research**. The scanner did not record these readings at the
time, so nothing here is prospective evidence, a backtest, a fill or a trading result. It changes no
model, weight, threshold, ranking, alert or campaign.

Code: `scripts/scannerResearch.ts` (specification, replay, outcomes, comparisons),
`scripts/scannerResearchReport.ts` (private HTML), tests in `scripts/scannerResearch.test.ts`.

## Frozen specification

[`scanner-research.v1.json`](scanner-research.v1.json) is the machine-readable study:
universe and selection rule, calendar and evaluation dates, decision time, scanner versions and
history window, long-setup and risk-warning definitions, rank groups, 1/5/20-session horizons,
reference, endpoint and benchmark conventions, comparisons, statistics, missing-data rules and the
study identifier. Its ID is the SHA-256 of its canonical content,
`ab0d42aa14413cd2f05a2b29a516c85502aa0ff410652375a8390eb0860bebdf`, and a test keeps the JSON and
the code identical.

It was committed (8a93089, 2026-10-29 13:25:05Z, pushed at once) after inspecting only the export's
bar dates, bar counts, timestamps and market-data notice, and before any score, rank or forward
price change was computed. The replay code was committed (6fe2e49) before it first ran on the export.
A change to any of it is a new study version, frozen before it is run, not an edit of this one.

## Method

- **Data.** The export `.zerochart-tradingview/20261029T103004Z.json` (git-ignored), identified in
  the specification by its SHA-256: 1,000 daily bars per symbol from TradingView's `get_ohlcv`,
  regular session, split-adjusted only. A bar is used only if its session was final (9h after the
  close) when retrieval started, through `tradingViewSeries`, the import's own mapping.
- **Calendar.** TradingView sends none and the published calendar in `usEquityDaily.ts` starts in
  2026, so the sessions are those present in any member's bars. Where the published calendar
  reaches, they must equal it exactly or the study refuses to run.
- **Evaluation dates.** Every observed session from the first on which every member's data allows a
  full window: 802 dates, 2023-08-18 to 2026-10-28, the same for every member.
- **Replay.** On each date the scanner gets only bars of sessions on or before it, from the
  200-session range the scan requests, and scores the last 199 with `evaluateCandles`, checking
  them in `assessEquity`'s order: invalid or gapped window → `DATA_INVALID`, latest bar older than
  the session before → `STALE_DATA`, short → `INSUFFICIENT_HISTORY`. Ranking, `modelSetups` and
  failures are kept per member and date. Nothing is filled or repaired.
- **Parity.** On every date whose request range the published calendar covers, the actual scanner
  (`importInputs` + `evaluateScan`) runs on the same export and must agree on status, window end,
  rank, score, regime and setups, or the study refuses to run.
- **Outcomes.** OPEN of the first session after the date (which opens after the decision time) to
  OPEN 1, 5 and 20 sessions later. The date's close is never an entry. A horizon whose endpoint is
  not final yet is `PENDING`; a missing or invalid bar is `MISSING` or `INVALID`; both are excluded.
- **Comparisons.** Long setups, risk warnings, top 5, top 10 and rank quintiles against the
  same-date mean of every scored member, and against SPY over the same sessions. Stocks and ETFs are
  also compared with the same-date universe of their own type; breakdowns by calendar year and by
  asset show concentration. Every horizon and group is reported, weak or negative.
- **Observations versus transitions.** A standing setup counts once per date it holds. A
  transition is a date on which it holds and the member was evaluated without it the date before;
  if the member was not evaluated the date before, the onset is unknown and it is not a transition.

## Reproduction

```bash
npm run evaluate -- scanner-research .zerochart-tradingview/20261029T103004Z.json
```

The command refuses any other export, and any run whose calendar, evaluation dates, retrieval or
scanner parity differ from the frozen study. It writes, git-ignored:

- `.zerochart-reports/scanner-research-ab0d42aa1441.json`: every replayed date and member and every
  aggregate. Written once; a rerun prints `UNCHANGED` only if it is byte-identical, otherwise
  `CONFLICT` and a non-zero exit.
- `.zerochart-reports/scanner-research-ab0d42aa1441.html`: the private report, coverage and method
  first, then every horizon, stocks versus ETFs, years, per-asset concentration and limitations.

It prints aggregates only (no ticker, price or per-asset figure). Market data and per-asset results
stay in the git-ignored files; this repository is public.

TradingView's terms as this repository reads them
([TRADINGVIEW_ONLY_FEASIBILITY.md](TRADINGVIEW_ONLY_FEASIBILITY.md#4-terms-by-use)) allow this as
the owner's personal research. Using its results in the product would need TradingView's written
confirmation first.

## Limitations

- No historical provider snapshots: every past bar is today's version of it, after any later
  corrections. What a provider would have served on each date is unknown, so this is not fully
  point-in-time.
- Split-adjusted history. The model's inputs (RSI, MACD histogram / close, ATR / close) and
  OPEN-to-OPEN ratios don't change under a uniform split factor, but adjusted prices are rounded
  after adjustment, and around a split a live provider could have served unadjusted bars that
  `us-equity-daily-v1` would reject.
- No dividend adjustment: changes are price only, the benchmark's too.
- The universe is today's configured list, selected in 2026. Delisted or later-listed instruments
  are absent, so survivorship and selection effects remain.
- Before 2026 the calendar is observed, not published; earlier early closes are unknown (they move
  the decision timestamp, never which bars are used).
- One provider, one retrieval, one roughly three-year period.
- Same-date comparisons remove the common market move, not differences in volatility or beta. The
  model rewards quiet regimes and flags high-volatility ones, so its groups differ in volatility by
  construction.
- Consecutive dates share most of each horizon, standing setups repeat, and same-date members share
  moves: counts are not independent trials, and no significance test, p-value or confidence interval
  is reported. No portfolio return, trade win rate or drawdown is computed, and a decline after a
  risk warning is not treated as profit.

## What it cannot establish

Whether trading on the scanner would have been profitable after costs; whether a difference is more
than chance; whether it would recur on future data, other instruments or other periods; or whether
point-in-time data would have given the same scores.

## v2: a volatility-matched baseline

v1 found that higher ranks were followed by smaller changes than the same-date universe, and risk
warnings by larger ones. The model rewards quiet regimes and flags high-volatility ones, so that may
be volatility rather than information. [`scanner-research.v2.json`](scanner-research.v2.json)
(ID `117f36fd7b240c6238c67dcc5179b470fc175345a461ab498dd6bf2226f2ba83`) fixes how to test that
before any volatility-stratified figure exists:

- Same export, universe, dates, scanner replay, horizons, prices and missing-data rules as v1,
  copied unchanged; it names v1's ID as its basis.
- Volatility is the model's own ATR(14) / close on the evaluation date. Each date, each
  population's evaluated members are split into terciles by it (ties by ticker).
- v1's groups (universe, long setups and transitions, risk warnings and transitions, top 5, top 10,
  rank quintiles) are compared with the same-date mean of their own volatility tercile; the three
  terciles themselves are compared with the same-date population mean; each group's spread across
  terciles is reported.
- Two populations: all 50 members, and the 38 stocks with terciles, ranks and baselines among
  stocks alone. ETFs alone are too few for terciles.

It was specified after v1's results were seen and uses the same data, so it can explain them, not
confirm them.

Code: `scripts/scannerResearchV2.ts`, on v1's replay unchanged (a v1 rerun still prints
`UNCHANGED`). Run it with:

```bash
npm run evaluate -- scanner-research-v2 .zerochart-tradingview/20261029T103004Z.json
```

It refuses what v1 refuses and writes, git-ignored, `.zerochart-reports/scanner-research-117f36fd7b24.json`
(written once, with each evaluated member's ATR/close per date) and `.html` (coverage and method,
then each population's tercile mix and every horizon, by year and by asset).
