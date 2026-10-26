# Binance daily candle input contract

Policy identifier: `binance-daily-v1`

This policy covers the existing Binance Spot `1d` crypto path. It is an input contract, not a
model change: indicator formulas and canonical model version `1.0.0` remain unchanged.

## Provider semantics

Binance Spot klines are uniquely keyed by field 0, the open time. Timestamps are Unix epoch
milliseconds. With the API's default `timeZone=0`, a `1d` candle opens at `00:00:00.000Z`.
Field 6 is the provider close time. Binance's own response example establishes the inclusive
end convention: a daily close is `openTime + 86,399,999 ms`, or `23:59:59.999Z`, not the next
day's midnight. The implementation preserves this field instead of fabricating it. See the
[Binance Spot kline documentation](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/market#klinecandlestick-data).

## Policy categories

Safe normalization:

- Sort otherwise valid candles by open timestamp, oldest first.
- Select only candles whose documented close boundary is at or before evaluation time.
- Apply validation and the model to the most recent 200 closed candles, matching the provider
  request and the actual scoring window.

Invalid input (structured `DATA_INVALID`, never a score or ordinary eligibility rejection):

- a timestamp that is not a positive safe integer in epoch milliseconds or is not aligned to
  UTC midnight;
- a close time other than `openTime + 86,399,999 ms`;
- nonfinite or nonpositive available OHLC prices;
- `high < low`, or an available OPEN/CLOSE outside `[low, high]`;
- duplicate open timestamps, including byte-identical duplicates;
- any non-daily gap inside the model window.

Incomplete history:

- fewer than 34 valid closed candles is `INSUFFICIENT_HISTORY`;
- a missing daily interval inside an otherwise long model window is `DATA_INVALID` with
  `MISSING_DAILY_INTERVAL`; it is never interpolated or forward-filled;
- no price is inferred, and in particular a missing OPEN is never synthesized. Model-only
  fixtures may omit OPEN because the canonical formulas consume HLC, but provider parsing and
  outcome measurement require and preserve the provider OPEN.

Open/freshness handling:

- a not-yet-closed candle is excluded, not rejected and not supplied to the model;
- freshness is assessed after structural validation from the latest closed provider close
  time. A structurally valid but old series is `STALE_DATA`, not `DATA_INVALID`;
- older candles outside the 200-candle model window are retained in immutable input evidence
  but do not affect the score and do not invalidate the active window.

The validator never deduplicates, interpolates, forward-fills, repairs ranges, or substitutes
nearby outcome candles.

## Boundaries and evidence compatibility

The same pure validator gates browser scoring/portfolio proposals, schema-2 private
evaluations and observations, and exact reference/endpoint candles used by outcome
measurement. Application results use `DATA_INVALID`; private decisions use the same status
with structured issue codes in their explanation. These are data failures, not evidence that
an asset failed a score threshold.

New evaluation configurations include `candleValidation.policyVersion` and `modelWindow`, so
their configuration hash differs from pre-policy evidence. New runs use evaluation schema 2.
Stored schema-1 runs without a policy continue to reproduce through the legacy evaluator and
are never upgraded or rewritten. Unsupported historical contracts fail explicitly.

The existing `private-2026q4-001` campaign is frozen to the unversioned legacy contract. The
current runner refuses to append new observations to it. The owner may still report and
reproduce its saved observations. To collect evidence under this policy, the owner must
deliberately initialize a new campaign ID and future date range, for example:

```bash
npm run evaluate -- campaign-init private-2026q4-002 \
  --start 2026-10-27T06:30:00.000Z \
  --end 2026-11-25T06:30:00.000Z
```

No campaign is initialized or activated by this change.
