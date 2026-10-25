# Private strategy-validation lab

ZeroChart now has a browser-independent validation layer for the current implementation. It validates operational and decision behavior; it does **not** claim that the strategy is profitable or ready for paid use.

## Actual contract

| Area                | Current implementation                                                                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Universe and source | Crypto tickers supported by Binance REST klines; equity/forex quote feeds exist, but canonical portfolio scoring has no historical candle source for them.                         |
| Timeframe           | Closed daily (`1d`) OHLC candles, oldest first.                                                                                                                                    |
| Model               | Canonical model `1.0.0`: Wilder RSI(14), MACD(12,26,9) histogram, and Wilder ATR(14), with regime-tilted 40/40/20 base weights. At least 34 valid candles are required.            |
| Eligibility         | Conservative: score >=60, no high volatility, max 8, max 10% each. Moderate: score >=60, max 5, max 25% each. Aggressive: score >=71, positive momentum, max 3, max 50% each.      |
| Allocation          | Eligible assets are ranked by score and allocated proportionally, capped by the selected profile. The lab records a proposal, not a BUY.                                           |
| Timing              | The lab uses only candles whose close time is at or before evaluation time; the proposal is attributed to the next observation after that closed candle.                           |
| Costs               | The paper execution contract charges 25 bps and enforces a quote age of at most 2 hours. The lab records 25 bps as an assumption but does not simulate fills.                      |
| Exits               | Paper Trading has no automated stop orders. ATR stops are planned sizing assumptions. TradingView can emit a SELL signal, but that is not a server-side exit.                      |
| Benchmark           | Not applicable for this lab because the current executable exit/observation contract is incomplete. No retrospective score-following return is presented as portfolio performance. |

Each run stores one immutable JSON snapshot containing every normalized asset input, closed-candle data, configuration contract, input SHA-256 hash, decisions, eligibility/selection outcomes, and allocations under `.zerochart-evaluations/runs/`. Contracts are kept per configuration under `.zerochart-evaluations/contracts/`. Re-running the same logical evaluation accepts identical content and rejects conflicting content rather than overwriting it. Temporary artifacts and malformed or contract-mismatched runs are treated as incomplete. Later model/configuration changes produce a different identifier and preserve older records.

## Commands

Fixture replay is deterministic and never calls the network:

```bash
npm run evaluate -- replay docs/strategy-validation-fixture.json --store .zerochart-evaluations
```

Read-only observation uses the existing Binance REST historical-candle path. It does not call booking RPCs and does not mutate cash, positions, fills, alerts, or production schedules:

```bash
npm run evaluate -- observe BTC-USD,ETH-USD --risk-profile moderate --store .zerochart-evaluations
```

The minimal private report is:

```bash
npm run evaluate -- report --store .zerochart-evaluations
```

To reproduce a complete saved portfolio decision, use its `runKey` from the replay/observation output:

```bash
npm run evaluate -- reproduce 1767225600000:CONFIGURATION_ID --store .zerochart-evaluations
```

Reproduction loads only the saved run and contract. It recalculates with the supported strategy/model implementation, verifies the input hash, compares decisions, coverage, observation period, and allocations, and prints `MATCH` or `MISMATCH`. A mismatch or unsupported historical version exits nonzero; reproduction never fetches network data.

The report groups coverage by strategy version, model version, configuration hash, and observation period. It includes eligible/selected/rejected counts and rejection-reason totals. Missing runs are explicitly reported as not determinable because this task does not install a production schedule. It deliberately reports performance metrics as unavailable.

## Private prospective campaign runbook

Campaign observations use a separate ignored store, `.zerochart-campaigns/`, so live evidence cannot mix with synthetic fixture replays. The manifest freezes the canonical strategy/model/configuration IDs, the existing moderate thresholds, the five-asset Binance universe (`BTC-USD`, `ETH-USD`, `SOL-USD`, `ADA-USD`, `XRP-USD`), daily candles, a 48-hour freshness limit, and a daily `06:30:00Z` slot. That slot is 390 minutes after the Binance daily candle closes at `00:00:00Z`; the deliberately generous buffer also makes the manual collection time practical for the owner.

Loading a campaign revalidates the repository SHA shape, daily UTC schedule, close buffer, missing-data policy, and complete configuration hash. A changed manifest is rejected instead of being silently treated as evidence from the frozen campaign.

Initialize the first 30-slot campaign once, from the exact commit that will run it:

```bash
npm run evaluate -- campaign-init private-2026q4-001 \
  --start 2026-10-25T06:30:00.000Z \
  --end 2026-11-23T06:30:00.000Z
```

Run the currently due slot manually:

```bash
npm run evaluate -- campaign-run private-2026q4-001
```

If that command records `FAILED`, run the same command again. Each failed attempt remains in the campaign, and a retry targets the same current slot. Once the slot is complete, the same command returns the saved attempt without fetching or writing another success.

Report schedule and decision evidence:

```bash
npm run evaluate -- campaign-report private-2026q4-001
```

Reproduce the latest completed run from saved inputs while explicitly blocking `fetch`:

```bash
npm run evaluate -- campaign-reproduce private-2026q4-001 --block-network
```

The manifest's missing-data policy fails a slot if any asset fetch fails or supplies unavailable, stale, or insufficient history. It never substitutes synthetic candles. A complete run with zero eligible or selected assets is valid and must not be retried merely to obtain eligibility. The report counts a prior unattempted slot as missed after the next slot becomes due; it never backfills or labels replay as prospective evidence.

No scheduler is installed. Evidence collection only continues when the owner invokes `campaign-run` after each slot. A local scheduler may later invoke that exact command shortly after `06:30Z`, but it should be configured separately and must retain the same manifest and store.

## Synthetic demonstration

`docs/strategy-validation-fixture.json` is a clearly labeled synthetic fixture. Its candles are invented for deterministic replay and must not be interpreted as market history or prospective evidence.

## Evidence boundary and limitations

Verified by this lab:

- closed-candle and as-of filtering;
- deterministic replay of identical inputs;
- model, strategy, and configuration attribution;
- explicit stale, missing, insufficient-history, and no-eligible outcomes;
- duplicate-run idempotency at the complete run key;
- complete multi-asset snapshots and score-based selection limits;
- offline recalculation with input-integrity and output comparisons;
- conflict detection for concurrent retries and incomplete temporary artifacts;
- isolation from trading mutation APIs.
- one live, read-only Binance observation followed by offline `MATCH` reproduction.

Not verified:

- profitability, net return, drawdown, turnover, or trade count;
- automated exits or enough prospective forward observations to assess consistency over time;
- removal of provider-universe survivorship bias;
- complete historical coverage for every asset class;
- production database persistence or production scheduling.
- atomicity across a process crash between contract and run publication; the loader detects missing or mismatched artifacts, but this remains a filesystem-level store rather than a transactional database.

The next smallest task for performance evidence is to specify and independently persist a complete executable entry/exit observation contract, including a defined untouched evaluation period and an appropriate asset-universe benchmark. That task should not be inferred from this decision-validation foundation.
