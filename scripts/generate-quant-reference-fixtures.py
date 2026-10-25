#!/usr/bin/env python3
"""Generate independent numerical fixtures for the canonical quant model.

This development-only script intentionally does not import ZeroChart code. It
uses Decimal arithmetic and the mathematical recurrence described in the
fixture metadata. Run from the repository root:

    python3 scripts/generate-quant-reference-fixtures.py
"""

from __future__ import annotations

from decimal import Decimal, getcontext
import json
from pathlib import Path

getcontext().prec = 50

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "quant-reference-fixtures.json"


def d(value: int | float | str) -> Decimal:
    return Decimal(str(value))


def wilder_rsi(closes: list[Decimal], period: int = 14) -> list[Decimal | None]:
    result: list[Decimal | None] = [None] * len(closes)
    if len(closes) <= period:
        return result
    changes = [closes[index] - closes[index - 1] for index in range(1, period + 1)]
    average_gain = sum((max(change, d(0)) for change in changes), d(0)) / d(period)
    average_loss = sum((max(-change, d(0)) for change in changes), d(0)) / d(period)

    def value(gain: Decimal, loss: Decimal) -> Decimal:
        if loss == 0:
            return d(50) if gain == 0 else d(100)
        if gain == 0:
            return d(0)
        return d(100) - d(100) / (d(1) + gain / loss)

    result[period] = value(average_gain, average_loss)
    for index in range(period + 1, len(closes)):
        change = closes[index] - closes[index - 1]
        average_gain = (average_gain * d(period - 1) + max(change, d(0))) / d(period)
        average_loss = (average_loss * d(period - 1) + max(-change, d(0))) / d(period)
        result[index] = value(average_gain, average_loss)
    return result


def sma_seeded_ema(values: list[Decimal], period: int) -> list[Decimal | None]:
    result: list[Decimal | None] = [None] * len(values)
    if len(values) < period:
        return result
    previous = sum(values[:period], d(0)) / d(period)
    result[period - 1] = previous
    alpha = d(2) / d(period + 1)
    for index in range(period, len(values)):
        previous = previous + alpha * (values[index] - previous)
        result[index] = previous
    return result


def sma_seeded_macd(
    closes: list[Decimal], fast: int = 12, slow: int = 26, signal_period: int = 9
) -> tuple[list[Decimal | None], list[Decimal | None], list[Decimal | None]]:
    fast_ema = sma_seeded_ema(closes, fast)
    slow_ema = sma_seeded_ema(closes, slow)
    line: list[Decimal | None] = [None] * len(closes)
    start = max(fast, slow) - 1
    for index in range(start, len(closes)):
        assert fast_ema[index] is not None and slow_ema[index] is not None
        line[index] = fast_ema[index] - slow_ema[index]

    signal: list[Decimal | None] = [None] * len(closes)
    histogram: list[Decimal | None] = [None] * len(closes)
    signal_start = start + signal_period - 1
    if signal_start >= len(closes):
        return line, signal, histogram
    seed_values = line[start : signal_start + 1]
    assert all(value is not None for value in seed_values)
    previous = sum((value for value in seed_values if value is not None), d(0)) / d(signal_period)
    signal[signal_start] = previous
    alpha = d(2) / d(signal_period + 1)
    for index in range(signal_start + 1, len(closes)):
        assert line[index] is not None
        previous = previous + alpha * (line[index] - previous)
        signal[index] = previous
    for index in range(signal_start, len(closes)):
        assert line[index] is not None and signal[index] is not None
        histogram[index] = line[index] - signal[index]
    return line, signal, histogram


def first_bar_range_atr(
    highs: list[Decimal], lows: list[Decimal], closes: list[Decimal], period: int = 14
) -> list[Decimal | None]:
    result: list[Decimal | None] = [None] * len(closes)
    if len(closes) < period:
        return result
    true_ranges = [highs[0] - lows[0]]
    true_ranges.extend(
        max(
            highs[index] - lows[index],
            abs(highs[index] - closes[index - 1]),
            abs(lows[index] - closes[index - 1]),
        )
        for index in range(1, len(closes))
    )
    previous = sum(true_ranges[:period], d(0)) / d(period)
    result[period - 1] = previous
    for index in range(period, len(closes)):
        previous = (previous * d(period - 1) + true_ranges[index]) / d(period)
        result[index] = previous
    return result


def candle_series(closes: list[Decimal], half_ranges: list[Decimal]) -> dict[str, list[float]]:
    return {
        "highs": [float(close + half_range) for close, half_range in zip(closes, half_ranges)],
        "lows": [float(close - half_range) for close, half_range in zip(closes, half_ranges)],
        "closes": [float(close) for close in closes],
    }


