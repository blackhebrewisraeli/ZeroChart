# TypeScript-versus-Pine parity assessment

Baseline: `main` at `a53b871`, canonical model `1.0.0`, production Pine
[`pine/zerochart_quant_hud.pine`](../pine/zerochart_quant_hud.pine) unchanged. This is a
numerical and decision-contract assessment. It says nothing about predictive value.

**Runtime update (2026-10-27).** The harness, an in-Pine self-check and the candidate then ran
on TradingView (section 4). Real Pine **refutes** the first-sample EMA part of hypothesis H1 and
**confirms** its flat-RSI part, and the candidate reproduced every app decision. The runtime
results below supersede the H1-based estimates where they differ. The Decimal matrix in section 2
is kept unchanged as the pre-runtime model.

**Promotion (1.0.0-pw200).** `pine/zerochart_quant_hud.pine` is now the candidate below, with
only its comments, title and `MODEL_VERSION` (`1.0.0-pw200`) changed, and migration
`20261027120000` lets `execute_tactical_signal` book it from daily alerts. In this document
"production Pine" still means the `1.0.0` script that shipped until then; the harness's `prod`
side models it.

## Runtime findings (TradingView, 2026-10-27)

1. **The candidate matches the app on every compared bar.** Inside Pine, its readiness, score,
   regime and momentum class equal the independent Decimal app reference on all 1,906 bars: 365
   BTCUSDT days and all five fixtures. Its RSI, MACD histogram and ATR equal production
   TypeScript at 24 of 26 key points bit for bit, and within `6.2e-15` relative at the other two.
   That is decision-level parity, not bit-for-bit parity.
2. **Production Pine follows ZeroChart's seeds, not a first-sample EMA.** `ta.macd` matched the
   app's SMA-seeded MACD through the transient, and production Pine became ready at bar 33, the
   app's first ready bar, not bar 14. Its indicators equal the `customInit` model within `5e-14`
   relative at every key point, except on flat prices.
3. **Flat prices change decisions.** `ta.rsi` returned 100 on a flat series, where the app
   returns 50. Production Pine scored 35 against the app's 62 on all 287 ready bars of the
   `flat` fixture, which flips conservative and moderate eligibility.
4. **The rolling window still changes a tie.** On the `threshold` fixture's bar 260, production
   Pine rounded to 60 and the app to 59, as the continuous-history model predicted. On 365
   BTCUSDT days, the rising, falling and irregular fixtures, production Pine and the app
   agreed on every bar.
5. **TradingView's bars were the snapshot's bars.** High, low and close for `BINANCE:BTCUSDT`
   `1D` from 2025-04-11 to 2026-10-26 (564 bars) equaled the Binance Spot snapshot exactly.

## Pre-runtime findings (Decimal models, H1)

1. **The production TypeScript model meets its own contract.** On all 1,906 evaluated bars
   (five synthetic cases and 365 real BTCUSDT days), production `evaluateCandles` reproduces the
   independent Decimal reference's score, regime and momentum class exactly, and RSI, MACD
   histogram and ATR within a relative error of `4.2e-14`.
2. **The active alert does not evaluate the app's model input.** Alert `5917202050` (active,
   BINANCE:BTCUSDT, resolution `60`, inputs `10,000, 2, 14, 2`) scores hourly bars; the app,
   the Quant Analyzer and the campaigns score daily candles. Its scores are not comparable to the
   app's. A difference between them is expected and is not evidence of a defect.
3. **On a long daily chart, the documented Pine semantics stay close but never exact.** Over the
   last 365 closed BTCUSDT days, the documented-Pine model differs from the app by at most
   `1.05e-4` weighted-score points, with no score, regime or decision difference. The residual
   remains because the app re-seeds every indicator on its latest 200 candles each day, while Pine
   runs one continuous recurrence from the chart's first bar.
4. **Short history and flat prices change decisions.** Under the documented conventions, Pine is
   ready from bar 14, while the app reports `INSUFFICIENT_DATA` until bar 33. Through bar 199,
   the first-sample EMA moves the weighted score by up to 13.9 points (24 of 167 irregular bars
   round differently). A flat series scores 62 in the app, which is eligible, and 35 under the
   documented RSI convention, which is not. Both results depend on hypothesis H1 below.
   **Runtime: the short-history part is refuted** (Pine is ready at bar 33 and has no
   first-sample transient); **the flat part is confirmed.**
5. **A Pine port of the seeds alone is insufficient.** It is exact while the chart and the app
   see the same finite window (bars 33-199). Once the window rolls, it drifts by up to `1.05e-4`
   points, and a constructed tie at bar 260 rounds to 60 in Pine but 59 in the app, which
   changes eligibility. 200 candles bound the drift. They do not guarantee convergence.
