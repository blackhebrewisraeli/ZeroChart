# TradingView-only data architecture: feasibility

Status on 2026-10-29: **no TradingView-only path is authorized for a commercial scanner.** The
connected TradingView MCP server is TradingView's own, but it offers no documented backend access.
TradingView's standard terms don't permit the commercial use described here. A separate written
agreement is the only route, and its terms are unknown.

This is an assessment only. No code, alert, deployment, migration, subscription or external
message was changed or sent. The reading of TradingView's terms below is an engineering
interpretation, not legal approval. Every item marked **needs written confirmation** is for
TradingView to answer.

**Requirement assessed.** TradingView is the only market-data source. ZeroChart scans a broad
instrument universe with its own model (canonical `1.0.0` in `src/lib/canonicalModel.ts`, ported
to Pine as `1.0.0-pw200`), stores results, and shows explained technical opportunities to
subscribers. Users decide whether and where to invest. Automatic trading is out of scope. Other
providers (Binance, Yahoo, IBKR, equity vendors) appear below only as today's sources, never as
the proposal.

## 1. Current integration

```text
 Owner's TradingView account (personal subscription)            ZeroChart (Vercel + Supabase)
 ┌──────────────────────────────────────────────────┐
 │ Chart BINANCE:BTCUSDT, 1D                         │  webhook POST, JSON body     ┌────────────────────────┐
 │  └ Pine "ZC Quant pw200" (private, 1.0.0-pw200)   │  with per-user token,        │ tv-webhook (Edge Fn)   │
 │  └ 1 indicator alert: alert() at bar close  ──────┼──3 s deadline, 2FA needed──► │  → ingest_tradingview_ │
 │ (plus an older, superseded hourly alert)          │                              │    signal RPC          │
 └──────────────────────────────────────────────────┘                              │  → trading_signals     │
                                                                                   └───────────┬────────────┘
 TradingView MCP server  https://mcp.tradingview.com/mcp                                       │
 (TradingView-hosted beta, OAuth 2.1 as the owner)                           Action Center, Signal Journal
   ▲                                                                         (paper execution only)
   │ owner's interactive Claude Code sessions: cross-checks, safe alert listing
   └ no ZeroChart code calls it

 s3.tradingview.com embed script ──► Advanced Chart widget in the user's browser
                                     (display only, attribution kept; ZeroChart reads nothing back)

 Not TradingView (context only): Binance → crypto candles, live prices and scores;
 Yahoo → equity/forex last price and market-analytics fields.
```

| Touchpoint                 | Code or config                                                                                                                                      | What it does                                                                                                                                                             | Data leaves TradingView?                                                      | Basis today                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Chart widget               | `src/components/TradingViewWidget.tsx` (used by `AssetChart`, `AssetDetailsModal`); symbols from `src/lib/tradingViewSymbol.ts`                     | Free Advanced Chart embed with RSI and MACD studies; keeps the "Charts by TradingView" link                                                                              | No. It renders in the browser; the app reads nothing from it                  | Free widget with attribution (Terms §4). The widget data FAQ says data can't be downloaded or exported |
| Pine indicator             | `pine/zerochart_quant_hud.pine`, shipped by `src/lib/pineScriptTemplate.ts` / `PineScriptModal` with the user's capital and webhook token filled in | Recomputes the model on the chart's own symbol and timeframe. Decision parity with the app was verified at runtime on `BINANCE:BTCUSDT` 1D (`PINE_PARITY_ASSESSMENT.md`) | Only through alerts                                                           | Each user's own TradingView account                                                                    |
| Per-symbol alert → webhook | One alert per chart; `supabase/functions/tv-webhook` → `ingest_tradingview_signal` → `trading_signals` (`TRADINGVIEW_EVENT_IDENTITY.md`)            | At bar close, `alert()` posts score, price, quantity, stop, exchange, timeframe, bar time and model version                                                              | Yes: derived outputs plus the close price, one symbol and timeframe per alert | Owner's personal subscription                                                                          |
| TradingView MCP server     | Claude Code project entry `mcp-tradingview` → `https://mcp.tradingview.com/mcp`, HTTP transport, no static key or header in the config              | 35 beta tools: OHLCV, symbol search, screener, symbol data, technicals rating, news, fundamentals, calendars, watchlists, alerts                                         | Into the owner's agent session only                                           | OAuth 2.1 sign-in to the owner's TradingView account                                                   |
| Screener and OHLCV access  | Only through those MCP tools (`run_screener`, `get_symbol_data_batch`, `get_technicals_rating`, `get_ohlcv`); no repository code                    | Cross-checks (`MARKET_SCANNER.md`). The screener and rating figures are TradingView's own, on the unclosed bar                                                           | Into the owner's agent session only                                           | As above. Not a product feed                                                                           |

