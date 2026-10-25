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

Each run stores a SHA-256 `configurationId`, the closed input candle snapshot, and immutable per-decision JSON records under `.zerochart-evaluations/decisions/`. Contracts are kept per configuration under `.zerochart-evaluations/contracts/`. Re-running the same logical evaluation uses the existing file rather than creating a second record. Later model/configuration changes produce a different identifier and preserve older records.

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

To reproduce a selected decision, use its `logicalKey` from the replay/observation output:

```bash
npm run evaluate -- reproduce 1767225600000:BTC-USD:CONFIGURATION_ID --store .zerochart-evaluations
```

The report separates recorded coverage, eligible/rejected decisions, rejection reasons, and configuration attribution. Missing runs are explicitly reported as not determinable because this task does not install a production schedule. It deliberately reports performance metrics as unavailable.

## Synthetic demonstration

`docs/strategy-validation-fixture.json` is a clearly labeled synthetic fixture. Its candles are invented for deterministic replay and must not be interpreted as market history or prospective evidence.

## Evidence boundary and limitations

Verified by this lab:

- closed-candle and as-of filtering;
- deterministic replay of identical inputs;
- model, strategy, and configuration attribution;
- explicit stale, missing, insufficient-history, and no-eligible outcomes;
- duplicate-run idempotency at the logical decision key;
- isolation from trading mutation APIs.

Not verified:

- profitability, net return, drawdown, turnover, or trade count;
- automated exits or prospective forward observation;
- removal of provider-universe survivorship bias;
- complete historical coverage for every asset class;
- production database persistence or production scheduling.

The next smallest task for performance evidence is to specify and independently persist a complete executable entry/exit observation contract, including a defined untouched evaluation period and an appropriate asset-universe benchmark. That task should not be inferred from this decision-validation foundation.