6. **The isolated correction candidate**
   [`pine/candidates/zerochart_quant_hud_w200.pine`](../pine/candidates/zerochart_quant_hud_w200.pine)
   recomputes the score on the app's window. **Runtime: it compiled, ran on the full BTCUSDT
   `1D` history and matched every app decision (runtime finding 1).**

## 1. Comparison contract

A Pine score and an app score are comparable only when every row of this table matches. A
difference outside this contract is not a defect.

| Dimension                 | App (`canonicalModel.ts`)                                                                                        | Production Pine HUD                                                                                                                                                                                                 | Comparison rule                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Exchange and instrument   | Binance Spot `GET /api/v3/klines`, symbol `BTCUSDT` (`toBinanceSymbol`)                                          | The chart symbol. `toTradingViewSymbol` maps crypto to `BINANCE:<base>USDT`                                                                                                                                         | `BINANCE:BTCUSDT` against Binance Spot `BTCUSDT`. Another venue, `BTCUSD` or a perpetual is a different instrument |
| Timeframe and boundaries  | `1d`, open at `00:00:00.000Z`, close `open + 86,399,999 ms` ([candle contract](CANDLE_INPUT_CONTRACT.md))        | The chart resolution. The active alert uses `60`                                                                                                                                                                    | `1D` only. Hourly bars have no app contract, and the daily validator is never applied to them                      |
| Closed bars               | Closed candles only. Open candles are excluded                                                                   | Historical bars are closed. The realtime bar recomputes on every tick. `alert()` uses `alert.freq_once_per_bar_close`. An `alertcondition` alert follows the trigger frequency chosen when the alert was created    | Confirmed bars only (`barstate.isconfirmed`, exported as `zc_confirmed`)                                           |
| History and anchor        | The latest `min(200, n)` closed candles, re-seeded on every evaluation. Fewer than 34 means `INSUFFICIENT_DATA`  | One recurrence from the chart's first loaded bar (the 2017 listing for daily BTCUSDT). The anchor depends on the history TradingView loads                                                                          | Identical only on the same finite window. Otherwise apply the bounded contract in section 2                        |
| Input validation          | `binance-daily-v1`: gaps, duplicates and inconsistent OHLC are `DATA_INVALID`                                    | None                                                                                                                                                                                                                | Compare only windows that pass `binance-daily-v1`                                                                  |
| RSI(14)                   | Wilder. The seed is the mean of the first 14 changes, first value at index 14. Flat (both averages 0) returns 50 | `ta.rsi(close, 14)`: Wilder through `ta.rma`, same seed. **Flat returns 100 (runtime, 2026-10-27)**                                                                                                                 | Identical except on flat windows, where Pine reads 100 and the app 50                                              |
| MACD(12, 26, 9)           | Independently SMA-seeded EMAs. Histogram from index 33 ([verification](QUANT_MODEL_VERIFICATION.md))             | `ta.macd`: **runtime matches the app's SMA-seeded composition, histogram from index 33** (H1's first-sample seed is refuted)                                                                                        | Identical through the transient; differs only once the app's window rolls                                          |
| ATR(14)                   | First TR `high - low`, SMA seed of TR 0-13 at index 13, then Wilder                                              | `ta.atr(atrPeriod)` = `ta.rma(ta.tr(true), atrPeriod)`, the same convention **when ATR Period is 14**                                                                                                               | ATR Period must be 14. In production it moves the score, the size and the stop. The active alert uses 14           |
| Factors, regime, rounding | Piecewise RSI curve, ±1% momentum saturation, 0.5%-5.5% volatility band, first-match regimes, `Math.round` once  | The same operations in the same order. `math.round` rounds ties up, which equals `Math.round` for nonnegative scores                                                                                                | Identical arithmetic. Last-bit differences in the Wilder/EMA recurrences can matter only at exact ties             |
| Readiness                 | `INSUFFICIENT_DATA` below 34 candles or on a non-finite reading                                                  | `ready` once RSI, the MACD histogram and ATR are non-na: **bar 33 at runtime**, the app's first ready bar. Before that, `ZC Score` plots a score renormalized over RSI and ATR, and every setup is gated on `ready` | Same first ready bar. Pine's partial pre-33 `ZC Score` has no app counterpart and drives no signal                 |
| Floating point            | IEEE-754 binary64                                                                                                | Runtime values agree with TypeScript within `6.2e-15` relative, but not always bit for bit, even with the same operation order                                                                                      | Tolerance `1e-12` relative for the reference check. Decisions compare exactly                                      |

### What is compared, and what is not