`EQUITY_DATA.md` and `MARKET_SCANNER.md` called these "the owner's local MCP tools". The client
is local; the server is TradingView's. Both documents now say so.

**Operational finding.** A read-only `list_alerts` call on 2026-10-29 showed both live alerts
expiring about one month after creation. The `1.0.0-pw200` daily alert expires on 2026-11-27 at
13:01 UTC and has not fired yet. Webhook alerts can't be created or edited through MCP (TradingView
requires 2FA, which MCP connections don't support yet), so it must be renewed by hand on
tradingview.com.

## 2. The connected integration

| Question                             | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Evidence                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Who operates it                      | **TradingView.** The endpoint is on `tradingview.com`, the docs call it TradingView's official MCP server, and TradingView's blog announced the public beta on 2026-09-16. The contracting entity for MCP use is not named. TradingView, Inc. issues the general Terms; whether those alone govern MCP is **unknown**                                                                                                                                                    | [MCP docs][mcp-docs], [beta blog][mcp-blog]              |
| Authentication                       | OAuth 2.1: the user signs in to TradingView and approves access. The docs say there are no API keys. Essential plan and above; trials excluded                                                                                                                                                                                                                                                                                                                           | [MCP docs][mcp-docs]                                     |
| Limits                               | About 100 tool calls per minute per user. The beta may also cap daily requests; no cap is published. `get_ohlcv`: up to 5,000 bars per call as rows or 8,000 as columns, with paging. `run_screener`: up to 1,000 rows. `get_symbol_data_batch`: up to 50 symbols. Alerts: a single price condition only, no webhook alerts                                                                                                                                              | [MCP docs][mcp-docs], [beta blog][mcp-blog], tool schema |
| Bar semantics (observed)             | `BINANCE:BTCUSDT` 1D, 3 bars, 2026-10-29: rows `{t, o, h, l, c, v}`, `t` = bar open in Unix seconds UTC. The last bar was 2026-10-29 and still forming. The response notice says data follows the user's plan and exchange subscriptions (real time where held, otherwise delayed), regular session only, split-adjusted only                                                                                                                                            | `get_ohlcv` response                                     |
| Backend use without an agent session | **No supported way is documented.** No service account, API key or machine-to-machine grant is documented. The docs name AI assistants and coding tools as clients and say any MCP-compatible client works, but describe no unattended or server use. TradingView support says it has no API that gives access to data "as of now". Whether a server-side MCP client may hold the owner's OAuth grant is **unknown**; the non-display rules in Terms §3 point against it | [MCP docs][mcp-docs], [no data API][no-api]              |
| Product rights                       | None are granted on the MCP pages: they say nothing about commercial use, storage or redistribution. Having the tool connected grants no integration rights; the Terms of Use still apply                                                                                                                                                                                                                                                                                | [MCP docs][mcp-docs], [Terms][terms]                     |

## 3. Paths A, B and C

**Summary.**

|                            | A. Calculate inside TradingView, deliver outputs                                  | B. Candles through the MCP server, calculate in ZeroChart | C. Official agreement or supported integration |
| -------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------- |
| Runs ZeroChart's own model | Yes on one chart symbol (verified); many symbols per script unverified            | Yes: the canonical TypeScript model on validated candles  | Depends on what is licensed                    |
| Unattended                 | Yes: alerts run on TradingView's servers; one-month alert lifetime, manual set-up | No supported way                                          | Unknown                                        |
| Broad universe             | Bounded by alert count × symbols per script (theoretical, unverified)             | Technically yes (screener plus OHLCV)                     | Unknown                                        |
| Commercial use authorized  | No                                                                                | No                                                        | The only route                                 |
| Verdict                    | Technically closest; not authorized                                               | No supported backend access; not authorized               | Required gate; terms unknown                   |

