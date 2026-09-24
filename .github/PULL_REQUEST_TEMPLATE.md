## What changes

<!-- One paragraph: what the player sees or what the code does differently, and why. -->

## How it was verified

- [ ] `npm run typecheck`
- [ ] `npm test` (Vitest)
- [ ] `npm run build`
- [ ] `npm run test:e2e` (Playwright, ~15 min on software GL)
- [ ] Rendering or simulation changes: interleaved before/after benchmark on a real GPU (fps, late-frame ratio, GPU time) and same-view screenshots
- [ ] World generation changes: `WORLD_GEN_VERSION` bumped in `src/core/config.ts` (old saves are dropped)

## Screenshots

<!-- Same view, before and after, when the look changes. Photo mode (P) captures a PNG. -->

## Notes for the reviewer

<!-- Trade-offs, things deliberately left out, follow-ups. -->