| Output                    | Where it exists | Comparable?                                                                                                                                                                                                                                   |
| ------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Score, components, regime | Both            | Yes, under the contract above                                                                                                                                                                                                                 |
| Signal transitions        | Pine only       | `longSignal`, `riskSignal`, `highConviction` and the regime-shift alert depend on the current and previous bar. They are comparable only when both bars' scores match                                                                         |
| ATR trailing stop         | Pine only       | No. It is path-dependent from the chart's first bar, uses `ATR(atrPeriod) × multiplier`, and the app places no stops. `stopBreached` SELL alerts do not depend on the score                                                                   |
| Portfolio eligibility     | App only        | Derived. Conservative: score ≥ 60 and not high volatility. Moderate: score ≥ 60. Aggressive: score ≥ 71 and momentum score > 50. The matrix applies these to both models' readings                                                            |
| Webhook execution         | Server          | `execute_tactical_signal` accepts `model_version = '1.0.0'` with non-null exchange, timeframe and bar time. It does **not** check that the timeframe is `1D`, so a 60-minute signal is executable today. This assessment does not change that |

## 2. Current discrepancy

### Reproduce

```bash
python3 scripts/generate-pine-parity-fixtures.py
git diff --exit-code -- docs/pine-parity-fixtures.json
npm run parity
```

The generator uses Python `Decimal` arithmetic and imports no TypeScript. It reuses the
recurrences from `generate-quant-reference-fixtures.py`, which PR #88 verified independently.
Every bar of every case is scored under three models:

| Model            | Definition                                                                                                                                                                               | Status                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `app`            | ZeroChart contract: the last `min(200, n)` candles, SMA seeds, RSI 50 when flat, a 34-candle minimum                                                                                     | Production TypeScript matches it on every bar (`npm run parity`)  |
| `pineDocumented` | **Hypothesis H1**: first-sample `ta.ema`, SMA-seeded `ta.rma`, `ta.tr(true)`, continuous history from bar 0, RSI 100 when the average loss is 0, ready when RSI, MACD and ATR are non-na | A model of the documentation. **Runtime refuted its EMA seed**    |
| `customInit`     | ZeroChart's seeds on continuous history from bar 0, without the rolling window                                                                                                           | **Runtime: production Pine follows it, except RSI 100 when flat** |

Cases:

| Case         | Bars | Construction                                                                                                                                | Purpose                                                  |
| ------------ | ---: | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `rising`     |  320 | `100 + 0.5i`, ±0.25                                                                                                                         | One-sided RSI 100                                        |
| `falling`    |  320 | `300 - 0.5i`, ±0.25                                                                                                                         | One-sided RSI 0                                          |
| `flat`       |  320 | 100, no range                                                                                                                               | Flat RSI convention, zero ATR                            |
| `irregular`  |  320 | Integer quarter-tick random walk (`s = (75s + 74) mod 65537`), sixfold steps on bars 150-199                                                | Trending, mean-reverting and high-volatility regimes     |
| `threshold`  |  261 | The same walk with no high-volatility segment. Bar 260's close is bisected to sit between the app's and continuous history's 59.5 crossings | Eligibility boundary (score 59 vs 60)                    |
| `btcusdt-1d` | 1100 | [Binance snapshot](pine-parity-btcusdt-1d.json), 2023-10-23 to 2026-10-26, closed candles only. The last 365 bars are evaluated             | Real input. The app path goes through `binance-daily-v1` |

All synthetic prices are exact binary fractions, and the harness regenerates them bar for bar.

Segments: **warm-up** (bars 0-32, where the app is never ready), **shared history** (bars
33-199, where the app's window and the chart's history are the same finite window), and **rolling
window** (bars ≥ 200). "Decisions" counts bars where any of the three eligibility profiles or
Pine's long, risk or high-conviction setups differ. "Transitions" counts bars where a
`longSignal` or `riskSignal` firing differs. A readiness mismatch counts as a changed decision,
because Pine publishes a score where the app has none.

### Matrix

Output of `npm run parity` (momentum is MACD histogram / close, volatility is ATR / close,
weighted is the unrounded 0-100 score):