**Detail.** "Verified" means read on a primary TradingView page or observed on 2026-10-29.
Everything else is marked as an inference or unknown.

| Criterion                                           | A. Calculate inside TradingView                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | B. Candles via MCP, calculate in ZeroChart                                                                                                                                                                                                                                                                                                     | C. Official agreement                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instruments and universe discovery                  | Anything the account's data entitlements chart. Pine has no symbol-list function: symbols must be script inputs or hard-coded. The [Pine Screener][pine-screener] scans up to 4,000 symbols of an index, but it ignores `input.symbol()` and runs only when a user starts it in the UI. Watchlists hold up to 1,000 symbols ([watchlist limit][tv-wl-size])                                                                                                                                                | `search_symbols`, `run_screener` (1,000 rows per call) and watchlists cover discovery                                                                                                                                                                                                                                                          | Unknown. Published offers: Enterprise plans for 100+ seats; Ultimate for professional users; Advanced Charts and Trading Platform libraries, which ship **without** data ([FAQ][cl-faq]), so they can't be TradingView-only; widgets; broker integration (brokers only); the Marketplace for commercial scripts |
| Historical OHLCV and closed bars                    | Chart history of 10K bars on Essential and Plus, 20K Premium, 40K Ultimate ([limits][pine-limits]). The chart symbol alerts at bar close (as today). Other symbols need the documented non-repainting form `request.security(sym, tf, expr[1], lookahead = barmerge.lookahead_on)` ([repainting][pine-repaint]). Each script's bars follow the chart symbol's session, so each asset class needs its own chart (inference). The Pine Screener uses the last 500 bars; the model needs 200                  | Daily history back to listing, 5,000 bars per call. The last bar is forming and must be dropped, as the Binance path already does. Split-only, regular-session bars match `us-equity-daily-v1`'s adjustment rule. How an equity daily bar's `t` maps to the New York session date is **unverified**                                            | Unknown                                                                                                                                                                                                                                                                                                         |
| Computes the actual model, not TradingView's rating | One symbol: yes, decision parity on `BINANCE:BTCUSDT` 1D. Many symbols in one script: **unverified**. Limits: 40 unique `request.*()` calls (64 on Ultimate), 127 tuple elements across all requests (a user-defined type gets around it), 40 s total execution and 500 ms per loop. `1.0.0-pw200` recomputes over 200 bars on every bar, so cost grows with each requested symbol                                                                                                                         | Yes. The same canonical model and candle validation as the crypto scan. `get_technicals_rating` and screener columns are TradingView's own figures and must not be used as the model                                                                                                                                                           | Depends on whether candles or Pine outputs are licensed                                                                                                                                                                                                                                                         |
| Scheduling, unattended operation, sessions          | Alerts run on TradingView's servers. Observed lifetime about one month on the owner's plan. The pricing table lists 1- and 2-month alert durations without a clear per-plan mapping; the [alerts guide][tv-alerts] offers open-ended alerts on Premium and Ultimate. Webhooks need 2FA, ports 80/443, a 3 s response; no retries are documented ([webhooks][tv-webhooks]). Webhook alerts are created by hand, not through MCP. Pine Screener: manual only, with no schedule, export or webhook documented | Needs an OAuth-authorized client; no service authentication, token lifetime or refresh behaviour is documented. Beta; daily cap unknown. Unattended operation is unsupported as documented                                                                                                                                                     | Unknown                                                                                                                                                                                                                                                                                                         |
| Coverage scale and operational limits               | Technical alerts: 20 Essential, 100 Plus, 400 Premium, 1,000 Ultimate ([pricing][pricing]). Theoretical ceiling at 40 symbols per alert: 800 symbol-timeframes on Essential, 64,000 on Ultimate (inference; never tested). Watchlist alerts: none listed for Essential or Plus, 2 Premium, 15 Ultimate; whether they accept a custom Pine `alert()` condition is **undocumented**. Maximum alert message size: **unknown**                                                                                 | About 100 calls per minute, so on the order of 100 daily histories per minute if the beta's daily cap allows (inference)                                                                                                                                                                                                                       | Unknown                                                                                                                                                                                                                                                                                                         |
| Latency                                             | Bar close plus webhook delivery (≤ 3 s). Exchange data the account doesn't hold in real time is delayed                                                                                                                                                                                                                                                                                                                                                                                                    | Per call; delayed unless the account holds the exchange's real-time data                                                                                                                                                                                                                                                                       | Unknown                                                                                                                                                                                                                                                                                                         |
| Known costs                                         | Plans on 2026-10-29, billed annually: Essential $12.95/mo, Plus $29.95, Premium $59.95, Ultimate $199.95. Only Ultimate is sold to professional users, who also buy professional exchange data (fees not published there)                                                                                                                                                                                                                                                                                  | Essential or above. No separate MCP fee is published                                                                                                                                                                                                                                                                                           | Unknown; Enterprise is "Contact sales"                                                                                                                                                                                                                                                                          |
| Storage, derived display, redistribution            | Terms §3 licenses charts, alerts and webhooks for display only, for personal or internal business purposes; commercial use needs a separate agreement. §10: a non-professional subscription can't be used for a business. Payloads carry outputs, not input candles, so `scan-reproduce` and outcome measurement would need more TradingView data (inference). **Needs written confirmation**                                                                                                              | Terms §3 bars non-display use, including machine-driven processing without human-readable display and algorithmic decision-making, processing TradingView content, and building products on it. Commercial use of the APIs needs a separate agreement. The widget data FAQ says data can't be exported. **Not permitted without an agreement** | Defined by the agreement                                                                                                                                                                                                                                                                                        |
| Evidence                                            | [Pine limits][pine-limits], [repainting][pine-repaint], [Pine Screener][pine-screener], [alerts guide][tv-alerts], [webhooks][tv-webhooks], [watchlist alerts][tv-wl-alerts], [pricing][pricing], [Terms][terms], runtime parity evidence, `list_alerts` on 2026-10-29                                                                                                                                                                                                                                     | [MCP docs][mcp-docs], [beta blog][mcp-blog], [no data API][no-api], [widget data FAQ][widget-data], [Terms][terms], `get_ohlcv` on 2026-10-29                                                                                                                                                                                                  | [Pricing][pricing] (Contact sales form), [professional status][tv-pro], [Charting Library FAQ][cl-faq], [no data API][no-api], [Terms][terms]                                                                                                                                                                   |
| Unresolved                                          | Permission to deliver Pine outputs to a commercial service. Multi-symbol runtime cost. Watchlist alerts with custom Pine. Alert message size. Plan and professional status                                                                                                                                                                                                                                                                                                                                 | Whether any backend use is permitted. Daily cap. Equity bar dates                                                                                                                                                                                                                                                                              | Whether TradingView licenses this at all, the price, and which exchange approvals are needed                                                                                                                                                                                                                    |

