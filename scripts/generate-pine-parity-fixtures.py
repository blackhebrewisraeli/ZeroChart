#!/usr/bin/env python3
"""Generate TypeScript-versus-Pine parity fixtures and the discrepancy matrix.

Development-only and independent of ZeroChart's TypeScript: Decimal arithmetic,
reusing the reference recurrences in generate-quant-reference-fixtures.py. Every
bar of every case is scored under three models:

  app             The ZeroChart contract canonicalModel.ts must meet: the last
                  min(200, n) closed candles, SMA-seeded EMAs, 34-candle minimum.
  pineDocumented  Hypothesis H1 for the current Pine HUD, from TradingView's
                  documentation: first-sample ta.ema, SMA-seeded ta.rma, history
                  from the chart's first bar, RSI 100 when the average loss is 0,
                  ready once RSI/MACD/ATR are all non-na. It is a model of the
                  documentation, not evidence of what the Pine runtime does.
  customInit      ZeroChart's seeds on continuous history from bar 0: what a Pine
                  port of the initialization alone, without the window, computes.

Inputs are exact binary floats; models read them with Decimal(float), not str.
Run from the repository root:

    python3 scripts/generate-pine-parity-fixtures.py
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "pine-parity-fixtures.json"
SNAPSHOT = ROOT / "docs" / "pine-parity-btcusdt-1d.json"

_spec = importlib.util.spec_from_file_location(
    "quant_reference", Path(__file__).with_name("generate-quant-reference-fixtures.py")
)
assert _spec is not None and _spec.loader is not None
ref = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ref)

D = Decimal
WINDOW = 200
MIN_CANDLES = 34
ZERO, HUNDRED = D(0), D(100)
RSI_POINTS = [(D(0), D(100)), (D(30), D(95)), (D(50), D(55)), (D(70), D(15)), (D(100), D(0))]
WEIGHTS = {
    "N": (D("0.4"), D("0.4"), D("0.2")),
    "T": (D("0.3"), D("0.5"), D("0.2")),
    "M": (D("0.5"), D("0.3"), D("0.2")),
    "H": (D("0.35"), D("0.35"), D("0.3")),
}


def rsi_series(closes: list[Decimal], flat: Decimal, period: int = 14) -> list[Decimal | None]:
    """Wilder RSI; `flat` is returned when both averages are zero (app 50, H1 100)."""
    result: list[Decimal | None] = [None] * len(closes)
    if len(closes) <= period:
        return result
    changes = [closes[i] - closes[i - 1] for i in range(1, period + 1)]
    gain = sum((max(c, ZERO) for c in changes), ZERO) / period
    loss = sum((max(-c, ZERO) for c in changes), ZERO) / period

    def value(g: Decimal, l: Decimal) -> Decimal:
        if l == 0:
            return flat if g == 0 else HUNDRED
        if g == 0:
            return ZERO
        return HUNDRED - HUNDRED / (1 + g / l)

    result[period] = value(gain, loss)
    for i in range(period + 1, len(closes)):
        change = closes[i] - closes[i - 1]
        gain = (gain * (period - 1) + max(change, ZERO)) / period
        loss = (loss * (period - 1) + max(-change, ZERO)) / period
        result[i] = value(gain, loss)
    return result


def first_sample_ema(values: list[Decimal | None], period: int) -> list[Decimal | None]:
    """TradingView-documented ta.ema: seeded by the first non-na sample."""
    result: list[Decimal | None] = [None] * len(values)
    alpha = D(2) / D(period + 1)
    previous: Decimal | None = None
    for i, value in enumerate(values):
        if value is None:
            continue
        previous = value if previous is None else alpha * value + (1 - alpha) * previous
        result[i] = previous
    return result


def app_indicators(highs, lows, closes):
    _, _, histogram = ref.sma_seeded_macd(closes)
    return (
        rsi_series(closes, D(50)),
        histogram,
        ref.first_bar_range_atr(highs, lows, closes),
    )


def pine_documented_indicators(highs, lows, closes):
    fast = first_sample_ema(closes, 12)
    slow = first_sample_ema(closes, 26)
    line = [f - s for f, s in zip(fast, slow)]
    signal = first_sample_ema(line, 9)
    return (
        rsi_series(closes, HUNDRED),
        [l - s for l, s in zip(line, signal)],
        ref.first_bar_range_atr(highs, lows, closes),
    )


def clamp(value: Decimal, low: Decimal, high: Decimal) -> Decimal:
    return max(low, min(high, value))


def rsi_factor(rsi: Decimal) -> Decimal:
    x = clamp(rsi, ZERO, HUNDRED)
    for (x0, y0), (x1, y1) in zip(RSI_POINTS, RSI_POINTS[1:]):
        if x <= x1:
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return ZERO


def momentum_class(momentum: Decimal) -> str:
    """Pine's bullish threshold (FLAT_MOMENTUM) and the aggressive profile's strict > 0 gate."""
    if momentum >= D("0.0005"):
        return "B"
    if momentum > 0:
        return "P"
    return "N"


def reading(rsi: Decimal, histogram: Decimal, atr: Decimal, close: Decimal) -> dict:
    momentum = histogram / close
    volatility = atr / close
    components = (
        rsi_factor(rsi),
        clamp(50 + 50 * (momentum / D("0.01")), ZERO, HUNDRED),
        clamp(100 * (1 - (volatility - D("0.005")) / D("0.05")), ZERO, HUNDRED),
    )
    if volatility >= D("0.04"):
        regime = "H"
    elif abs(momentum) >= D("0.005"):
        regime = "T"
    elif rsi <= 30 or rsi >= 70:
        regime = "M"
    else:
        regime = "N"
    weights = WEIGHTS[regime]
    weighted = clamp(sum(w * c for w, c in zip(weights, components)) / sum(weights), ZERO, HUNDRED)
    return {
        "rsi": rsi,
        "histogram": histogram,
        "atr": atr,
        "momentum": momentum,
        "volatility": volatility,
        "components": components,
        "weighted": weighted,
        "score": int(weighted.to_integral_value(rounding=ROUND_HALF_UP)),
        "regime": regime,
        "momentumClass": momentum_class(momentum),
    }


def last_reading(indicators, closes, index: int) -> dict | None:
    values = [series[index] for series in indicators]
    if any(value is None for value in values) or closes[index] <= 0:
        return None
    return reading(*values, closes[index])


def evaluate_case(candles: list[tuple[float, float, float]], bars: range) -> dict[str, list]:
    highs = [D(h) for h, _, _ in candles]
    lows = [D(l) for _, l, _ in candles]
    closes = [D(c) for _, _, c in candles]
    pine = pine_documented_indicators(highs, lows, closes)
    custom = app_indicators(highs, lows, closes)
    models: dict[str, list] = {"app": [], "pineDocumented": [], "customInit": []}
    for t in bars:
        start = max(0, t - WINDOW + 1)
        window = (highs[start : t + 1], lows[start : t + 1], closes[start : t + 1])
        app = None
        if t + 1 - start >= MIN_CANDLES:
            app = last_reading(app_indicators(*window), window[2], -1)
        models["app"].append(app)
        models["pineDocumented"].append(last_reading(pine, closes, t))
        models["customInit"].append(last_reading(custom, closes, t) if t >= MIN_CANDLES - 1 else None)
    return models


def decisions(r: dict | None) -> tuple[bool, ...]:
    """Eligibility (conservative, moderate, aggressive) and Pine setups (long, risk, high conviction)."""
    if r is None:
        return (False,) * 6
    s, regime, m = r["score"], r["regime"], r["momentumClass"]
    return (
        s >= 60 and regime != "H",
        s >= 60,
        s >= 71 and m != "N",
        s >= 78 and m == "B",
        s <= 28 or regime == "H",
        s >= 80,
    )


def compact(r: dict | None) -> str | None:
    return None if r is None else f"{r['score']}{r['regime']}{r['momentumClass']}"


def number(value: Decimal | None) -> float | None:
    return None if value is None else float(value)


def transitions(series: list, i: int) -> tuple[bool, bool]:
    """Whether Pine's longSignal and riskSignal fire on evaluated bar i."""
    now = decisions(series[i])
    before = decisions(series[i - 1]) if i > 0 else (False,) * 6
    return (now[3] and not before[3], now[4] and not before[4])