| Case       | Comparison            | Segment (bars)            | Compared | Max abs Δ RSI / momentum / volatility | Max abs Δ component / weighted | Readiness | Regime | Score | Decisions | Transitions | Class            |
| ---------- | --------------------- | ------------------------- | -------: | ------------------------------------- | ------------------------------ | --------: | -----: | ----: | --------: | ----------: | ---------------- |
| rising     | pineDocumented-vs-app | warm-up (0-32)            |        0 | n/a                                   | n/a                            |        19 |      0 |     0 |         0 |           0 | DECISION_CHANGED |
| rising     | pineDocumented-vs-app | shared-history (33-199)   |      167 | 0 / 1.76e-3 / 0                       | 8.81e+0 / 2.64e+0              |         0 |      0 |    15 |         0 |           0 | DECISION_CHANGED |
| rising     | pineDocumented-vs-app | rolling-window (200-319)  |      120 | 0 / 3.04e-9 / 8.01e-11                | 1.52e-5 / 4.56e-6              |         0 |      0 |     0 |         0 |           0 | NUMERICAL_ONLY   |
| rising     | customInit-vs-app     | warm-up (0-32)            |        0 | n/a                                   | n/a                            |         0 |      0 |     0 |         0 |           0 | EXACT            |
| rising     | customInit-vs-app     | shared-history (33-199)   |      167 | 0 / 0 / 0                             | 0 / 0                          |         0 |      0 |     0 |         0 |           0 | EXACT            |
| rising     | customInit-vs-app     | rolling-window (200-319)  |      120 | 0 / 0 / 8.01e-11                      | 0 / 0                          |         0 |      0 |     0 |         0 |           0 | NUMERICAL_ONLY   |
| falling    | pineDocumented-vs-app | warm-up (0-32)            |        0 | n/a                                   | n/a                            |        19 |      0 |     0 |        19 |           0 | DECISION_CHANGED |
| falling    | pineDocumented-vs-app | shared-history (33-199)   |      167 | 0 / 7.24e-4 / 0                       | 3.62e+0 / 1.09e+0              |         0 |      0 |    12 |         0 |           0 | DECISION_CHANGED |
| falling    | pineDocumented-vs-app | rolling-window (200-319)  |      120 | 0 / 3.04e-9 / 1.31e-10                | 1.52e-5 / 4.56e-6              |         0 |      0 |     0 |         0 |           0 | NUMERICAL_ONLY   |
| falling    | customInit-vs-app     | warm-up (0-32)            |        0 | n/a                                   | n/a                            |         0 |      0 |     0 |         0 |           0 | EXACT            |
| falling    | customInit-vs-app     | shared-history (33-199)   |      167 | 0 / 0 / 0                             | 0 / 0                          |         0 |      0 |     0 |         0 |           0 | EXACT            |
| falling    | customInit-vs-app     | rolling-window (200-319)  |      120 | 0 / 0 / 1.31e-10                      | 2.62e-7 / 5.25e-8              |         0 |      0 |     0 |         0 |           0 | NUMERICAL_ONLY   |
| flat       | pineDocumented-vs-app | warm-up (0-32)            |        0 | n/a                                   | n/a                            |        19 |      0 |     0 |         0 |           0 | DECISION_CHANGED |
| flat       | pineDocumented-vs-app | shared-history (33-199)   |      167 | 5.00e+1 / 0 / 0                       | 5.50e+1 / 2.70e+1              |         0 |    167 |   167 |       167 |           0 | DECISION_CHANGED |
| flat       | pineDocumented-vs-app | rolling-window (200-319)  |      120 | 5.00e+1 / 0 / 0                       | 5.50e+1 / 2.70e+1              |         0 |    120 |   120 |       120 |           0 | DECISION_CHANGED |
| flat       | customInit-vs-app     | warm-up (0-32)            |        0 | n/a                                   | n/a                            |         0 |      0 |     0 |         0 |           0 | EXACT            |
| flat       | customInit-vs-app     | shared-history (33-199)   |      167 | 0 / 0 / 0                             | 0 / 0                          |         0 |      0 |     0 |         0 |           0 | EXACT            |
| flat       | customInit-vs-app     | rolling-window (200-319)  |      120 | 0 / 0 / 0                             | 0 / 0                          |         0 |      0 |     0 |         0 |           0 | EXACT            |
| irregular  | pineDocumented-vs-app | warm-up (0-32)            |        0 | n/a                                   | n/a                            |        19 |      0 |     0 |         3 |           0 | DECISION_CHANGED |
| irregular  | pineDocumented-vs-app | shared-history (33-199)   |      167 | 0 / 1.65e-3 / 0                       | 8.23e+0 / 1.39e+1              |         0 |      1 |    24 |         4 |           0 | DECISION_CHANGED |
| irregular  | pineDocumented-vs-app | rolling-window (200-319)  |      120 | 2.12e-5 / 1.74e-8 / 2.34e-9           | 8.71e-5 / 4.02e-5              |         0 |      0 |     0 |         0 |           0 | NUMERICAL_ONLY   |
| irregular  | customInit-vs-app     | warm-up (0-32)            |        0 | n/a                                   | n/a                            |         0 |      0 |     0 |         0 |           0 | EXACT            |
| irregular  | customInit-vs-app     | shared-history (33-199)   |      167 | 0 / 0 / 0                             | 0 / 0                          |         0 |      0 |     0 |         0 |           0 | EXACT            |
| irregular  | customInit-vs-app     | rolling-window (200-319)  |      120 | 2.12e-5 / 1.74e-8 / 2.34e-9           | 8.71e-5 / 4.02e-5              |         0 |      0 |     0 |         0 |           0 | NUMERICAL_ONLY   |
| threshold  | pineDocumented-vs-app | warm-up (0-32)            |        0 | n/a                                   | n/a                            |        19 |      0 |     0 |         3 |           0 | DECISION_CHANGED |
| threshold  | pineDocumented-vs-app | shared-history (33-199)   |      167 | 0 / 1.65e-3 / 0                       | 8.23e+0 / 1.39e+1              |         0 |      1 |    24 |         4 |           0 | DECISION_CHANGED |
| threshold  | pineDocumented-vs-app | rolling-window (200-260)  |       61 | 2.32e-5 / 9.13e-9 / 2.08e-9           | 4.63e-5 / 2.78e-5              |         0 |      0 |     1 |         1 |           0 | DECISION_CHANGED |
| threshold  | customInit-vs-app     | warm-up (0-32)            |        0 | n/a                                   | n/a                            |         0 |      0 |     0 |         0 |           0 | EXACT            |
| threshold  | customInit-vs-app     | shared-history (33-199)   |      167 | 0 / 0 / 0                             | 0 / 0                          |         0 |      0 |     0 |         0 |           0 | EXACT            |
| threshold  | customInit-vs-app     | rolling-window (200-260)  |       61 | 2.32e-5 / 9.92e-9 / 2.08e-9           | 4.96e-5 / 2.75e-5              |         0 |      0 |     1 |         1 |           0 | DECISION_CHANGED |
| btcusdt-1d | pineDocumented-vs-app | rolling-window (735-1099) |      365 | 6.62e-5 / 4.10e-8 / 2.10e-8           | 2.05e-4 / 1.05e-4              |         0 |      0 |     0 |         0 |           0 | NUMERICAL_ONLY   |
| btcusdt-1d | customInit-vs-app     | rolling-window (735-1099) |      365 | 6.62e-5 / 4.10e-8 / 2.10e-8           | 2.05e-4 / 1.05e-4              |         0 |      0 |     0 |         0 |           0 | NUMERICAL_ONLY   |

