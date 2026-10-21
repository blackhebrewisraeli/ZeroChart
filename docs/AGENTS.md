## ZeroChart architecture

- Keep the dashboard at the index route with local mode/filter state; this is a single trading workspace, not a marketing site.
- Read public assets_status through the generated browser client and React Query, with ordered pagination; this keeps RLS and fetch lifecycle management intact.
- Keep sample assets separate from live query data and label previews explicitly; invented prices must never be represented as live market data.
- Define all visual colors in global semantic CSS tokens; signal colors must remain consistent across every view.
