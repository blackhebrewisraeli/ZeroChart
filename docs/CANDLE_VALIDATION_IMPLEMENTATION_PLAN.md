# Candle-validation implementation plan

1. Introduce a pure shared validator with a versioned Binance daily policy, structured issue
   codes, deterministic sorting, closed-candle selection, cadence checks, and freshness
   metadata. Validation applies to the model window; older unused provider history is retained
   for evidence but cannot invalidate the window.
2. Preserve Binance open and close timestamps from the provider response. Reject malformed
   rows at the scoring/evaluation boundary instead of silently dropping, deduplicating,
   interpolating, filling, or repairing them.
3. Gate browser scoring and proposals, private evaluations and observations, and forward
   outcome measurement with the shared validator. Represent data failures separately from
   market ineligibility and surface structured explanations in the private report.
4. Attribute the policy version through a new evaluation schema/configuration. Keep the
   legacy evaluator available only for exact reproduction of stored schema-v1 runs. Refuse to
   run the existing frozen campaign under the new policy; document owner-driven creation of a
   new campaign without initializing one automatically.
5. Add focused tests for structural validity, normalization, close boundaries, freshness,
   outcome refusal, and legacy evidence semantics. Run the normal suite, type/lint/build
   checks, and document exact results and remaining gaps.
