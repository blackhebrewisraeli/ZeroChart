# ZeroChart small-beta usability script

Use this script with a dedicated test account. Ask participants to think aloud, but do not teach the interface or define its terms before each task. ZeroChart is paper-trading software; do not use this session to evaluate investment performance.

Record whether each success criterion was met, where the participant hesitated, and the participant's exact words when possible. Do not record credentials, webhook tokens, or other secrets.

## 1. Explain the product

**Prompt:** Starting from the signed-out page, describe what you think ZeroChart is for and what would happen if you placed a trade here.

**Observable success criterion:** The participant identifies research plus paper trading and states that execution uses simulated money rather than a real brokerage account.

**Neutral follow-up:** What on the page led you to that understanding?

## 2. Find and interpret an asset score

**Prompt:** Sign in, choose any asset in Research, and explain what its score means in your own words.

**Observable success criterion:** The participant opens asset details, finds the Model Signal Score, and describes it as a 0–100 model ranking based on RSI, MACD, and ATR—not a probability or promised return.

**Neutral follow-up:** What, if anything, would you want to know before acting on this score?

## 3. Attempt to build a portfolio

**Prompt:** Use the Quant Analyzer to prepare a proposal using an amount and risk profile that make sense to you. Stop before confirming if you do not want to add simulated fills.

**Observable success criterion:** The participant recognizes that the amount comes from Paper Cash, selects a profile, reaches either a proposal or a clearly explained result, and can return to the configuration without losing their choices.

**Neutral follow-up:** How did you decide what to enter and select?

## 4. Interpret an empty result

Run this task only when the analyzer produces no proposal; never change thresholds or fabricate market data to force the state.

**Prompt:** Explain what happened and what you could do next.

**Observable success criterion:** The participant distinguishes a normal no-eligibility result from missing market history or a loading failure, identifies the selected profile and minimum score, and notices that Paper Cash was not spent. They can review the configuration, retry a failed analysis, or open the Paper Desk without being prompted to weaken risk rules.

**Neutral follow-up:** What information helped you decide whether to wait, retry, or leave the analyzer?

## 5. Find Paper Cash and transaction history

**Prompt:** Go to the place where you would check the simulated balance and verify what happened after a simulated trade.

**Observable success criterion:** The participant opens Paper Desk, finds Paper Cash, opens Trade Ledger, and can distinguish this paper ledger from manually tracked real holdings under Account.

**Neutral follow-up:** Where would you expect to look for a receipt after confirming a proposal?

## Session wrap-up

Ask these questions after the tasks:

- Which parts of the product felt most and least predictable?
- Which terms would you rename, if any?
- At any point, what did you think might affect real money?
- What information would you need before using this again?

Do not summarize the session as validation from a single participant. Aggregate task outcomes separately from opinions, and keep agent review, automated checks, browser verification, and human observations distinct.