The threshold case's last bar has a weighted score of 59.4999996 in the app (score 59, no
eligibility) and 59.5000004 under continuous history (score 60, conservative and moderate
eligibility). In `btcusdt-1d`, both continuous models start at the snapshot's first bar, 735
bars before the first evaluated bar, instead of at the 2017 listing. Earlier history moves their
values by far less than the differences shown.

### Runtime matrix (real Pine, 2026-10-27)

Tallies logged by [`zerochart_parity_selfcheck.pine`](../pine/diagnostics/zerochart_parity_selfcheck.pine)
on TradingView, verbatim in [`pine-parity-runtime-2026-10-27.json`](pine-parity-runtime-2026-10-27.json).
A mismatch is any difference in readiness, rounded score, regime or momentum class on a confirmed
bar. "H1 predicted" is the production-versus-app count if H1 had held.

| Case       | Bars | Candidate ≠ app | Production ≠ app | H1 predicted | Production ≠ H1 | Production differences                                                 |
| ---------- | ---: | --------------: | ---------------: | -----------: | --------------: | ---------------------------------------------------------------------- |
| BTCUSDT 1D |  365 |               0 |                0 |            0 |               0 | None. Inputs equal the snapshot on 564/564 bars                        |
| rising     |  320 |               0 |                0 |          306 |             306 | None. H1's early readiness and EMA transient do not occur              |
| falling    |  320 |               0 |                0 |           31 |              31 | None                                                                   |
| flat       |  320 |               0 |              287 |          306 |              19 | RSI 100 vs 50 on every ready bar: score 35 vs 62                       |
| irregular  |  320 |               0 |                0 |           44 |              44 | None                                                                   |
| threshold  |  261 |               0 |                1 |           45 |              44 | Bar 260 rounds to 60 vs 59 (rolling window), as `customInit` predicted |

The 19 flat mismatches against H1 are bars 14 to 32, where H1 expected Pine to be ready. Key-point
values (bars 33, 99, 199, 200 and the last bar of each case) are in the evidence file, and
`npm test` checks every number in this table against it.

### Separating tolerance from decisions

- **Numerical only:** after the window rolls, every difference is below `1.1e-4` weighted
  points, `6.7e-5` RSI points, `4.1e-8` momentum and `2.1e-8` volatility. These never change a
  decision unless a reading sits at least that close to a threshold.