def reference_case(name: str, closes: list[Decimal], half_ranges: list[Decimal]) -> dict[str, object]:
    candles = candle_series(closes, half_ranges)
    highs = [d(value) for value in candles["highs"]]
    lows = [d(value) for value in candles["lows"]]
    normalized_closes = [d(value) for value in candles["closes"]]
    rsi_values = wilder_rsi(normalized_closes)
    macd_line, signal, histogram = sma_seeded_macd(normalized_closes)
    atr_values = first_bar_range_atr(highs, lows, normalized_closes)
    last = len(closes) - 1
    return {
        "name": name,
        **candles,
        "expected": {
            "firstRsiIndex": 14,
            "firstMacdIndex": 25,
            "firstSignalIndex": 33,
            "firstHistogramIndex": 33,
            "firstAtrIndex": 13,
            "last": {
                "rsi": float(rsi_values[last]) if rsi_values[last] is not None else None,
                "macd": float(macd_line[last]) if macd_line[last] is not None else None,
                "signal": float(signal[last]) if signal[last] is not None else None,
                "histogram": float(histogram[last]) if histogram[last] is not None else None,
                "atr": float(atr_values[last]) if atr_values[last] is not None else None,
            },
        },
    }


def main() -> None:
    irregular_values = [
        100, 101, 99, 102, 104, 103, 107, 106, 108, 105,
        109, 111, 110, 114, 112, 113, 117, 115, 119, 118,
        121, 120, 124, 123, 122, 126, 128, 125, 129, 131,
        130, 134, 132, 136, 135, 138, 137, 141, 139, 143,
    ]
    irregular = [d(value) for value in irregular_values]
    irregular_ranges = [d((index % 5) + 1) / d(4) for index in range(len(irregular))]
    tiny_scale = d("0.00000001")
    cases = [
        reference_case("rising", [d(index) for index in range(1, 41)], [d("0.25")] * 40),
        reference_case("falling", [d(index) for index in range(40, 0, -1)], [d("0.25")] * 40),
        reference_case("flat", [d(5)] * 40, [d(0)] * 40),
        reference_case("irregular", irregular, irregular_ranges),
        reference_case(
            "very-small-positive",
            [value * tiny_scale for value in irregular],
            [value * tiny_scale for value in irregular_ranges],
        ),
    ]
    payload = {
        "schemaVersion": 1,
        "generatedBy": "python3 scripts/generate-quant-reference-fixtures.py",
        "provenance": {
            "generator": "Python standard library Decimal arithmetic; no ZeroChart imports",
            "referenceSource": "TA-Lib main at 62021c1d14ef5499505af5547384cab509adf3fc",
            "referenceUrls": [
                "https://github.com/TA-Lib/ta-lib/blob/62021c1d14ef5499505af5547384cab509adf3fc/src/ta_func/ta_RSI.c",
                "https://github.com/TA-Lib/ta-lib/blob/62021c1d14ef5499505af5547384cab509adf3fc/ta_codegen/input/macd/macd.c",
                "https://github.com/TA-Lib/ta-lib/blob/62021c1d14ef5499505af5547384cab509adf3fc/src/ta_func/ta_ATR.c"
            ],
            "conventions": {
                "rsi": "Wilder: period-change SMA seed, then alpha=1/period recurrence; 50 when gains and losses are both zero",
                "macd": "ZeroChart convention: independently SMA-seed each price EMA and the signal EMA; alpha=2/(period+1). TA-Lib composite MACD aligns the fast seed window to the slow seed window",
                "atr": "Pine-compatible first TR=high-low, period-TR SMA seed, then Wilder recurrence; differs from TA-Lib ATR, which requires a prior close and first publishes at index period"
            },
            "tolerances": {
                "relative": 1e-12,
                "absoluteFloor": 1e-24
            }
        },
        "cases": cases,
        "handExamples": {
            "rsiPeriod3": {
                "closes": [1, 3, 2, 4, 5],
                "expected": [None, None, None, 80, 84.61538461538461]
            },
            "macd2_3_2": {
                "closes": [1, 2, 4, 8, 16, 32, 64, 128],
                "last": {
                    "macd": 17.076946159122084,
                    "signal": 13.67183927729567,
                    "histogram": 3.405106881826414
                }
            },
            "atrPeriod2": {
                "highs": [10, 12, 13],
                "lows": [8, 9, 11],
                "closes": [9, 11, 12],
                "trueRanges": [2, 3, 2],
                "expected": [None, 2.5, 2.25]
            },
            "gapAtrPeriod2": {
                "highs": [10, 20],
                "lows": [9, 19],
                "closes": [10, 19.5],
                "trueRanges": [1, 10],
                "expected": [None, 5.5]
            }
        }
    }
    OUTPUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
