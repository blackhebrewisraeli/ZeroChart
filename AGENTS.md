<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## ZeroChart architecture
- Keep the dashboard at the index route with local mode/filter state; this is a single trading workspace, not a marketing site.
- Read public assets_status through the generated browser client and React Query, with ordered pagination; this keeps RLS and fetch lifecycle management intact.
- Keep sample assets separate from live query data and label previews explicitly; invented prices must never be represented as live market data.
- Define all visual colors in global semantic CSS tokens; signal colors must remain consistent across every view.
