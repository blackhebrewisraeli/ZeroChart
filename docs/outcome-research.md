# Prospective signal-outcome research

The frozen machine-readable convention is `docs/outcome-measurement.v1.json`. Its identifier is the SHA-256 of the canonical specification content excluding the `specificationId` field:

`8b58ae26c4492173f6ce850ba67acd5da5b2f98ab3047edf6bef8780f3865637`

Binance Spot klines are keyed by open time: array field 0 is the open timestamp and field 1 is the OPEN price. The research adapter requests `1d` UTC candles with exact `startTime` and `endTime` bounds. It never substitutes a nearby candle. See the official [Binance Spot REST market-data documentation](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints#klinecandlestick-data).

## Commands

Collect or refresh immutable outcome evidence for completed campaign observations:

```bash
npm run evaluate -- outcome-collect CAMPAIGN_ID --store .zerochart-campaigns
```

Generate the private report after collection:

```bash
npm run evaluate -- decisions-report CAMPAIGN_ID --store .zerochart-campaigns --output .zerochart-reports/CAMPAIGN_ID.html
```

Generate the isolated synthetic report, which includes completed-horizon examples:

```bash
npm run evaluate -- decisions-demo --output .zerochart-reports/synthetic-demo.html
```

Outcome files are stored separately under the campaign's `outcomes/<specification-id>/` directory. Original manifests, attempts, inputs, decisions, and evaluation runs are never modified. Identical collection is idempotent; differing provider data at an already recorded logical path is reported as a conflict.

## Interpretation and limitations

- OPEN-to-OPEN changes are reference-price signal research, not simulated fills.
- BTC-relative differences are percentage-point comparisons, not risk-adjusted alpha.
- Selected, qualified-not-selected, and scored rejected assets are measured. Original data failures with no score are excluded and remain visible in the decision report.
- Observations recorded before the specification freeze are labeled “Prospectively recorded decisions; retrospectively specified analysis.”
- Daily observations and overlapping horizons are correlated. Counts are not independent trials.
- No significance, confidence, profitability, minimum-reliability, or executable-performance claim is made.