**One alert is not a scan.** Today's alert watches one symbol on one timeframe and reports a
condition when it turns true. A scan evaluates every instrument in a universe on a schedule and
reports the ones it couldn't evaluate. Inside TradingView, the nearest things to a scan are a
script that requests up to 40 (or 64) other symbols, which is unverified for this model, and the
Pine Screener, which is a manual UI tool.

## 4. Terms by use

Source: TradingView [Terms of Use][terms], retrieved 2026-10-29. The page shows no effective date.

| Use                                     | Example                                                                                                                                                    | Reading of the standard terms                                                                                                                                                                                                                                                                                                                                                                                                                                     | Written confirmation needed?        |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Personal research                       | The owner charts, runs the Pine HUD and asks Claude through MCP on their own account                                                                       | Consistent with a non-professional natural person's personal use (§3, §10). The MCP docs present Claude and Claude Code as intended clients. §26 limits TradingView's "AI Features" to personal, non-automated use; whether MCP counts as an AI Feature is unclear                                                                                                                                                                                                | Only once results feed the business |
| Internal business use                   | ZeroChart, as a business, runs scheduled evaluation campaigns and stores scores                                                                            | §3 permits display-only internal business use but bars non-display, machine-driven processing. §10 and the [professional status][tv-pro] page: business use is professional, so it needs Ultimate and professional data, not a personal plan                                                                                                                                                                                                                      | Yes                                 |
| Commercial service to end users         | Derived scores, reasons and signals shown to paying subscribers                                                                                            | §3: commercial use of the services or APIs only by separate agreement; no distribution for compensation; no products based on TradingView content or processing of it. Alerts and webhooks are display-only for personal or internal use. Leaving out raw prices doesn't avoid this: the restrictions name alerts, webhooks and processing, not only prices                                                                                                       | Yes; can't proceed without it       |
| Each user brings their own subscription | A subscriber runs the ZeroChart indicator on their own TradingView account and sends alerts to their own ZeroChart account (today's per-user token design) | Not addressed. §3 also bars third parties from operating products that enable users to breach the policy or that advertise webhooks for prohibited purposes. Each user is limited to their plan's alerts, so this isn't a broad scan, and pooling users' outputs into a shared scan would be redistribution (inference). §23 allows commercial scripts only through the Marketplace, enforced from 2026-11-01; whether handing users the source counts is unclear | Yes                                 |
| Chart widget on a paid site             | The Advanced Chart embed on ZeroChart pages                                                                                                                | §4 requires the attribution to stay as designed (it does). The widget FAQ is silent on commercial sites                                                                                                                                                                                                                                                                                                                                                           | Ask while asking the rest           |

## 5. Facts, inferences and unknowns

**Verified (primary documentation or observation, 2026-10-29)**

- The connected server is TradingView's hosted MCP server, in public beta since 2026-09-16, with
  OAuth 2.1 sign-in, Essential and above, about 100 calls per minute per user.
- MCP cannot create or edit webhook alerts and supports only single price-condition alerts.
- TradingView says it has no API that gives access to data, and its charting libraries ship
  without data.
- Terms §3: display-only licence for personal or internal business purposes; non-display use
  prohibited; commercial use only by separate agreement. §10: business use is professional.
- Pine: 40 unique `request.*()` calls (64 on Ultimate), 127 tuple elements, 40 s execution.
  Pine Screener: 4,000 index symbols, 500 bars, manual start.
- Technical alerts: 20, 100, 400 and 1,000 by paid tier; watchlist alerts only on Premium (2)
  and Ultimate (15).
  Webhooks need 2FA and a 3 s response.
- `get_ohlcv` returns a forming last bar, split-only, regular session, delayed unless the
  account holds real-time exchange data.
- Both live alerts expire about one month after creation; the daily pw200 alert expires
  2026-11-27 13:01 UTC.

**Inferences (not tested)**

- A single Pine script could evaluate up to 40 symbols per alert, but the pw200 model's 200-bar
  recomputation may exceed the 40 s budget long before that.
- Each Pine scan needs one chart per session calendar (crypto UTC days, US equities New York
  sessions).
- Path A's payloads don't carry the input candles, so reproducibility and outcome measurement
  would need more TradingView data under the same agreement.
- Path A is more likely to be licensable than B, because only derived outputs leave
  TradingView. That is a guess about TradingView's position, not evidence.

**Unknown**

- Which terms govern MCP use, and whether any unattended or server-side MCP client is permitted.
- The MCP beta's daily request cap.
- Whether watchlist alerts accept custom Pine conditions, and the maximum alert message size.
- Whether TradingView licenses data or Pine outputs for this use, at what price, and which
  exchange or data-provider approvals it needs.
- Whether subscribers would need their own TradingView subscriptions.

## 6. Recommendation

**No TradingView-only commercial architecture is viable on current evidence.** Authorization is
unresolved for every path, and Path B also lacks supported backend access.

The one path the evidence supports pursuing is **C: ask TradingView for a written agreement**.
Propose Path A's shape (ZeroChart's Pine indicator runs inside TradingView; webhooks deliver
derived outputs), because it is the only one with demonstrated runtime parity and live
ingestion, and it keeps raw data inside TradingView. Ask in the same inquiry whether licensed
backend access to closed daily candles is possible, because ZeroChart's reproducibility and
outcome measurement depend on stored inputs.

