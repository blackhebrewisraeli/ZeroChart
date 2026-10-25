# Private prospective observation campaign: sanitized status

Campaign `private-2026q4-001` was initialized locally at `2026-10-25T06:21:33.217Z` from repository commit `196ce8d873cad0630a40170ce4b8733a3a16eb42`. Its 30 daily slots run from `2026-10-25T06:30:00.000Z` through `2026-11-23T06:30:00.000Z`. Raw manifests, attempts, candle snapshots, and reproduction records remain in the ignored `.zerochart-campaigns/` store and are not committed.

## First slot

- Scheduled slot: `2026-10-25T06:30:00.000Z`
- Fetch started: `2026-10-25T06:30:11.415Z`
- Observation recorded: `2026-10-25T06:30:11.982Z`
- Candle as-of: `2026-10-25T00:00:00.000Z` for all five assets
- Expected/completed/failed/missed: `1 / 1 / 0 / 0`
- Retry attempts: `0`
- Data coverage: `5 / 5` configured Binance assets; no unavailable, failed, stale, or insufficient-history result
- Eligible/selected/qualified-not-selected/rejected: `0 / 0 / 0 / 5`
- Rejection reasons: `BELOW_MINIMUM_SCORE: 5`; every other rejection reason: `0`
- Offline reproduction: `MATCH`, with `fetch` explicitly blocked

The run used strategy `canonical-portfolio-v1`, model `1.0.0`, configuration `db4caa3589a19b7f31f30b93951e6be8a648fd19157dd10a7dc005c77af5b984`, the unchanged moderate profile, and the fixed `BTC-USD`, `ETH-USD`, `SOL-USD`, `ADA-USD`, and `XRP-USD` universe. Zero qualifying assets is a valid observation and was not retried or altered.

This is one prospective observation, not multi-day evidence. Decision consistency over time, provider reliability over time, missed-slot behavior in live operation, and retry behavior after a real provider failure are not yet measurable. Profitability, returns, win rate, drawdown, turnover, and trade count are not measurable because there is no complete executable entry/exit strategy contract. No trade, alert, production database mutation, deployment, scheduler, or external recruitment occurred.

## Owner commands

Run the currently due slot manually after `06:30Z`:

```bash
npm run evaluate -- campaign-run private-2026q4-001
```

Use the same command to retry a failed current slot. It preserves the failed attempt and will not duplicate a successful slot.

```bash
npm run evaluate -- campaign-report private-2026q4-001
npm run evaluate -- campaign-reproduce private-2026q4-001 --block-network
```

No scheduler is installed. Collection stops unless the owner invokes the runner for each daily slot.