def max_abs_differences(app: list, other: list, both: list[int]) -> dict | None:
    if not both:
        return None

    def biggest(pick) -> float:
        return float(max(abs(pick(other[i]) - pick(app[i])) for i in both))

    return {
        "rsi": biggest(lambda r: r["rsi"]),
        "momentum": biggest(lambda r: r["momentum"]),
        "volatility": biggest(lambda r: r["volatility"]),
        "component": max(biggest(lambda r, k=k: r["components"][k]) for k in range(3)),
        "weighted": biggest(lambda r: r["weighted"]),
    }


def classify(row: dict) -> str:
    if sum(row[k] for k in row if k.endswith("Mismatches")):
        return "DECISION_CHANGED"
    if row["maxAbs"] is None or not any(row["maxAbs"].values()):
        return "EXACT"
    return "NUMERICAL_ONLY"


def summarize(app: list, other: list, first_bar: int, segments) -> list[dict]:
    rows = []
    for segment, low, high in segments:
        indices = [i for i in range(len(app)) if low <= first_bar + i <= high]
        if not indices:
            continue
        both = [i for i in indices if app[i] is not None and other[i] is not None]
        row = {
            "segment": segment,
            "bars": [first_bar + indices[0], first_bar + indices[-1]],
            "compared": len(both),
            "readinessMismatches": sum((app[i] is None) != (other[i] is None) for i in indices),
            "maxAbs": max_abs_differences(app, other, both),
            "regimeMismatches": sum(app[i]["regime"] != other[i]["regime"] for i in both),
            "scoreMismatches": sum(app[i]["score"] != other[i]["score"] for i in both),
            "decisionMismatches": sum(decisions(app[i]) != decisions(other[i]) for i in indices),
            "transitionMismatches": sum(transitions(app, i) != transitions(other, i) for i in indices),
        }
        row["classification"] = classify(row)
        rows.append(row)
    return rows


