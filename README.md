# Terminal Trade Feed

Role: You are an expert frontend engineer designing "ZeroChart", a minimalist, chartless trading dashboard.
Stack: React, Tailwind CSS, Supabase client.
UI/UX Design ("Terminal Chic"):


Pure Dark Mode background (almost black).

Monospace fonts for all numbers and tickers.

Absolutely NO charts. Just clean grids or lists.

High contrast "Traffic Light" colors for signals: Neon Green for 'Green', Yellow for 'Yellow', Bright Red for 'Red'.

Core Features:


Supabase Connection: Fetch all rows from the assets_status table.

Navigation/Filters: Create a top toggle/tab system with two modes:
🐢 Stable Mode (Long-term): Displays the stable_signal (color indicator) and stable_explanation.
💎 Radar Mode (Swing/Asymmetric): Displays the radar_signal (color indicator), risk_pct (formatted as %), and radar_explanation.

Asset Cards/Rows: For each ticker, show the Symbol, Current Price, the colored Signal indicator (a glowing dot or minimalist badge based on the string 'Green'/'Yellow'/'Red'), and the 1-sentence AI explanation depending on the active filter.

Deliverable: Generate the complete, production-ready frontend code. Ensure the UI handles loading states gracefully. Provide instructions on where to paste my Supabase URL and Anon Key.

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
