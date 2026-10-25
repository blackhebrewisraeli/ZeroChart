# Decisions & Evidence: private local viewer

The Decisions & Evidence report is a standalone HTML export over the immutable evaluation and campaign artifacts. It is a research-inspection tool, not a production route, backend service, trading surface, or performance report.

The export contains private research data. Keep it local. Before sharing any copy, review the campaign ID, universe, configuration, timestamps, decisions, and failure details. Generated files live in the ignored `.zerochart-reports/` directory.

## Generate a report

From the repository root, generate a report for an existing local campaign:

```bash
npm run evaluate -- decisions-report private-2026q4-002
```

Use a different local campaign store or output filename when needed:

```bash
npm run evaluate -- decisions-report CAMPAIGN_ID \
  --store .zerochart-campaigns \
  --output .zerochart-reports/CAMPAIGN_ID.html
```

Generate the sanitized synthetic demonstration:

```bash
npm run evaluate -- decisions-demo
```

Open `.zerochart-reports/synthetic-demo.html` or the campaign report directly in a browser. No server is required. The file embeds its CSS, JavaScript, and sanitized report data and makes no network request.

## What the viewer means

- **Recorded observation** means a completed campaign attempt linked to a validated immutable evaluation run.
- **Offline reproduction MATCH** appears only when a stored reproduction record explicitly says `MATCH`. Loading a run is not reproduction.
- **Synthetic demonstration** contains invented assets and candles. It is not historical or prospective evidence.
- **Missing or failed data** remains visible in structured rejection reasons and failed attempts.
- **Missing reproduction** is shown explicitly and is not inferred to be a match.
- **Proposed allocation** is a research proposal. It is not an order, fill, or executed position. Planned ATR sizing stops are not displayed as executed stops.

The viewer never reports return, win rate, drawdown, profitability, or other investment-performance metrics. It presents operational evidence and recorded decision behavior only.

## Owner checklist

1. Keep `.zerochart-campaigns/`, `.zerochart-evaluations/`, and `.zerochart-reports/` private and uncommitted.
2. Generate the report with the command above; generation reads artifacts and writes only the selected output file.
3. Check the red **Artifact errors** panel. A malformed, incomplete, contract-mismatched, or tampered artifact prevents decision evidence from being displayed.
4. Compare **Latest observation** with **Report generated**. They are deliberately separate timestamps.
5. Use the asset, slot, eligibility, and selection filters. Eligibility and portfolio selection are separate concepts.
6. Expand structured rejection reasons and inspect the configuration ID before relying on an explanation.
7. Treat `MISSING` or `MISMATCH` reproduction as unresolved evidence. To create a legitimate record, use the existing offline command:

   ```bash
   npm run evaluate -- campaign-reproduce CAMPAIGN_ID --block-network
   ```

8. Regenerate the report after recording reproduction; the report never writes or fabricates reproduction results.

## Safety properties

The generated document sets a restrictive Content Security Policy, has no external scripts, fonts, analytics, or API calls, and renders artifact values through DOM text nodes. Embedded JSON escapes HTML-significant characters. Raw candle snapshots are not embedded because the decision-level as-of, freshness, score, and component evidence is sufficient for this inspection surface.

Absolute local paths are redacted from report fields. Artifact integrity is checked through the existing campaign manifest, configuration hash, evaluation contract, input hash, and stored run loaders. Generation does not update campaigns, attempts, runs, reproductions, schedules, alerts, orders, or production data.