Until TradingView answers in writing:

- keep TradingView use to personal research and the owner's own alerts;
- don't build a server-side MCP client, scale alerts, or ship a multi-symbol Pine scanner;
- don't change plans or professional status;
- keep the equity cohort `UNSUPPORTED` (`EQUITY_DATA.md`).

## 7. Blockers and the smallest next action

| #   | Blocker                                                                                                                   | Paths   | Smallest next action                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | No written permission for commercial use of TradingView data, alerts or Pine outputs                                      | A, B    | The owner submits the Contact sales form with the 138-character line in section 8, then sends the full inquiry to whoever replies               |
| 2   | The owner's subscription is personal; business use is professional                                                        | A, B    | Question 6 of the inquiry. No upgrade or reclassification before the answer                                                                     |
| 3   | No documented backend authentication for MCP; daily cap unknown                                                           | B       | Question 1. Meanwhile no ZeroChart code calls the MCP server                                                                                    |
| 4   | Multi-symbol pw200 in one script is unverified                                                                            | A       | Only after a positive answer: compile a private five-symbol prototype on a separate layout, with no alert, and compare it with `npm run parity` |
| 5   | No universe discovery in Pine; Pine Screener is manual; watchlist alerts with custom Pine undocumented and 0 on Essential | A       | Question 3                                                                                                                                      |
| 6   | Alerts last about a month and webhook alerts can't be created through MCP                                                 | A (ops) | The owner renews the daily pw200 alert on tradingview.com before 2026-11-27 13:01 UTC                                                           |
| 7   | Path A payloads don't include input candles                                                                               | A       | Question 4                                                                                                                                      |
| 8   | Equity entitlements and delay; equity bar-date mapping                                                                    | A, B    | Question 2; check the bar-date mapping only if B is licensed                                                                                    |

