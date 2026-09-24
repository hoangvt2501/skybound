# Contributing

SKYBOUND is a browser game built from procedural pieces, so most changes are judged by how they look
and feel in flight and by what they cost per frame. This page says how to run it, how it is checked,
and what a change should bring with it.

## Run it

```
npm install
npm run dev        # Vite dev server
npm run build      # production build into dist/
npm run preview    # serve dist/ on 127.0.0.1:4173
```

Node 20 or newer. The showcase seed is `1207`; `?seed=<text>` on the URL picks another, `?fresh=1`
ignores the saved flight.

## Check it

```
npm run typecheck   # tsc
npm test            # Vitest: world generation, flight, wildlife, perches, bird poses, settings
npm run build
npm run test:e2e    # Playwright against the production build (about 15 minutes on software GL)
```

The e2e suite runs Chromium on SwiftShader, so it renders at a few frames per second; its waits
count simulated seconds, never wall-clock ones. Run `npx playwright install chromium` once.

CI runs typecheck, unit tests and the build on every pull request. The Playwright suite is a
manual job on the CI workflow (run it with the `e2e` input) because of its length.

## Rendering and simulation changes

Numbers from a real GPU matter more than the software-GL suite for anything that touches the frame:

- Measure before and after in one session, interleaved, against a served copy of the previous build.
  Absolute frame rates drift by several fps between sessions, so only an interleaved comparison is
  meaningful. Report fps, the late-frame ratio and GPU time percentiles, not averages of GPU samples.
- Compare screenshots of the same view, same time of day and same render scale. Photo mode (P)
  freezes the flight and captures a PNG with Enter.
- When something looks costlier than expected, hide one scene category at a time on both builds
  (clouds, full trees, ground cover, impostors, sky) and re-measure; the category whose absence removes
  the gap is the one to trim.
- Per-chunk instanced meshes are draw calls: a new tree species or variant adds one per chunk, and
  shadow casters add another, so prefer sharing geometry across species where the silhouette allows.
- A texture fetch or branch outside the rock, snow or water paths of the terrain shader is paid on
  every ground pixel.

## World generation changes

Heights, biome masks, landmark placement and vegetation placement come from `WorldGen` and are
deterministic per seed. Changing heights or placement invalidates saved flights: bump
`WORLD_GEN_VERSION` in `src/core/config.ts`. Colour-only changes do not need a bump.

## Pull requests

Use the pull request template: what changed for the player, how it was verified, and same-view
screenshots when the look changes. Keep logs, screenshots and probe scripts out of the repository.
