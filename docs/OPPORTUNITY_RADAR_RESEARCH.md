# Opportunity Radar v1 — frozen prospective research contract

Opportunity Radar is a personal decision-support system that scans a fixed Binance Spot universe
once per UTC day and records a new long Opportunity only when trend, momentum, volatility and the
BTC market regime agree. It does not place orders, manage an account or promise profit.

The machine-readable source of truth is [`opportunity-radar.v1.json`](opportunity-radar.v1.json).
Its `specificationId` is the SHA-256 of the repository's canonical stable JSON serialization after
removing the `specificationId` field:
`0eddcc4f81ba47d74168392bb50af64050d3a9db2ab56da914c3814087d64483`. Any change to a rule or
threshold is a new version frozen before it collects data; v1 evidence is never rewritten.

## Objective

Test prospectively whether a sparse, explainable daily crypto Opportunity has positive 20-day
net reference-price change and outperforms both BTC and the same-date eligible universe. The first
user is the repository owner. Success is evidence that can justify reviewing a later tiny-capital
pilot, not immediate trading and not linear returns.

## Prior knowledge and freeze boundary

The contract was frozen after the US-equity scanner retrospective v1/v2 results and the earlier
five-asset crypto observation campaign were known. No Opportunity Radar v1 crypto signal or
outcome was computed before this contract. Its numeric model thresholds reuse committed ZeroChart
constants (`LONG_SETUP_MIN_SCORE`, `FLAT_MOMENTUM`, `REGIME_HIGH_VOLATILITY`, SMA 50/200 and the
existing 2×ATR risk convention) rather than fitting prior outcomes.

At freeze time, all twelve named USDT pairs were verified as `TRADING` on Binance Spot. The older
`MATICUSDT` mapping was checked and excluded because it was not trading. Current quote volume was
used only as an availability/liquidity sanity check; no historical or forward return selected a
member.

## Primary contract

- **Market:** Binance Spot, USDT, long-only, no leverage, manual execution outside the study.
- **Universe:** BTC, ETH, BNB, SOL, XRP, ADA, DOGE, AVAX, LINK, DOT, LTC and BCH, fixed for v1.
- **Decision:** one immutable logical slot at 00:30 UTC after the daily candle closes; bounded
  retries end at 06:00 UTC. No later backfill of a missed slot.
- **Market gate:** BTC must be above SMA(200), SMA(50) must be above SMA(200), and its canonical
  regime must not be `HIGH_VOLATILITY`.
- **Member rule:** close above SMA(50), SMA(50) above SMA(200), canonical score ≥ 78, normalized
  MACD histogram ≥ 0.05%, regime not `HIGH_VOLATILITY`, and the BTC gate passing.
- **Transition only:** a continuing condition is coverage, not another alert. A new Opportunity
  requires an observed non-qualifying slot immediately before it; unknown onset creates none.
- **Displayed contract:** entry zone from close − 0.50×ATR to close + 0.25×ATR, invalidation at
  close − 2×ATR, three daily opens to enter, primary horizon 20 days and secondary horizons
  5/10/30 days.

The next daily open is the primary intent-to-treat reference even when it falls outside the
displayed entry zone. This prevents an inconvenient gap from being deleted after the fact. Entry-
zone reach is reported separately as an executability diagnostic. Invalidation touch is also a
diagnostic, not a claimed stop fill.

## Benchmarks, costs and decision gate

The primary result is the 20-day OPEN-to-OPEN change after a fixed 30 bps round-trip deduction,
plus its percentage-point differences versus BTC and the same-date equal-weight eligible universe.
All secondary horizons, favorable/adverse excursions, invalidation touches and entry-zone results
are reported in either direction.

The 90-day checkpoint is operational only. A performance decision waits for at least 180 calendar
slots, 40 matured primary Opportunities, six assets and four opportunity months, with no asset
above 30% of observations. At least 95% of slots must complete; every completed slot must reproduce
offline; immutable conflicts must be zero.

