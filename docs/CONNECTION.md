# ZeroChart connection

## This Lovable project

Lovable Cloud is connected automatically. No URL or key needs to be pasted. The dashboard reads every row in `public.assets_status`, paging in batches of 1,000. The database starts empty; **Sample data** is a separate, explicitly labeled frontend preview, not live prices or investment advice.

To use your existing external project instead, connect it through **Project Settings → Connectors → Supabase**. It cannot be linked by pasting credentials into chat.

## Running the frontend outside Lovable

In the project root, create `.env.local` and paste your project's public connection values:

```env
VITE_SUPABASE_URL=<your project URL>
VITE_SUPABASE_PUBLISHABLE_KEY=<your anon key or publishable key>
```

The shared client in [`src/lib/supabaseClient.ts`](../src/lib/supabaseClient.ts) reads these variables through [`src/lib/supabaseConfig.ts`](../src/lib/supabaseConfig.ts). Never use a service-role or secret key in frontend code. Restart your local development process after changing environment variables. Use `bun install` and `bun run dev` to run locally.

## Required table

`assets_status` needs `ticker`, `current_price`, `stable_signal`, `stable_explanation`, `radar_signal`, `radar_explanation`, `risk_pct`, `reward_pct`, `volume_spike`, `rsi_14`, `sma_50`, and `sma_200`. Signals are `Green`, `Yellow`, or `Red`. `risk_pct` and `reward_pct` are stored as fractions (a `risk_pct` of `0.016` displays as `1.6%`; a `reward_pct` of `0.052` displays as `5.2%`), while `volume_spike` is a ratio (`1.8` displays as `1.8x`). `rsi_14` is a 0–100 reading shown green when below 30 and red when above 70; the trend icon points up when `current_price` is above `sma_50` and down otherwise. Prices are displayed in USD. Missing values display as a dash or unavailable signal rather than implying a buy signal.

The included migration creates the table, enables row-level security, and grants public **read-only** access to market signals. Do not put private portfolios or personal data in this public table. Updates must come from a trusted data provider or authorized process; this frontend does not generate AI analysis or prices.

Fetch failures show an error and retry action. An empty table shows an empty state with an optional sample preview. Samples are never substituted for a failed live request. Manual refresh and a 60-second refresh keep the view current; background refresh failures preserve the previous snapshot with an explicit stale warning.