def key_point(models: dict, i: int) -> dict:
    return {
        name: None
        if series[i] is None
        else {
            key: number(series[i][key])
            for key in ("rsi", "histogram", "atr", "momentum", "volatility", "weighted")
        }
        | {"score": series[i]["score"], "regime": series[i]["regime"]}
        for name, series in models.items()
    }


def straight(length: int, start: float, step: float, half: float) -> list[tuple[float, float, float]]:
    return [(start + step * i + half, start + step * i - half, start + step * i) for i in range(length)]


def lcg_walk(length: int, high_volatility: range = range(0)) -> list[tuple[float, float, float]]:
    """Integer quarter-tick random walk; mirrored bar for bar by the Pine harness."""
    state, ticks, candles = 1, 8000, []
    for i in range(length):
        if i > 0:
            state = (75 * state + 74) % 65537
            ticks += ((state % 257) - 128) * (6 if i in high_volatility else 1)
        half = 1 + state % 16
        candles.append(((ticks + half) / 4, (ticks - half) / 4, ticks / 4))
    assert all(low > 0 for _, low, _ in candles)
    return candles


def threshold_case() -> tuple[list[tuple[float, float, float]], float]:
    """Bar 260's close sits where the app rounds to 60 but continuous history rounds to 59, or vice versa."""
    base = lcg_walk(261)
    last = len(base) - 1

    def evaluate(close: Decimal, model: str) -> dict:
        value = float(close)
        candles = base[:last] + [(value + 0.25, value - 0.25, value)]
        return evaluate_case(candles, range(last, last + 1))[model][0]

    def weighted(close: Decimal, model: str) -> Decimal:
        return evaluate(close, model)["weighted"] - D("59.5")

    def root(model: str, low: Decimal, high: Decimal) -> Decimal:
        for _ in range(90):
            middle = (low + high) / 2
            if (weighted(middle, model) > 0) == (weighted(low, model) > 0):
                low = middle
            else:
                high = middle
        return (low + high) / 2

    # Regime switches make the score discontinuous in the close; take the first
    # 59.5 crossing whose bracket stays in one regime.
    close = D(base[last][2])
    grid = [close * (D("0.9") + D("0.0025") * k) for k in range(121)]
    low, high = next(
        (a, b)
        for a, b in zip(grid, grid[1:])
        if (weighted(a, "app") > 0) != (weighted(b, "app") > 0)
        and evaluate(a, "app")["regime"] == evaluate(b, "app")["regime"]
    )
    middle = (root("app", low, high) + root("customInit", low, high)) / 2
    value = float(middle)
    assert (weighted(D(value), "app") > 0) != (weighted(D(value), "customInit") > 0)
    return base[:last] + [(value + 0.25, value - 0.25, value)], value