## 8. Inquiry (draft, not sent)

**Route.** On [tradingview.com/pricing][pricing], under Enterprise plans, **Contact sales** opens
a form titled "Bulk Enterprise plans for companies". It asks for name, company email, company,
website, company profile, country, job title and phone, and allows 140 characters for the
reason. TradingView publishes no data-licensing contact ([no data API][no-api]), so this form is
the nearest official sales route. If nobody replies, open a ticket from the signed-in account
through the [Help Center][tv-help]. `legal@tradingview.com` is the Terms' address for legal
notices and arbitration, not sales; use it only if TradingView directs you there.

Reason line for the form (138 characters):

```text
Licensing inquiry: commercial screening app. Scheduled multi-symbol scans (Pine outputs or candles), derived signals shown to subscribers.
```

Full inquiry, to send once a contact replies. Fill in the bracketed fields; add no account
names, tokens, webhook URLs or research files.

```text
Subject: Licensing inquiry: commercial technical-screening app using TradingView data or Pine outputs

Hello,

I'm [name], [role] at [company]. We run ZeroChart ([website]), a web application that screens
US stocks, ETFs and crypto with our own technical model and shows the results to subscribers.
We would like TradingView to be our only market-data source, and we want to know whether and
how that can be licensed.

What we would like to do

1. Scheduled multi-symbol analysis. After each closed daily bar (perhaps hourly later), evaluate
   a universe of US stocks and ETFs and major crypto pairs (about 100 instruments today,
   [target number] later) with our own model: RSI, MACD and ATR factor scores with a
   volatility/trend regime filter. We would not use TradingView's technical ratings.
2. Inputs, by either route:
   a. historical daily candles (OHLCV, closed bars only, about 200 bars per instrument)
      delivered to our servers; or
   b. outputs calculated by our own Pine Script indicator on TradingView and delivered by
      webhook alerts (score, action, stop level, bar time, model version).
3. Storage. We would keep each run's inputs and outputs for [N years] to reproduce results and
   measure the model's quality over time. Nothing would be resold or offered as a data feed.
4. Display. Subscribers would see derived scores, plain-language reasons and signals for each
   instrument. Charts would come only from your widgets, with attribution. We understand that
   leaving out raw prices may not by itself make this permissible.
5. No automatic trading. We place and route no orders; users decide whether and where to
   invest. The app has a simulated (paper) trading log with no real orders.

Questions

1. Which supported integration fits this use: a data licence with backend access, server-side
   use of the TradingView MCP server, Pine Script with webhook alerts, or something else? Does
   the MCP server support unattended server-to-server use, and under which account type?
2. Which agreements do we need with TradingView, and which permissions from data providers or
   exchanges, for US stocks and ETFs and for crypto? Is end-of-day data delayed or real time
   under each option?
3. Inside TradingView, are indicators that evaluate many symbols (request.security), the Pine
   Screener, or watchlist alerts with custom Pine conditions supported for this scheduled
   commercial use, and with what limits?
4. What restrictions apply to storing candles or Pine outputs for reproducibility and quality
   evaluation, and to showing derived scores, reasons and signals to paying subscribers?
5. Would each subscriber need their own TradingView subscription? If a subscriber runs our
   indicator on their own TradingView account and sends alerts to their own ZeroChart account,
   is that permitted, and may we show those results to that subscriber only? Is giving
   subscribers our indicator's source compatible with your rules for commercial scripts?
6. Which TradingView subscription and professional status apply to our internal evaluation
   before launch?
7. Are there requirements beyond attribution for your chart widgets on a paid subscription site?
8. Pricing and next steps: is there a standard agreement we can review, and who should we
   contact?

We need your answers in writing before we build or launch anything on this basis.

Thank you,
[name]
[company]
[email]
```

