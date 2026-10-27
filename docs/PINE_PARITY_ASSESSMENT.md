# TypeScript-versus-Pine parity assessment

Baseline: `main` at `a53b871`, canonical model `1.0.0`, production Pine
[`pine/zerochart_quant_hud.pine`](../pine/zerochart_quant_hud.pine) unchanged. This is a
numerical and decision-contract assessment. It says nothing about predictive value.

## Findings

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
   documented RSI convention, which is not. Both results depend on hypothesis H1 below and are
   unverified at runtime.
5. **A Pine port of the seeds alone is insufficient.** It is exact while the chart and the app
   see the same finite window (bars 33-199). Once the window rolls, it drifts by up to `1.05e-4`
   points, and a constructed tie at bar 260 rounds to 60 in Pine but 59 in the app, which
   changes eligibility. 200 candles bound the drift. They do not guarantee convergence.
6. **The isolated correction candidate**
   [`pine/candidates/zerochart_quant_hud_w200.pine`](../pine/candidates/zerochart_quant_hud_w200.pine)
   recomputes the score on the app's window. Its equivalence to the app holds by construction,
   but **it has not been compiled or run on TradingView. Pine runtime behavior, for production
   and candidate alike, is unverified.**

## 1. Comparison contract

A Pine score and an app score are comparable only when every row of this table matches. A
difference outside this contract is not a defect.

| Dimension                 | App (`canonicalModel.ts`)                                                                                        | Production Pine HUD                                                                                                                                                                                              | Comparison rule                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Exchange and instrument   | Binance Spot `GET /api/v3/klines`, symbol `BTCUSDT` (`toBinanceSymbol`)                                          | The chart symbol. `toTradingViewSymbol` maps crypto to `BINANCE:<base>USDT`                                                                                                                                      | `BINANCE:BTCUSDT` against Binance Spot `BTCUSDT`. Another venue, `BTCUSD` or a perpetual is a different instrument |
| Timeframe and boundaries  | `1d`, open at `00:00:00.000Z`, close `open + 86,399,999 ms` ([candle contract](CANDLE_INPUT_CONTRACT.md))        | The chart resolution. The active alert uses `60`                                                                                                                                                                 | `1D` only. Hourly bars have no app contract, and the daily validator is never applied to them                      |
| Closed bars               | Closed candles only. Open candles are excluded                                                                   | Historical bars are closed. The realtime bar recomputes on every tick. `alert()` uses `alert.freq_once_per_bar_close`. An `alertcondition` alert follows the trigger frequency chosen when the alert was created | Confirmed bars only (`barstate.isconfirmed`, exported as `zc_confirmed`)                                           |
| History and anchor        | The latest `min(200, n)` closed candles, re-seeded on every evaluation. Fewer than 34 means `INSUFFICIENT_DATA`  | One recurrence from the chart's first loaded bar (the 2017 listing for daily BTCUSDT). The anchor depends on the history TradingView loads                                                                       | Identical only on the same finite window. Otherwise apply the bounded contract in section 2                        |
| Input validation          | `binance-daily-v1`: gaps, duplicates and inconsistent OHLC are `DATA_INVALID`                                    | None                                                                                                                                                                                                             | Compare only windows that pass `binance-daily-v1`                                                                  |
| RSI(14)                   | Wilder. The seed is the mean of the first 14 changes, first value at index 14. Flat (both averages 0) returns 50 | `ta.rsi(close, 14)`: Wilder through `ta.rma`, same seed. **Flat behavior is unverified.** H1 assumes 100, the `down == 0` guard used by TradingView's RSI indicator script; `ta.rsi` itself was not checked      | Identical except on flat windows, where the H1 convention diverges                                                 |
| MACD(12, 26, 9)           | Independently SMA-seeded EMAs. Histogram from index 33 ([verification](QUANT_MODEL_VERIFICATION.md))             | `ta.macd`: TradingView EMA, documented as seeded by the first sample (H1). **Warm-up publication is unverified**                                                                                                 | Seed convention class B, decaying as `(25/27)^k` (slow EMA) and `0.8^k` (signal)                                   |
| ATR(14)                   | First TR `high - low`, SMA seed of TR 0-13 at index 13, then Wilder                                              | `ta.atr(atrPeriod)` = `ta.rma(ta.tr(true), atrPeriod)`, the same convention **when ATR Period is 14**                                                                                                            | ATR Period must be 14. In production it moves the score, the size and the stop. The active alert uses 14           |
| Factors, regime, rounding | Piecewise RSI curve, ±1% momentum saturation, 0.5%-5.5% volatility band, first-match regimes, `Math.round` once  | The same operations in the same order. `math.round` rounds ties up, which equals `Math.round` for nonnegative scores                                                                                             | Identical arithmetic. Last-bit differences in the Wilder/EMA recurrences can matter only at exact ties             |
| Readiness                 | `INSUFFICIENT_DATA` below 34 candles or on a non-finite reading                                                  | `ready` once RSI, the MACD histogram and ATR are non-na (bar 14 under H1). Before that, `ZC Score` plots a score renormalized over the available factors                                                         | Pine's early bars have no app counterpart                                                                          |
| Floating point            | IEEE-754 binary64                                                                                                | Assumed binary64 (unverified)                                                                                                                                                                                    | Tolerance `1e-12` relative for the reference check. Decisions compare exactly                                      |

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