- **Changed decisions** come from three sources: Pine is ready before the app (bars 14-32);
  first-sample EMA transients through bar ~199, if H1 holds; and the flat-RSI convention, if
  H1 holds. A constructed tie shows the fourth source, rounding near a threshold, which no window
  length removes. **At runtime only the flat-RSI convention and the tie occurred.** The first
  two sources do not exist on TradingView.

### Bounded-equivalence contract for production Pine

Production Pine and the app agree on a decision at a bar only when **all** of these hold:

1. Both read `BINANCE:BTCUSDT` (or the same Binance Spot pair) on `1D`, on a confirmed bar, with
   ATR Period 14.
2. The app's 200-candle window passes `binance-daily-v1`, and no averaged RSI gain/loss pair is
   0/0 (flat).
3. The bar is at least the 34th on the chart (bar index 33). Runtime showed no first-sample
   transient, so no extra warm-up is needed. Through bar 199 the app's window is the chart's
   whole history and the two agree.
4. The app's weighted score is more than the drift `ε` away from every rounding boundary that
   moves a decision (28.5, 59.5, 70.5, 77.5, 79.5), and each regime input is more than its drift
   away from its threshold (volatility 0.04, |momentum| 0.005, RSI 30/70, momentum 0 and 0.0005).

`ε` is data-dependent. The slowest decaying term is the slow EMA's seed error times
`(25/27)^174 ≈ 1.6e-6`, and the RSI/ATR seed error times `(13/14)^186 ≈ 1.0e-6`. Observed `ε`
is at most `1.05e-4` weighted points on a year of BTCUSDT and `4.0e-5` on the synthetic walks.
There is no a priori bound without bounding the price path. Inside the band, the rounded score
and every decision derived from it can differ. Signal transitions inherit the difference from
either bar, and trailing stops are never comparable.

## 3. Correction candidate

The candidate keeps the TypeScript model unchanged. Pine meets an explicitly defined
input-window contract instead, so no canonical model version, campaign or stored evaluation has
to change.

**Why custom initialization is not enough.** Runtime showed production Pine already uses
the SMA seeds, so porting them changes nothing except the flat RSI. Seeds alone (`customInit`)
remove every difference while the chart and the app share one finite window. After that, Pine's
single recurrence keeps memory the app discards when it re-seeds each day. The matrix shows that
drift, and the threshold case shows it changing eligibility. Exact agreement requires Pine to
discard the same history the app does.

**What the candidate changes** (`pine/candidates/zerochart_quant_hud_w200.pine`, attribution
`1.0.0-pw200.c1`):

- On every bar it recomputes RSI(14), MACD(12, 26, 9) and ATR(14) over the last
  `min(200, bar_index + 1)` bars, with `indicators.ts`'s seeds and operation order (`zcRsi`,
  `zcMacdHist`, `zcAtr`).
- It has no score before 34 bars, and no partial renormalized score. The HUD shows
  `NOT ENOUGH DATA`.
- ATR Period drives only sizing and the trailing stop. The score always uses ATR(14).
- Alerts send `model_version: "1.0.0-pw200.c1"`. `tv-webhook` accepts that format, and
  `execute_tactical_signal` refuses it because it accepts only `1.0.0`. A candidate signal could
  be stored but never booked.
- The factor curves, regimes, weights, rounding, sizing formula, trailing stop and alert
  conditions are unchanged.

**What it cannot fix:** the realtime bar is intrabar until it closes; Pine has no candle
validation, so a gap the app would reject is still scored; sizing uses Pine's continuous
`ta.atr(atrPeriod)`, not the app's windowed ATR; the timeframe is whatever the chart shows.
The several hundred loop iterations per bar stayed inside TradingView's limits on the full
BTCUSDT `1D` history from 2017 (runtime, 2026-10-27).

**Runtime result.** The candidate matched every app decision on 1,906 bars (runtime finding 1).
It is not bit for bit: two of 26 key-point histograms differ from production TypeScript by up to
`6.2e-15` relative (at most `1.7e-13` absolute), although the operation order is the same, so the
Pine runtime's arithmetic is not exactly V8's. Those differences move the weighted score by far
less than `1e-12` points. Decisions can therefore differ only when the app's weighted score sits
within about `1e-12` of a rounding boundary, against `1.05e-4` observed for production Pine.

## 4. Pine runtime evidence

**Status: the candidate's decision-level parity is verified at runtime on BTCUSDT `1D` and all
five fixtures (2026-10-27).** Verbatim logs:
[`pine-parity-runtime-2026-10-27.json`](pine-parity-runtime-2026-10-27.json), checked by `npm test`.

### How it ran

- TradingView web, Pine Script v6, in the owner's browser with the owner's approval, on an
  Essential plan. The scripts ran on a **new** layout, `ZC Parity Harness`, on `BINANCE:BTCUSDT`
  `1D`. The layout that holds alert `5917202050` was not changed. No alert was created, edited or
  opened, and no alert message, log, payload or token was read.
