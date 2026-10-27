# Canonical quant model numerical verification

Verified against model version `1.0.0` at repository baseline
`a190ad201db377a6855f51542a02c166d20904ef`. This is a numerical and decision-contract
review. It is not evidence of predictive value, profitability, or suitability for trading.

## Classification summary

- **A — Correct and independently verified:** Wilder RSI, the declared SMA-seeded EMA
  composition used by MACD, first-bar-range Wilder ATR, warm-up alignment, factor
  transformations, regime precedence, final rounding, profile thresholds, deterministic
  ranking, per-asset caps, and retained cash.
- **B — Intentional convention difference:** ZeroChart MACD composes independently seeded
  fast and slow EMAs. TA-Lib's composite MACD aligns both seed windows to the slow EMA;
  TradingView's documentation describes an EMA started from the first sample, but at runtime
  (2026-10-27) `ta.macd` followed ZeroChart's SMA seeds ([Pine parity
  assessment](PINE_PARITY_ASSESSMENT.md)). ZeroChart ATR defines the
  first true range as `high - low`; TA-Lib ATR consumes a previous close and therefore first
  publishes one bar later. These are initialization conventions, not universal mathematical
  errors.
- **C — Actual defect:** the repository describes the TypeScript engine and Pine HUD as a
  1:1 port, but Pine's `ta.macd()` uses TradingView's EMA convention while TypeScript uses
  independent SMA seeds. Exact parity is therefore not established during the transient.
  This PR does not change scores under model `1.0.0`; correcting either side would require a
  new model version, Pine parity changes, and a new campaign. Existing campaign evidence must
  remain labeled `1.0.0` and must not be rewritten.
  **Runtime correction (2026-10-27):** the MACD part of this defect did not occur on
  TradingView. Production Pine still differs from TypeScript on flat RSI windows (`ta.rsi`
  returns 100, TypeScript 50) and once the 200-candle window rolls
  ([Pine parity assessment](PINE_PARITY_ASSESSMENT.md)).
- **D — Resolved at ingestion:** the pure OHLC model remains deliberately mathematical, while
  the shared `binance-daily-v1` boundary now sorts valid unordered input and rejects duplicate
  timestamps, missing daily intervals, invalid timestamp/close-time semantics, nonpositive or
  nonfinite prices, `high < low`, and available opens/closes outside `[low, high]`. Open candles
  are excluded and freshness remains a separate status. Legacy schema-1 evidence retains its
  original behavior for exact reproduction.

## Exact mathematical contract

All indicator arrays align with the input array and contain `NaN` before their first defined
value. Candle order is caller-provided and is interpreted oldest first.

### Wilder RSI(14)

For changes `delta[t] = close[t] - close[t-1]`, gain is `max(delta, 0)` and loss is
`max(-delta, 0)`. The seed at index 14 is the arithmetic mean of the first 14 gains and first
14 losses. Later values use Wilder smoothing:

```text
avg[t] = (13 * avg[t-1] + observation[t]) / 14
```

RSI is `100 - 100 / (1 + avgGain/avgLoss)`. One-sided gain returns 100; one-sided loss
returns 0; zero gain and zero loss returns the explicit neutral convention 50. Fourteen or
fewer closes have no RSI; the first RSI needs 15 closes.

### MACD(12,26,9)

Each price EMA is independently seeded with the arithmetic mean of its own first `period`
values at index `period - 1`. Later values use:

```text
EMA[t] = EMA[t-1] + (2 / (period + 1)) * (value[t] - EMA[t-1])
```

The MACD line is `EMA12 - EMA26` and first exists at index 25. The signal EMA is seeded with
the mean of MACD indices 25 through 33, then uses the same EMA recurrence with period 9. The
signal and histogram (`MACD - signal`) first exist at index 33, so 34 closes are required.

This exact composition is verified by the independent Decimal generator. It should not be
called "TA-Lib MACD" without qualification: TA-Lib CLASSIC also uses SMA seeds, but its fast
seed window is aligned to the end of the slow seed window. TradingView's documentation suggests
a first-sample EMA seed, but at runtime on 2026-10-27 `ta.macd()` matched this composition
through the warm-up ([Pine parity assessment](PINE_PARITY_ASSESSMENT.md)).

### Wilder ATR(14)

The first true range is deliberately `high[0] - low[0]`. For later bars:

```text
TR[t] = max(high[t] - low[t], abs(high[t] - close[t-1]), abs(low[t] - close[t-1]))
```

ATR at index 13 is the arithmetic mean of true ranges 0 through 13. Later ATR values use
`(13 * ATR[t-1] + TR[t]) / 14`. This matches the Pine expression
`ta.rma(ta.tr(true), 14)`, where the `true` handling supplies `high-low` when the previous
close is unavailable. TA-Lib instead requires a previous close for every true range and first
publishes ATR(14) at index 14. The one-bar difference is convention B.