| Model            | Definition                                                                                                                                                                               | Status                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `app`            | ZeroChart contract: the last `min(200, n)` candles, SMA seeds, RSI 50 when flat, a 34-candle minimum                                                                                     | Production TypeScript matches it on every bar (`npm run parity`) |
| `pineDocumented` | **Hypothesis H1**: first-sample `ta.ema`, SMA-seeded `ta.rma`, `ta.tr(true)`, continuous history from bar 0, RSI 100 when the average loss is 0, ready when RSI, MACD and ATR are non-na | A model of the documentation. **Not runtime evidence**           |
| `customInit`     | ZeroChart's seeds on continuous history from bar 0, without the rolling window                                                                                                           | What a Pine port of the initialization alone computes            |

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

### Separating tolerance from decisions

- **Numerical only:** after the window rolls, every difference is below `1.1e-4` weighted
  points, `6.7e-5` RSI points, `4.1e-8` momentum and `2.1e-8` volatility. These never change a
  decision unless a reading sits at least that close to a threshold.
- **Changed decisions** come from three sources: Pine is ready before the app (bars 14-32);
  first-sample EMA transients through bar ~199, if H1 holds; and the flat-RSI convention, if
  H1 holds. A constructed tie shows the fourth source, rounding near a threshold, which no window
  length removes.

### Bounded-equivalence contract for production Pine

Production Pine and the app agree on a decision at a bar only when **all** of these hold:

1. Both read `BINANCE:BTCUSDT` (or the same Binance Spot pair) on `1D`, on a confirmed bar, with
   ATR Period 14.
2. The app's 200-candle window passes `binance-daily-v1`, and no averaged RSI gain/loss pair is
   0/0 (flat).
3. The chart has at least about 200 bars before the window starts, so the first-sample transient
   has decayed below the drift in item 4.
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

**Why custom initialization is not enough.** Porting the SMA seeds into Pine (`customInit`)
removes every difference while the chart and the app share one finite window. After that, Pine's
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
Several hundred loop iterations per bar may approach TradingView's execution limits on
long charts. That is unverified (see the `ponytail:` note in the script).

If IEEE-754 binary64 arithmetic and the transcribed operation order both hold, the candidate
should match the app bit for bit on confirmed daily bars. That is a design property, **not
verified parity**.

## 4. Pine runtime evidence

**Status: unverified.** In this assessment, nothing compiled or ran Pine.

- The TradingView MCP available here returns market data, alert metadata and watchlists. It has
  no Pine compilation, execution or export.
- No TradingView chart or Pine Editor was opened, and no alert was created, edited or inspected
  beyond list metadata (id, symbol, resolution, active state, name with inputs, creation,
  expiration and last fire time). No alert message, log entry, payload or token was read or printed.
- TradingView's reference manual did not render outside a browser session, so H1 rests on the
  documentation already cited in [QUANT_MODEL_VERIFICATION.md](QUANT_MODEL_VERIFICATION.md).

| Evidence                                                                  | Status                                                                                                                           |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Production TypeScript = independent Decimal `app` contract on 1,906 bars  | **Verified** (`npm run parity`, `scripts/pine-parity.test.ts`)                                                                   |
| TradingView `BINANCE:BTCUSDT` bars = Binance Spot klines                  | **Verified, sampled only**: 5 closed `1D` and 3 closed `1h` bars matched exactly on 2026-10-27. The forming bar differed by 0.01 |
| Active alert symbol, resolution and inputs                                | **Verified** from allowlisted metadata                                                                                           |
| H1: first-sample `ta.ema`, flat `ta.rsi` = 100, Pine ready from bar 14    | **Unverified**                                                                                                                   |
| Production Pine values on real bars                                       | **Unverified**                                                                                                                   |
| Candidate compiles, stays inside TradingView's limits and matches the app | **Unverified**                                                                                                                   |
| Pine floats are binary64                                                  | **Unverified**                                                                                                                   |

### Owner verification steps

The harness [`pine/diagnostics/zerochart_parity_harness.pine`](../pine/diagnostics/zerochart_parity_harness.pine)
sends no alerts. It plots production-semantics readings (`zc_prod_*`) and candidate readings
(`zc_cand_*`) side by side.