- The harness compiled and ran without errors. Its export path was unavailable, because
  "Download chart data" needs a higher plan, and no plan was purchased.
- Instead, [`zerochart_parity_selfcheck.pine`](../pine/diagnostics/zerochart_parity_selfcheck.pine),
  which `npm run parity -- --emit-selfcheck` generates, is the harness plus the Decimal fixtures'
  per-bar readings and the snapshot's 564 input bars. Pine compares its own readings on every
  confirmed bar and writes tallies and key-point values to Pine Logs. Six runs switched the
  **Bars** input, and their log lines were copied verbatim.
- Each script was fetched from GitHub at a pinned commit and read back from the editor. The
  self-check (`e573224`, SHA-256 `8b59c2a9…`) and the candidate (`a5032d3`, SHA-256 `014af558…`)
  were byte-identical to the repository.
- The full candidate script then compiled and ran on the same chart with no compile or time-limit
  error. Its HUD showed `Signal Score: 52 / 100 (1.0.0-pw200.c1)` on the forming bar, the same
  as the harness's candidate reading.

| Evidence                                                                     | Status                                                                                   |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Production TypeScript = independent Decimal `app` contract on 1,906 bars     | **Verified** (`npm run parity`, `scripts/pine-parity.test.ts`)                           |
| TradingView `BINANCE:BTCUSDT` `1D` bars = Binance Spot klines                | **Verified at runtime**: high, low and close equal on 564 bars, 2025-04-11 to 2026-10-26 |
| Active alert symbol, resolution and inputs                                   | **Verified** from allowlisted metadata                                                   |
| H1: first-sample `ta.ema`, Pine ready from bar 14                            | **Refuted at runtime**: `ta.macd` is SMA-seeded, and Pine is ready from bar 33           |
| H1: flat `ta.rsi` = 100                                                      | **Confirmed at runtime**                                                                 |
| Production Pine readings on real and fixture bars                            | **Measured at runtime** (runtime matrix and key points)                                  |
| Candidate compiles, stays inside TradingView's limits, matches app decisions | **Verified at runtime** on BTCUSDT `1D` and all five fixtures                            |
| Candidate equals the app bit for bit                                         | **Refuted**: within `6.2e-15` relative; 2 of 26 key-point histograms are not identical   |
| Candidate alerts, webhook JSON and delivery                                  | **Not exercised**: no alert was created                                                  |

### Reproduce

Self-check (any TradingView plan):

1. Open a **new** chart layout on `BINANCE:BTCUSDT`, `1D`. Leave the layout that holds alert
   `5917202050` alone, and create no alerts.
2. Pine Editor → New indicator → paste
   [`pine/diagnostics/zerochart_parity_selfcheck.pine`](../pine/diagnostics/zerochart_parity_selfcheck.pine)
   (the same as `npm run parity -- --emit-selfcheck`) → Add to chart.
3. Open Pine Logs. For each **Bars** value (`Chart`, `rising`, `falling`, `flat`, `irregular`,
   `threshold`), read the `zc_selfcheck` line. Pass: `candVsApp=0`, `compared` equals the case's
   bar count, and `inputs=564/564` on `Chart`. The `Chart` run compares only the snapshot's bars,
   which end on 2026-10-26.

Export (plans with "Download chart data"): add the harness
[`pine/diagnostics/zerochart_parity_harness.pine`](../pine/diagnostics/zerochart_parity_harness.pine)
instead, export each **Bars** setting with UNIX time, and run:

```bash
npm run parity -- --pine-export ~/Downloads/<file>.csv [--case <name>]
```

Pass: `candidate.readinessMismatches`, `scoreMismatches` and `regimeMismatches` are 0 (exit code
0). Export columns: `zc_bar`, `zc_confirmed`, `zc_high/low/close`, and for `prod` and `cand`:
`ready`, `rsi`, `hist`, `atr`, `score`, `regime` (0 NEUTRAL, 1 TRENDING, 2 MEAN_REVERTING,
3 HIGH_VOLATILITY). This path has not run, because the export was unavailable.

**Acceptance:** zero candidate readiness, score and regime mismatches on every confirmed bar of
BTCUSDT `1D` and all five fixtures, with no compile or time-limit error. **Met on 2026-10-27
through the self-check.** Re-run it before any promotion, because TradingView can change its
built-ins.

## 5. Preserved behavior

This change modifies no runtime code path:

- `canonicalModel.ts`, `indicators.ts`, `CANONICAL_MODEL_VERSION` (`1.0.0`) and portfolio rules
  are unchanged. Only comments that overstated parity were corrected.