### Minimum history and invalid values

The composite minimum is `max(15, 26 + 9 - 1, 14) = 34` candles. Exactly 34 valid candles
are scoreable. Fewer return `INSUFFICIENT_DATA`. The model also returns that status when the
last close, RSI, histogram, or ATR is nonfinite, or the last close is not positive. It reports
the supplied count even when the cause is invalid content, so the status is not a detailed
validation error.

Indicator parameter errors and mismatched ATR array lengths produce all-`NaN` arrays. The
pure model does not validate `high >= low`, `low <= close <= high`, timestamp order,
uniqueness, or cadence. It does not silently sort, deduplicate, or synthesize bars.

### Component transformations

- RSI is clamped to `[0,100]`, then linearly interpolated through
  `(0,100)`, `(30,95)`, `(50,55)`, `(70,15)`, `(100,0)`.
- Normalized momentum is `MACD histogram / last close`. Its score is
  `clamp(50 + 50 * momentum / 0.01, 0, 100)`; zero is 50 and +/-1% saturates.
- Normalized volatility is `ATR / last close`. Its score is
  `clamp(100 * (1 - (volatility - 0.005) / 0.05), 0, 100)`; 0.5% is 100 and
  5.5% is 0.

The exported factor helpers do not reject nonfinite direct inputs. Production scoring reaches
them only after `evaluateCandles` verifies finite terminal indicator readings.

### Regime, weights, and rounding

Classification is first-match-wins with inclusive boundaries:

1. `volatility >= 0.04` => `HIGH_VOLATILITY`.
2. `abs(momentum) >= 0.005` => `TRENDING`.
3. `RSI <= 30` or `RSI >= 70` => `MEAN_REVERTING`.
4. Otherwise => `NEUTRAL`.

Weights are `(RSI, momentum, volatility)`:

| Regime          | Weights              |
| --------------- | -------------------- |
| Neutral         | `(0.40, 0.40, 0.20)` |
| Trending        | `(0.30, 0.50, 0.20)` |
| Mean-reverting  | `(0.50, 0.30, 0.20)` |
| High-volatility | `(0.35, 0.35, 0.30)` |

The weighted sum is divided by the row sum, clamped to `[0,100]`, and rounded once with
JavaScript `Math.round`. Scores are nonnegative, so a mathematical `.5` rounds upward.
Components remain unrounded floating-point values.

### Eligibility, ranking, and allocation

| Profile      | Eligible score | Additional gate                       | Holdings | Per-asset cap |
| ------------ | -------------: | ------------------------------------- | -------: | ------------: |
| Conservative |        `>= 60` | regime is not high-volatility         |        8 |           10% |
| Moderate     |        `>= 60` | none                                  |        5 |           25% |
| Aggressive   |        `>= 71` | momentum component is strictly `> 50` |        3 |           50% |

Eligibility is evaluated before selection. Eligible candidates sort by descending integer
score, then ascending ticker using `localeCompare`, then original index if both fields tie.
Only the first profile holding count is selected. Each selected weight is independently
`min(score / selectedScoreTotal, cap)`. Capped weight is not redistributed, so total weight
can be below 100%; the remainder stays unallocated cash. Dollar allocation rounds to cents
with `Number((capital * weight).toFixed(2))`.

## Independent evidence

The committed fixture [`quant-reference-fixtures.json`](quant-reference-fixtures.json) is
generated by Python standard-library `Decimal` arithmetic. The generator imports no ZeroChart
module and can be reproduced exactly with:

```bash
python3 scripts/generate-quant-reference-fixtures.py
git diff --exit-code -- docs/quant-reference-fixtures.json
```

The hand cases show RSI(3), MACD(2,3,2), ATR(2), and a gap-dominated true range. The larger
fixtures cover monotonic rise/fall, a flat market, a deterministic irregular sequence, and the
same sequence around `1e-6` prices. Tests use relative tolerance `1e-12` with absolute floor
`1e-24`; boundary and hand cases use exact values where binary representation permits.

