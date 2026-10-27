# TradingView event identity contract

Contract version: `tradingview-logical-event-v1`.

Database migration: `20261027130000_tradingview_logical_event_identity.sql`

## Three identities

- A **provider delivery attempt** is the webhook payload's `event_id`. TradingView may deliver the same logical event again with the same or a different attempt ID after an uncertain response.
- A **modern logical event** is identified by the saved owner, `signal_kind`, exchange, instrument, normalized timeframe, model implementation, action and bar open time. Exchange and instrument are case-normalized. `D` and `1D` are the same timeframe; other TradingView timeframe strings remain distinct.
- An **execution** is identified by the saved signal UUID. `paper_transactions.signal_id` remains unique, so retrying or racing execution of one saved signal cannot create a second fill.

The webhook parser already supplies every logical-key field from the existing Pine payload. Pine and existing TradingView alert snapshots do not change.

## Modern delivery behavior

A modern delivery has non-null `exchange`, `timeframe`, `bar_time` and `model_version` metadata.

- Repeated identical content for one logical event returns `duplicate`, including a retry with a different provider `event_id`.
- Hourly and daily events at the same close remain separate because their normalized timeframes differ.
- Different model implementations and BUY/SELL actions remain separate. Ingestion identity does not decide whether either signal should be executed.
- A second delivery for the same logical event with different score, price, quantity or stop returns HTTP 409. The saved row is not changed.
- The owner is part of both modern and legacy keys. One user's event cannot deduplicate another user's event.

## Legacy compatibility

A delivery missing any modern source field keeps the historical `(user_id, ticker, action, event_id)` identity. Existing rows, UUIDs, event IDs and statuses are not backfilled, relabeled or deduplicated. Incomplete rows remain non-executable under the existing strategy-provenance check; accepting them for legacy ingestion does not verify them as modern events.

## Release and rollback

Apply the append-only migration before deploying the updated `tv-webhook` handler. The old handler understands the migration's normal `accepted` and `duplicate` results, while the new handler is needed to expose a conflicting modern retry as HTTP 409. No frontend or Pine release is required.

Database rollback is forward-only. Do not drop or rewrite signal rows. Reinstating the old global event-ID index can fail after distinct cross-timeframe rows share an attempt ID, so rollback should use a follow-up migration that restores compatible function behavior while retaining both new indexes and all evidence. Production migration application and live alert behavior are not verified by repository tests.