## Sources

Retrieved 2026-10-29.

- [TradingView MCP Server documentation][mcp-docs]
- [Bring TradingView to Claude with the new MCP Server (blog, 2026-09-16)][mcp-blog]
- [Terms of Use and Company Policy][terms] (§3, §4, §10, §23, §26, §28)
- [Professional and non-professional status][tv-pro]
- [Pricing and plan comparison][pricing]
- [Pine Script limitations][pine-limits] and [repainting][pine-repaint]
- [Pine Screener: key features and requirements][pine-screener]
- [Introduction to TradingView alerts][tv-alerts], [webhook alerts][tv-webhooks], [watchlist alerts][tv-wl-alerts], [watchlist size][tv-wl-size]
- [No API for data or indicator values][no-api], [widget data FAQ][widget-data], [Charting Library FAQ][cl-faq]
- [Help Center][tv-help]

[mcp-docs]: https://www.tradingview.com/mcp/docs
[mcp-blog]: https://www.tradingview.com/blog/en/tradingview-mcp-server-public-beta-60864/
[terms]: https://www.tradingview.com/policies/
[tv-pro]: https://www.tradingview.com/support/solutions/43000677382-the-difference-between-professional-and-non-professional-status/
[pricing]: https://www.tradingview.com/pricing/
[pine-limits]: https://www.tradingview.com/pine-script-docs/writing/limitations/
[pine-repaint]: https://www.tradingview.com/pine-script-docs/concepts/repainting/
[pine-screener]: https://www.tradingview.com/support/solutions/43000742436-tradingview-pine-screener-key-features-and-requirements/
[tv-alerts]: https://www.tradingview.com/support/solutions/43000520149-introduction-to-tradingview-alerts/
[tv-webhooks]: https://www.tradingview.com/support/solutions/43000529348-how-to-configure-webhook-alerts/
[tv-wl-alerts]: https://www.tradingview.com/blog/en/watchlist-alerts-on-tradingview-49839/
[tv-wl-size]: https://www.tradingview.com/support/solutions/43000611193-how-many-symbols-can-i-add-to-the-watchlist/
[no-api]: https://www.tradingview.com/support/solutions/43000474413-i-need-access-to-your-api-in-order-to-get-data-or-indicator-values/
[widget-data]: https://www.tradingview.com/widget-docs/faq/data/
[cl-faq]: https://www.tradingview.com/charting-library-docs/latest/getting_started/Frequently-Asked-Questions/
[tv-help]: https://www.tradingview.com/support/