Reference source revision: TA-Lib
[`62021c1d14ef5499505af5547384cab509adf3fc`](https://github.com/TA-Lib/ta-lib/tree/62021c1d14ef5499505af5547384cab509adf3fc).
The inspected primary sources are
[`TA_RSI.c`](https://github.com/TA-Lib/ta-lib/blob/62021c1d14ef5499505af5547384cab509adf3fc/src/ta_func/ta_RSI.c),
[`macd.c`](https://github.com/TA-Lib/ta-lib/blob/62021c1d14ef5499505af5547384cab509adf3fc/ta_codegen/input/macd/macd.c), and
[`TA_ATR.c`](https://github.com/TA-Lib/ta-lib/blob/62021c1d14ef5499505af5547384cab509adf3fc/src/ta_func/ta_ATR.c).
TradingView's primary documentation confirms
[`ATR = ta.rma(ta.tr(true), 14)`](https://www.tradingview.com/support/solutions/43000734653-how-are-adr-and-atr-calculated/)
and describes MACD as two price EMAs plus an EMA signal in its
[`Pine primer`](https://www.tradingview.com/pine-script-docs/primer/first-indicator/).

## Verification matrix

| Quantity or rule                    | Independent reference                                                             | Tested convention                                                      | Tolerance                       | Result / limitation                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------- |
| RSI(14) seed and recurrence         | TA-Lib RSI source + Decimal generator + RSI(3) hand case                          | 14-change SMA seed; Wilder recurrence; flat=50                         | `1e-12` relative                | **A**                                                                   |
| MACD(12,26,9)                       | TA-Lib MACD source + TradingView docs + Decimal generator + MACD(2,3,2) hand case | Independent SMA seed per EMA; SMA-seeded signal                        | `1e-12` relative                | **A** internally; **B** vs both references; Pine exact parity is **C**  |
| ATR(14) and gaps                    | TA-Lib ATR source + TradingView ATR formula + two hand cases                      | first TR=`high-low`; index-13 SMA seed; Wilder recurrence              | `1e-12` relative                | **A** for declared/Pine convention; **B** vs TA-Lib index-14 convention |
| Warm-up                             | Formula-derived indices                                                           | RSI 14, MACD line 25, signal/histogram 33, ATR 13; composite needs 34  | exact                           | **A**                                                                   |
| Rising/falling/flat                 | Decimal fixtures                                                                  | one-sided RSI 100/0; flat RSI 50; flat MACD/ATR zero                   | `1e-12` relative                | **A**                                                                   |
| Irregular and tiny positive prices  | Decimal fixtures                                                                  | identical scale-sensitive recurrences                                  | `1e-12` relative, `1e-24` floor | **A**; IEEE-754 remains the runtime representation                      |
| Nonfinite OHLC                      | Explicit `NaN`/infinity tests                                                     | invalid terminal reading => insufficient                               | exact status                    | **A** for current behavior; status does not identify the invalid field  |
| Inconsistent ranges                 | Explicit `high<low` and open/close-outside-range tests                            | rejected by `binance-daily-v1`; no repair                              | exact status                    | **A** at ingestion; pure model remains unchanged                        |
| Regime precedence/boundaries        | Direct mathematical cases                                                         | inclusive 4%, +/-0.5%, RSI 30/70; precedence as listed                 | exact                           | **A**                                                                   |
| Component and final score           | Hand arithmetic                                                                   | piecewise/linear transforms; weights; final-only `Math.round`          | exact / 12 digits               | **A**                                                                   |
| Profile eligibility                 | Below/at/above direct cases                                                       | `>=60`, `>=71`, strict momentum `>50`, high-volatility exclusion       | exact                           | **A**                                                                   |
| Ranking and ties                    | Direct candidates                                                                 | score desc, ticker asc, original order final fallback                  | exact                           | **A**; locale behavior follows JS runtime locale                        |
| Caps and cash                       | 90/60-score hand case                                                             | independent per-asset cap; no redistribution                           | exact                           | **A**; 80% cash retained in the tested conservative case                |
| Duplicate/unordered/missing candles | Shared validator and boundary tests                                               | valid input sorts; duplicates/gaps reject; no synthesis                 | exact behavior                  | **A** under `binance-daily-v1`; legacy schema 1 remains reproducible     |

## Correction proposal and evidence impact

Do not change MACD initialization under `1.0.0`. A follow-up must choose and state one of two
contracts: port the TypeScript SMA-seeded recurrence into Pine explicitly, or adopt
TradingView's first-sample EMA in TypeScript. Either option can move histograms, regimes,
scores, eligibility, ranking, and allocation near the warm-up boundary; changing TypeScript
therefore requires a new canonical model version and matching Pine version. A fresh campaign
is required for the corrected version. Existing observations remain valid evidence of what
`1.0.0` actually decided and must not be relabeled or rewritten.

The follow-up [Pine parity assessment](PINE_PARITY_ASSESSMENT.md) takes the first option without
changing TypeScript: an isolated Pine candidate recomputes the score on the app's 200-candle
window, and on 2026-10-27 it matched every app decision at runtime. Runtime also showed that
TradingView's `ta.macd` already uses SMA seeds, so the second option would have created a
difference rather than removed one. It also shows that porting the seeds alone is not enough, because the app
re-seeds its rolling window daily while Pine keeps one continuous recurrence.
