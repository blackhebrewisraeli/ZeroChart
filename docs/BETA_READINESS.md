# ZeroChart small-beta readiness notes

Reviewed on 2026-10-23 against the production experience and the current source. This is an agent usability review, not human-user validation or investment-performance validation.

## Ranked findings and focused fixes

| Rank | User task                                       | Observed obstacle                                                                                                                                                                                                                                                                                | Practical consequence                                                                                                   | Focused fix                                                                                                                                                                                             |
| ---- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Understand an empty Quant Analyzer result       | The production empty state combined eligibility, insufficient history, and failed history requests under “No qualifying assets,” then offered only Adjust or a disabled booking action.                                                                                                          | A new user could treat a data failure as a strategy verdict or believe they should weaken the profile to get an answer. | Preserve the configuration, classify actual engine/fetch outcomes, show the selected profile and exact requirements, confirm Paper Cash was unchanged, and offer review, retry, and Paper Desk actions. |
| 2    | Interpret Signal Score and projections          | Score labels did not explicitly say that the number is a model ranking, while the projection used a profile return assumption without a prominent non-forecast statement.                                                                                                                        | A participant could read a score as a probability or the scenario as validated performance.                             | Add the model-score definition at Markets, asset details, the analyzer, and Action Center; relabel the projection as an illustrative mathematical scenario.                                             |
| 3    | Distinguish simulated balances and find history | Paper mode was labeled, but the first description did not name the relationship between Paper Cash, positions, and Trade Ledger.                                                                                                                                                                 | A first-time user could overlook where a confirmed proposal or fill is recorded.                                        | Name Paper Cash, open positions, and the complete Trade Ledger in the Paper Desk orientation copy; retain the existing receipt-to-ledger action.                                                        |
| 4    | Use custom dialogs by keyboard                  | The two custom dialogs focused an initial control and closed with Escape, but Tab could leave the dialog; asset details did not restore the invoking control.                                                                                                                                    | Keyboard users could lose context or interact with content behind the modal.                                            | Contain Tab/Shift+Tab and restore focus on close. Radix-managed dialogs retain their built-in focus handling.                                                                                           |
| 5    | Judge an incoming TradingView signal            | A signed-in production account showed pending webhook signals in the normal Action Center, including a small BUY with a 50 model score. The interface did not show exchange, timeframe, bar time, or model version, so this review could not distinguish a transport test from a strategy alert. | A transport-only test can look actionable even though paper execution is simulated.                                     | Show strategy provenance when present and an explicit verification warning when it is incomplete. See the proposed contract safeguard below.                                                            |

## TradingView transport-test safeguard proposal

Add a required, server-validated purpose to the webhook contract, for example `signal_kind: "strategy" | "transport_test"`. Persist it with the signal and enforce these rules atomically:

1. `transport_test` rows render in a diagnostic connection-status surface, never in the executable Action Center.
2. Only `strategy` rows with the required source metadata and a supported model version can reach `execute_tactical_signal`.
3. Existing rows without the field remain visibly “unverified” and require an explicit migration/compatibility decision.

This pass does not implement that contract because it requires a database migration and changes execution eligibility. The current UI warning is intentionally informational and does not silently change execution semantics.

## What a small beta can evaluate

- Whether participants understand the research-to-paper-trading workflow.
- Whether the model-score definition and simulated-money boundary are clear.
- Whether participants can interpret legitimate empty results and recover from missing or failed data.
- Whether Paper Cash, receipts, and transaction history are discoverable.

## Still unverified

- Human task completion and comprehension using the beta script.
- The first legitimate delivery from the replacement TradingView indicator alert.
- End-to-end identification and isolation of transport-test webhook messages.
- Production behavior of the changes before review, merge, and deployment.
- Any claim of investment performance, strategy efficacy, or real-money suitability.