- `pine/zerochart_quant_hud.pine`, the script the app copies, is byte-identical, and a test
  asserts that `buildPineScript()` still serves it. Nothing under `src/` references the
  candidate or the harness.
- The self-check and the runtime evidence file are diagnostics. Nothing under `src/` reads them.
- `tv-webhook`, migrations, `execute_tactical_signal`, booking, alert `5917202050` and the
  campaign stores are untouched. No campaign was initialized or activated. Historical evaluations,
  observations, outcomes and legacy schema-1 reproduction are unaffected.

## 6. Rollout and rollback

Each step needs the owner's approval. Steps 1 to 3 are done: #95 merged, migration
`20261027120000` was applied, and production has served `1.0.0-pw200` since about 02:30Z on
2026-10-27. Step 4 is the owner's.

1. **Runtime acceptance** (section 4) on BTCUSDT `1D` and all five fixtures. **Met on
   2026-10-27 at the decision level.** Runtime also narrowed the case for switching: production
   Pine already matches the app except on flat RSI windows and rolling-window ties, and the
   candidate removes both.
2. **Attribution decision (owner, 2026-10-27):** a distinct `model_version`, `1.0.0-pw200`,
   accepted by `execute_tactical_signal` through a reviewed migration. The TypeScript model stays
   `1.0.0`. Signal rows recorded before the switch stay `1.0.0` and are never relabeled.
3. **Promotion PR:** production Pine becomes the candidate (a test proves the code is unchanged),
   and migration `20261027120000` accepts `1.0.0-pw200` only when the timeframe is `1D` or `D`.
   `1.0.0` stays executable on any timeframe during the switch-over (expand). The Action Center
   applies the same rule. Before merging, re-run the self-check on TradingView, then apply the
   migration and check the release contract ([RELEASE.md](RELEASE.md)).
4. **Owner switch-over:** copy the new script, create a new alert on a `1D` chart, confirm the
   first `1.0.0-pw200` signal shows in the Action Center and executes as a paper trade, then
   stop the old 60-minute alert. This is the first time the candidate's alert and webhook paths
   run. A later migration may stop executing `1.0.0` signals (contract).
   - Don't generate a new webhook token for this. Each user has one token, and generating one
     replaces the token the hourly alert sends, so that alert would get 401. Copy the script
     without generating a token and replace `USER_SECRET_PLACEHOLDER` with the current token
     from the hourly alert's script. An alert that sends the placeholder is also refused with 401.
   - Create the alert on `BINANCE:BTCUSDT` `1D` with the `ZC Quant pw200` condition "Any
     alert() function call" and the same webhook URL as the hourly alert. A price alert is not a
     substitute.
   - While both alerts run, 00:00Z closes both bars. Stored hourly signals carry the bar-close
     second as `event_id` (`…T14:00:00Z`), so both alerts are expected to send the same
     `event_id` then. `ingest_tradingview_signal` keeps one row per user, ticker, action and
     `event_id`: when both send the same action, the later one is answered `duplicate` and not
     stored, whichever version it is. After each 00:00Z fire, compare both alerts' fire times
     with the stored rows.
   - Both versions' pending signals are separate rows and both executable, so booking both
     doubles the paper position.
5. **Evidence:** app campaigns score TypeScript only, so their evidence is unaffected. Any study
   of TradingView signals starts a new campaign ID after the switch. `private-2026q4-001`
   stays frozen.

**Rollback:** roll the frontend back with Vercel Instant Rollback (the migration only adds). For
Pine, re-copy the `1.0.0` script from the previous commit and recreate the alert. To stop
booking `1.0.0-pw200`, write a follow-up migration that withdraws it; pending pw200 signals then
stay non-executable. Stored signals keep their attribution, and no rows are deleted or
rewritten.

## 7. Limitations

- Runtime evidence comes from one session on one day, in TradingView web on an Essential plan.
- Pine compared readiness, score, regime and momentum class on every bar, but raw indicator
  values only at 26 key points, because no full export was available.
- The real-data comparison covers the snapshot: 365 evaluated days and 564 input bars.
- The Decimal matrix's `pineDocumented` rows model a hypothesis that runtime partly refuted. They
  stay as the pre-runtime record, and the runtime matrix supersedes them.
- Synthetic cases are 320 bars or fewer. Longer charts cannot remove production Pine's tie risk.
- The candidate's alerts, webhook JSON, sizing and intrabar realtime behavior were not exercised,
  and only `1D` was run.
- The Pine runtime's arithmetic differs from V8 in the last bits for the same operation order.
  The cause is unknown, so equivalence is bounded, not exact.
- The candidate's and harness's header comments predate the runtime run. They were left
  unchanged so the files that ran keep their recorded hashes.
