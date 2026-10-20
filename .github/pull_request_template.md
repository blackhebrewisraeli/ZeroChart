## Summary

<!-- What does this change, and why? Link any related issue. -->

## Changes

-

## How it was tested

<!-- Commands run, scenarios checked, screenshots for UI changes. -->

## Checklist

- [ ] Tests pass locally: `npx tsc --noEmit && npm run build && npm run lint && npm test`
- [ ] New or changed engine logic has a test that fails if the logic breaks
- [ ] No main-thread blocking: heavy math runs in the finance Web Worker
- [ ] Ledger changes go through the pure transitions in `portfolioAccounting.ts`
- [ ] Model changes are mirrored in `pine/zerochart_quant_hud.pine` (or not applicable)
- [ ] New tables have RLS enabled with owner-scoped policies (or not applicable)
- [ ] No secrets, service-role keys, or `.env` files committed
- [ ] UI verified in light and dark mode, and at phone width (or not applicable)
- [ ] Docs updated if behavior or setup changed