def main() -> None:
    synthetic = {
        "rising": straight(320, 100.0, 0.5, 0.25),
        "falling": straight(320, 300.0, -0.5, 0.25),
        "flat": straight(320, 100.0, 0.0, 0.0),
        "irregular": lcg_walk(320, range(150, 200)),
    }
    threshold, threshold_close = threshold_case()
    synthetic["threshold"] = threshold
    segments = [
        ("warm-up", 0, MIN_CANDLES - 2),
        ("shared-history", MIN_CANDLES - 1, WINDOW - 1),
        ("rolling-window", WINDOW, 10**9),
    ]

    snapshot = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    rows = snapshot["rows"]
    real = [(float(r[2]), float(r[3]), float(r[4])) for r in rows]
    real_bars = range(len(real) - 365, len(real))

    cases, matrix = [], []
    for name, candles, bars in [
        *[(name, candles, range(len(candles))) for name, candles in synthetic.items()],
        ("btcusdt-1d", real, real_bars),
    ]:
        models = evaluate_case(candles, bars)
        for other in ("pineDocumented", "customInit"):
            for row in summarize(models["app"], models[other], bars.start, segments):
                matrix.append({"case": name, "comparison": f"{other}-vs-app", **row})
        last = len(candles) - 1
        points = sorted({p for p in (33, 99, 199, 200, last) if p in bars})
        case = {
            "name": name,
            "evaluatedBars": [bars.start, bars.stop - 1],
            "perBar": {model: [compact(r) for r in series] for model, series in models.items()},
            "keyPoints": {str(p): key_point(models, p - bars.start) for p in points},
        }
        if name == "btcusdt-1d":
            case["source"] = "docs/pine-parity-btcusdt-1d.json"
        else:
            case["candles"] = {
                "highs": [h for h, _, _ in candles],
                "lows": [l for _, l, _ in candles],
                "closes": [c for _, _, c in candles],
            }
        cases.append(case)

    payload = {
        "schemaVersion": 1,
        "generatedBy": "python3 scripts/generate-pine-parity-fixtures.py",
        "provenance": {
            "generator": "Python standard library Decimal arithmetic; no ZeroChart TypeScript imports",
            "models": {
                "app": "ZeroChart contract: last min(200, n) candles, SMA-seeded EMAs, RSI 50 when flat, 34-candle minimum",
                "pineDocumented": "Hypothesis H1 from TradingView documentation, unverified against the Pine runtime: first-sample ta.ema, SMA-seeded ta.rma, ta.tr(true), continuous history from bar 0, RSI 100 when the average loss is 0, ready when RSI/MACD/ATR are non-na",
                "customInit": "ZeroChart seeds on continuous history from bar 0, without the rolling window",
            },
            "compact": "score + regime (N/T/M/H) + momentum class (B >= 0.0005, P > 0, N otherwise); null when not ready",
            "thresholdClose": threshold_close,
            "realDataNote": "pineDocumented and customInit start at the snapshot's first bar, 735 bars before the first evaluated bar, not at the 2017 listing",
            "tolerances": {"relative": 1e-12, "absoluteFloor": 1e-24},
        },
        "cases": cases,
        "matrix": matrix,
    }
    OUTPUT.write_text(json.dumps(payload, indent=1) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