Passing additionally requires positive mean and median net 20-day change, positive mean excess
against both benchmarks, and a positive lower bound of the frozen 90% moving-block bootstrap for
BTC excess. Passing authorizes only an owner review of a new, separately specified tiny-capital
pilot. It never activates trading. Failure or insufficient evidence keeps shadow mode active.

## Commands

These are the required command contracts for the implementation phase:

```bash
npm run evaluate -- opportunity-campaign-init CAMPAIGN_ID --store .zerochart-campaigns
npm run evaluate -- opportunity-campaign-run CAMPAIGN_ID --store .zerochart-campaigns
npm run evaluate -- opportunity-campaign-reproduce CAMPAIGN_ID --store .zerochart-campaigns --block-network
npm run evaluate -- opportunity-outcomes CAMPAIGN_ID --store .zerochart-campaigns --matured-only
npm run evaluate -- opportunity-report CAMPAIGN_ID --store .zerochart-campaigns --operational-only
```

Before the decision gate, `opportunity-report` must refuse performance output. The eventual final
report uses a separate explicit flag and must refuse until the frozen sample gate is met.

Repository verification remains:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Project structure

- `docs/opportunity-radar.v1.json` — immutable machine-readable research contract.
- `docs/OPPORTUNITY_RADAR_RESEARCH.md` — human-readable method and boundaries.
- `scripts/` — future campaign, reproduction, outcome and private report commands.
- `src/lib/` — pure Opportunity contract and deterministic evaluator; no network or storage.
- `.zerochart-campaigns/` — private ignored evidence store.
- `.zerochart-reports/` — private ignored reports.

## Code style

The evaluator must be pure and return reasons rather than hide failures:

```ts
const result = evaluateOpportunity({ slot, market, member });
if (result.status !== 'QUALIFIED') return result;
return createOpportunity(result, frozenSpecification);
```

Use explicit UTC timestamps, version every contract that can change a result, code-unit ticker
ordering, stable serialization and exclusive/create-or-verify writes. Do not read clocks, networks
or environment variables inside the pure evaluator.

## Testing strategy

- Contract-alignment test: JSON equals code and its identifier recomputes exactly.
- Synthetic unit fixtures for every gate boundary, tie, transition and missing-data state.
- Time tests around 00:00/00:30/06:00 UTC and delayed retries.
- Leakage tests: future candles cannot change an earlier slot or Opportunity.
- Idempotency/conflict tests for attempts, observations, outcomes and reports.
- Offline reproduction with network access explicitly blocked.
- Outcome fixtures for gaps, entry-zone misses, invalidation, benchmarks, costs and maturity.
- Report refusal tests before the decision gate.
- Full repository typecheck, lint, test and build gates.

## Boundaries

### Always

- Preserve every attempt, failure, missed slot, candidate and emitted Opportunity.
- Record provider timestamps, exact inputs, versions and hashes before outcomes mature.
- Keep raw market data and per-asset evidence private.
- Report every frozen result and limitation, favorable or not.

### Ask first

- Adding a provider, notification service, dependency, database migration or CI schedule.
- Starting a campaign, because its manifest permanently binds a future start and implementation
  commit.
- Publishing any aggregate result before the decision gate.

### Never

- Change v1 thresholds, universe, costs, horizons or benchmarks after collection starts.
- Backfill a missed slot or replace a failed member with another source.
- Delete losing, expired, invalidated or incomplete Opportunities.
- Place an order, access a brokerage account or infer a fill.
- Treat a subgroup discovered from outcomes as confirmatory evidence.
- Claim guaranteed, stable or linear profit.

## Success criteria

The contract is ready for implementation when its identifier is fixed, JSON and documentation
agree, and tests can encode every refusal and boundary above. The product remains unready for real
capital until a completed prospective campaign passes the frozen decision gate and the owner
approves a separate tiny-capital pilot specification.

## Open implementation choices

Notification transport and durable private backup may be chosen during planning. Neither may
change signal inclusion, timestamps or evidence identity. Interactive Brokers and equities are a
future cohort with their own provider, calendar, model validation and research version; they never
share a rank or threshold with this Binance study.
