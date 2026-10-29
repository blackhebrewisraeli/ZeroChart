# Market scanner

The scanner runs the canonical model (`src/lib/canonicalModel.ts`, model `1.0.0`) over every
asset in the Markets universe, ranks what it could score, flags the model's setup conditions, and
reports everything it could not score with the reason. It never places, sizes or proposes an order.

Code: `src/lib/marketScanner.ts` (pure engine), `src/lib/usEquityDaily.ts` (equity calendar,
candle policy and provider seam), `src/hooks/useMarketScan.ts` (Markets page),
`src/components/MarketScanSummary.tsx`, `src/components/ScanReview.tsx` and `src/lib/scanReview.ts`
(reviewing a scan), `scripts/marketScanStore.ts` (CLI evidence).

Equities and ETFs: see [EQUITY_DATA.md](EQUITY_DATA.md) for the provider decision, the
`us-equity-daily-v1` contract and what it takes to switch them on.

## Coverage: displayed versus evaluated

The universe is the `assets_status` table: 100 rows on 2026-10-28. Before this change the Markets
page displayed all 100 but the canonical model only ran on the 5 crypto rows. The 95 others showed
"No data", which read like a short history rather than "never evaluated".

| Asset class                | Configured | Price source (cadence)                                                      | Daily candles                                                                                                         | Canonical model runs?        | Freshness                                                                                                                         | Unsupported / failure behavior                                                                                                                                                          |
| -------------------------- | ---------: | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Crypto (`BTC-USD` …)       |          5 | `crypto-price-feed`: Binance 24h ticker, every 15 min; live WebSocket ticks | Binance spot klines, 1d, last 200 (browser and CLI); `binance-daily-v1` validation                                    | **Yes**: scored and ranked   | Closed candles only; latest close must be ≤ 48h old. Prices go Stale after 2h                                                     | Before: a fetch failure became `INSUFFICIENT_DATA`. Now: `FETCH_FAILED`, `RATE_LIMITED`, `DATA_INVALID`, `STALE_DATA` or `INSUFFICIENT_HISTORY`, and the scan reports itself incomplete |
| Equities and ETFs (`AAPL`) |         90 | `equity-forex-price-feed`: Yahoo spark, every 15 min                        | None licensed. The scanner accepts a server-side `EquityDailyProvider` under `us-equity-daily-v1`; none is configured | **No** (fixture-tested only) | Sessions, not hours: latest final session or the one before ([contract](EQUITY_DATA.md#3-the-us-equity-daily-v1-candle-contract)) | `UNSUPPORTED`, "Not scanned", with the reason: no licensed provider is configured                                                                                                       |
| Forex (`EURUSD=X`)         |          5 | Same Yahoo feed                                                             | Same as equities; no volume                                                                                           | **No**                       | As equities                                                                                                                       | As equities                                                                                                                                                                             |

`market-analytics` is not the canonical model. It writes RSI(14), ATR(14), SMA 50/200, a volume
spike and the archived scanner's Stable/Radar signals. It has no MACD, no factor scores and no
regime, and it scores open-market bars by a different rule. Its output stays a separate, displayed
field.

## Cohorts and inclusion rules

Each asset class is a separate cohort with its own provider, candle policy, coverage and ranking
(`scan.cohorts`). Live today: **crypto spot on Binance, 1D, UTC days**, all 5 crypto rows. US
equities and ETFs (1D, New York sessions) run only through an injected licensed provider, and none
is configured, so they are `UNSUPPORTED` like forex. Scanner version `market-scan-v2`.

A crypto asset is ranked only if all of these hold on the scan (the equity rules are in
[EQUITY_DATA.md](EQUITY_DATA.md#3-the-us-equity-daily-v1-candle-contract)):

1. **Instrument identity.** The ticker classifies as crypto (`classifyTicker`) and maps to a Binance
   USDT spot pair. Each result names it, e.g. `BTC-USD → BINANCE:BTCUSDT`. The quote is USDT, not
   USD.
2. **Closed candles only.** The scan's evaluation time is taken before the first request. A candle
   counts only if its close (open + 86,399,999 ms) is at or before that time, so a candle that
   closes mid-scan stays open.
3. **Valid candles.** The `binance-daily-v1` policy passes (`src/lib/candleValidation.ts`): no
   repair, deduplication or fill.
4. **Fresh data.** The latest closed candle closed at most 48h before the scan, the bound
   `scoreTicker` and the evaluation lab already use. A halted or delisted market fails here or at
   fetch time.
5. **Full window.** At least 199 closed candles: the 200-candle request every score in the app
   makes, minus today's open candle. A younger listing is reported, not ranked, so every ranked
   score is smoothed over the same history.

There is **no liquidity filter**. Klines carry volume, but no repository policy defines a minimum,
so none is invented.

Scores from different asset classes or timeframes are never ranked together: ranks restart at 1
in each cohort, and the Markets "Signals" sort lists each class's ranking in turn.

## Ranking, setups and eligibility are separate

- **Rank**: within the asset class, score descending, then ticker in code-unit order. The same
  inputs always give the same order.
- **Setup conditions** (`modelSetups` in `canonicalModel.ts`) are the Pine HUD's own, on the last
  closed bar:
  - _Long setup_ (`ZC LONG`): score ≥ 78 and MACD momentum ≥ +0.05% of price.
  - _Risk setup_ (`ZC RISK`): score ≤ 28, or a high-volatility regime.

  Both can hold at once. Pine alerts only on the bar a condition turns true, so a scan reports a
  standing condition, not a fresh signal.

- **Risk-profile fit**: `qualifiesForRiskProfile` for conservative, moderate and aggressive.

A high score is not a buy signal, and none of these is a valuation claim. No threshold was changed.

## Roles

| Role                    | Who                                                                                                                                                    | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Market-data provider    | Binance public REST (`/api/v3/klines`)                                                                                                                 | Supplies raw daily candles. Keyless, documented weights (a 200-candle request weighs 2), CORS-enabled, already the app's candle source                                                                                                                                                                                                                                                                                                                |
| Scoring/scanning engine | ZeroChart: `marketScanner.ts` over `canonicalModel.ts`                                                                                                 | Validates, scores, ranks, flags setups, reports coverage                                                                                                                                                                                                                                                                                                                                                                                              |
| TradingView             | Chart widget; Pine HUD with per-chart alerts → `tv-webhook` → `trading_signals`; TradingView's hosted MCP server, used from the owner's agent sessions | One alert watches one symbol on one timeframe (today: `BINANCE:BTCUSDT` 1D). It does not scan a market. The screener and technicals tools return RSI, MACD and ATR% for the **unclosed** bar, smoothed over full history, plus TradingView's own "Recommend" rating. They are useful for cross-checks, but they are not the canonical model and not a licensed product data feed ([TRADINGVIEW_ONLY_FEASIBILITY.md](TRADINGVIEW_ONLY_FEASIBILITY.md)) |
| Decision                | The user                                                                                                                                               | Reads the ranking and reasons and decides. The scan offers no action                                                                                                                                                                                                                                                                                                                                                                                  |

Scan snapshots, scheduled-score campaigns (`.zerochart-campaigns/`) and received TradingView alerts
(`trading_signals`) are three separate evidence types. The scanner writes to none of the other two.

## Running a scan

The Markets page scans on load, every 15 minutes, and when the page regains focus after 5 minutes.
The engine runs in the finance Web Worker, with at most 4 requests in flight per provider. After a
429 or 418, nothing else is requested from that provider that scan; its remaining assets are
recorded as `RATE_LIMITED`. Other providers carry on. The browser never has an equity provider:
its credential could only live server-side.

From the command line (read-only: a public `assets_status` read and public Binance klines):

```bash
npx tsx --env-file=.env scripts/evaluate-canonical.ts scan
npm run evaluate -- scan-reproduce <SCAN_ID>
```

`scan` writes `.zerochart-scans/<SCAN_ID>.json` (git-ignored, never overwritten) and prints the
ranking, setups and every unevaluated asset. It exits non-zero unless the scan is `COMPLETE`.

A snapshot holds:

- the universe members and their hash;
- each cohort's provider, candle policy, calendar, freshness rule and coverage;
- every asset's raw candles (or equity series with its session range, fetch time and cache flag)
  or recorded failure, each with its own hash;
- the scan time;
- the scanner, model and candle-policy versions;
- the repository commit (suffixed `-dirty` for uncommitted code).

`scan-reproduce` re-derives the scan offline from those inputs, without any provider, and
compares every output: `MATCH`, or `MISMATCH` with `UNIVERSE_HASH_MISMATCH`,
`INPUT_HASH_MISMATCH`, `OUTPUT_MISMATCH` or `UNSUPPORTED_VERSION`. Snapshots written by
`market-scan-v1` report `UNSUPPORTED_VERSION`.

Scan status is `COMPLETE` only when every supported asset was scored, `PARTIAL` when some were, and
`FAILED` when none were. Each cohort has its own status too. "No qualifying setups" is stated as a
full answer only for a complete cohort.

## Reviewing a scan

Each scan panel (the live Markets scan and the TradingView development scan) shows its results in
three views: **Long setups** (ZC LONG holds), **Risk warnings** (ZC RISK holds) and **All ranked**
(every evaluated asset by rank; most meet no setup). A search box (ticker, instrument or requested
symbol) and filters on recorded fields narrow them: regime, the model's own momentum bias (±0.05% of
price is flat) and risk-profile fit. "No setups" is a full answer only for a complete cohort; an
empty filter result says how many it hid. Next to the results each cohort shows its coverage, data
as of, and whether the data still passes the scan's own freshness rule now: crypto's latest close
within 48h, equities' latest final session or the one before. Past that the data is marked **Stale**.
A scan is never called live.

**Explain** opens one asset's explanation, derived only from its recorded values
(`explainResult`): each ZC LONG and ZC RISK clause with the recorded value against the threshold,
RSI(14), MACD histogram / price, ATR(14) / price, the factor scores and weights, and the regime with
the first-match rule that chose it. Supports and weakens weigh each factor against the setup in
focus: its weight × its component's distance from the threshold (78 for ZC LONG, 28 for ZC RISK).
The three sum to the unrounded score's margin. A risk warning held by the high-volatility regime
alone lists the regime, not factor points. Source, timeframe, model, scanner and candle-policy
versions, last evaluated session, window and fetch time follow, then the limitations that apply:
historical import, split-only adjustment, equities unvalidated, the 199/200-bar window, no
liquidity filter, an incomplete scan, stale data, and what is known about a TradingView alert. A
field the scan did not record reads "Not recorded". Nothing is generated, and no confidence is
invented.

**Compare** puts up to three assets of one cohort side by side: rank, score, regime, each setup
condition, the three readings with their factor scores and weights, risk-profile fit, last evaluated
session, window and fetch time. Assets from different asset classes cannot be selected together.

Neither view offers an order, a size or a broker link.

## Evaluating the scanner

One scan proves nothing about quality. A future evaluation has to cover every scanned asset, not
only the ones that met a setup: what each scored, and what happened to it afterwards. It also has
to count incomplete scans. The snapshots keep that whole population.

## Remaining gaps

- **Equities and ETFs (90 of 100)** need a provider licensed for display in this app, one adapter
  and a server-side scheduled scan ([EQUITY_DATA.md](EQUITY_DATA.md#integration-prerequisite)).
  The session policy, separate ranking and evidence are done. Whether the model's volatility bands
  (0.5%–5.5% daily ATR) suit single stocks and ETFs is unvalidated; that is why they rank apart.
- **Forex (5 of 100)** needs a licensed source and a 24/5 session policy of its own.
- Snapshots are local files. A server-side scheduled scan with stored history would need a table
  and a migration.
- `useCanonicalScores` (Tactical Signals, the asset details modal, the Paper Desk) still turns
  "no candle source" into `INSUFFICIENT_DATA` ("Not enough data") for equities and forex.
- App scores use 199 closed candles. Pine `1.0.0-pw200` sees 200 at a bar close, so the windows
  differ by one candle (see `docs/PINE_PARITY_ASSESSMENT.md`).

## TradingView development scan (local, owner-initiated)

A one-off local demonstration: 50 US equities and ETFs scored by this scanner on daily bars that the
owner's agent session retrieved through TradingView's MCP server. The Markets section shows it as
**TradingView development scan**, under `vite dev` only. It does not change live coverage: every
live scan still reports equities as `UNSUPPORTED`.

| Step                    | Who                      | How                                                                                                                                                                                                       |
| ----------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Choose the universe     | Code, before any data    | `selectDevScanUniverse`: the 50 of the 90 configured equities with the lowest `sha256(ticker)`                                                                                                            |
| Resolve instruments     | Agent (`search_symbols`) | One listing per ticker on a US primary venue (NASDAQ, NYSE, AMEX = NYSE Arca, CBOE); committed as `TRADINGVIEW_SYMBOLS`. Off-exchange, CFD and foreign listings excluded                                  |
| Retrieve bars           | Agent (`get_ohlcv`)      | 1D, `count` 1000 per symbol, signed in as the owner (OAuth), well under ~100 calls/min. Each response is copied verbatim into one export file in git-ignored `.zerochart-tradingview/`                    |
| Check alerts            | Agent (`list_alerts`)    | Records which symbols hold any TradingView alert, so the panel can say whether Pine emitted anything                                                                                                      |
| Validate, score, record | App (CLI)                | `tradingview-import`: `us-equity-daily-v1`, canonical `1.0.0`, the last 199 final sessions; writes `.zerochart-scans/<SCAN_ID>.json` (reproducible with `scan-reproduce`) and `tradingview-dev-scan.json` |
| Display                 | App (dev server)         | `scripts/tradingViewDevRoute.ts`, a `vite dev`-only plugin, serves that file at `/__zerochart/tradingview-dev-scan` to this machine's loopback addresses; production builds have no such route            |
| Decide                  | The owner                | Nothing in the panel is an action                                                                                                                                                                         |

```bash
npm run evaluate -- tradingview-import .zerochart-tradingview/<RETRIEVAL_ID>.json
npm run evaluate -- scan-reproduce <SCAN_ID>
npm run dev   # then open http://localhost:8080/?devAuth=1, Research → Markets
```

The export file (`scripts/tradingViewImport.ts`, `TradingViewOhlcvExport`) holds `retrieval.startedAt`
and `completedAt`, the alert check, and one entry per ticker: `symbol`, `receivedAt` and the response,
or the error the agent got. A selected ticker missing from the file is reported as `FETCH_FAILED`;
one outside the selection makes the import fail.

Conventions observed on 2026-10-29 and enforced by the import:

- A daily bar's `t` is its session's 09:30 New York open in Unix seconds (13:30 UTC in EDT, 14:30 in
  EST). Any other stamp is `DATA_INVALID`, never re-dated.
- TradingView's notice says "regular session only; prices are split-adjusted only", which is
  `us-equity-daily-v1`'s `SPLIT` basis. Without that notice the asset is `DATA_INVALID`: the basis is
  not assumed. Dividends are not adjusted. `get_ohlcv` reports no split events, so the
  `UNADJUSTED_SPLIT` check cannot run.
- The notice also says the last bar may still be forming and that data may be delayed under the
  owner's plan. Only final sessions count (9h after the close), as for any equity provider.
- The evaluation time is the end of retrieval. A retrieval during which another session became final
  is refused, so every symbol rests on the same required session.

Terms. TradingView's MCP documentation (retrieved 2026-10-29) names no usage terms and says nothing
about storing or processing what it returns. The general Terms still restrict non-display and
commercial use ([TRADINGVIEW_ONLY_FEASIBILITY.md](TRADINGVIEW_ONLY_FEASIBILITY.md)). So this stays
owner-only and local: the export, snapshots and view file are git-ignored, never committed, never
sent to Supabase or a deployment, and nothing schedules a re-scan. A product scan still needs
TradingView's written agreement.