1. In TradingView, open a **new** chart layout on `BINANCE:BTCUSDT`, `1D`. Leave the layout
   that holds alert `5917202050` alone, and create no alerts.
2. Pine Editor → New indicator → paste the harness → Add to chart. Note any compile error
   verbatim. A compile error means the candidate code needs fixing too, since the window functions
   are shared.
3. Keep **Bars = Chart**. Chart menu → Export chart data (all bars, UNIX or ISO time). Then run:

   ```bash
   npm run parity -- --pine-export ~/Downloads/<file>.csv
   ```

   Expected: `candidate.readinessMismatches`, `scoreMismatches` and `regimeMismatches` are 0
   (exit code 0). `production.*` is the first runtime measurement of the current discrepancy.

4. For each of `rising`, `falling`, `flat`, `irregular` and `threshold`: set **Bars** to the
   case, export, and run:

   ```bash
   npm run parity -- --pine-export ~/Downloads/<file>.csv --case <name>
   ```

   Expected: `fixtureInputMismatches` is 0 (Pine regenerated the inputs exactly), and the
   candidate mismatches are 0. `hypothesisH1Mismatches` tests H1: 0 confirms TradingView's
   documented conventions on that case. Anything else is the runtime behavior to record,
   especially for `flat` (RSI convention) and bars 0-33 (EMA warm-up and readiness).

5. Record in the PR: export date, chart history start, plan-imposed bar limits, the command
   output, and any compile or time-limit errors.

Comparison fields: `zc_bar`, `zc_confirmed`, `zc_high/low/close`, and for both `prod` and
`cand`: `ready`, `rsi`, `hist`, `atr`, `score`, `regime` (0 NEUTRAL, 1 TRENDING,
2 MEAN_REVERTING, 3 HIGH_VOLATILITY). Score, regime and readiness are integers and compare
exactly. Indicator values are reported as maximum absolute differences, because the precision
of TradingView's export is itself unverified.

**Acceptance:** zero candidate readiness, score and regime mismatches on every confirmed bar of
the BTCUSDT export and all five fixtures, with no compile or time-limit error. Until then, the
candidate is "unverified" in every document and PR.

## 5. Preserved behavior

This change modifies no runtime code path:

- `canonicalModel.ts`, `indicators.ts`, `CANONICAL_MODEL_VERSION` (`1.0.0`) and portfolio rules
  are unchanged. Only comments that overstated parity were corrected.
- `pine/zerochart_quant_hud.pine`, the script the app copies, is byte-identical, and a test
  asserts that `buildPineScript()` still serves it. Nothing under `src/` references the
  candidate or the harness.
- `tv-webhook`, migrations, `execute_tactical_signal`, booking, alert `5917202050` and the
  campaign stores are untouched. No campaign was initialized or activated. Historical evaluations,
  observations, outcomes and legacy schema-1 reproduction are unaffected.

## 6. Rollout and rollback (future work)

Not started. Each step needs the owner's approval.

1. **Runtime acceptance** (section 4) on BTCUSDT `1D` and all five fixtures.
2. **Attribution decision.** The TypeScript model stays `1.0.0`. Pine-originated signals need to
   say which Pine implementation produced them. Either:
   - accept a distinct `model_version`, such as `1.0.0-pw200`, in `execute_tactical_signal`
     through a new migration (a booking change, reviewed on its own), or
   - add a separate implementation field to the `tv-webhook` payload and table.

   Signal rows recorded before the switch stay `1.0.0` from the old implementation and are never
   relabeled.

3. **Promotion PR:** replace `pine/zerochart_quant_hud.pine` with the accepted candidate and update
   `pineScriptTemplate` tests. Deploy the migration before the frontend ([RELEASE.md](RELEASE.md)).
4. **Owner switch-over:** copy the new script, create a new alert on the intended timeframe
   (`1D` if signals should match the app), confirm deliveries, then retire the old alert.
   Whether a 60-minute alert should be executable at all is a separate decision, because
   execution does not check the timeframe today.
5. **Evidence:** app campaigns score TypeScript only, so their evidence is unaffected. Any study
   of TradingView signals starts a new campaign ID after the switch. `private-2026q4-001`
   stays frozen.

**Rollback:** re-copy `pine/zerochart_quant_hud.pine` from the previous commit and recreate the
alert. Stored candidate signals keep their attribution. If a migration accepted the new
version, a follow-up migration withdraws it. No rows are deleted or rewritten.

## 7. Limitations

- H1 models TradingView's documentation, not its runtime. It may be wrong about EMA warm-up or
  the flat RSI.
- Only eight bars were compared between TradingView and Binance.
- The real-data continuous models start in 2023, not 2017.
- Synthetic cases are 320 bars or fewer. Real charts run longer, which helps continuous models
  converge but cannot remove tie risk.
- The candidate and harness are hand-transcribed Pine that has never been compiled. Source-level
  tests only check isolation and constants.
