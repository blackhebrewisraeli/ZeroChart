# ZeroChart

Role: You are an expert frontend engineer designing "ZeroChart", a minimalist algorithmic signal terminal with live charts.
Stack: React, Tailwind CSS, Supabase client.
UI/UX Design ("Terminal Chic"):


Pure Dark Mode background (almost black).

Monospace fonts for all numbers and tickers.

Live TradingView charts in a focused master-detail layout.

High contrast "Traffic Light" colors for signals: Neon Green for 'Green', Yellow for 'Yellow', Bright Red for 'Red'.

Core Features:


Supabase Connection: Fetch all rows from the assets_status table.

Navigation/Filters: Create a top toggle/tab system with two modes:
🐢 Stable Mode (Long-term): Uses the stable_signal as the color indicator.
💎 Radar Mode (Swing/Asymmetric): Uses the radar_signal as the color indicator for swing / asymmetric setups.

Master-Detail Workspace: A scrollable sidebar list of filtered assets (ticker, price, RSI, trend) with a detail pane showing algorithmic insights (Risk %, Reward %, Volume Spike), a Simulate Buy action, and an embedded TradingView chart.

Deliverable: Generate the complete, production-ready frontend code. Ensure the UI handles loading states gracefully. Supabase is connected automatically (no URL or key needs to be pasted).

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/e2850ff3-8222-4d60-b396-35a3d0345348).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
