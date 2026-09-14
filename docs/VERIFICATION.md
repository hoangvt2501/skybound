# Verification record

Last full pass: 2026-09-14 (visual overhaul + mouse exploration iteration), Windows 11 (10.0.26200), Node 24.13.1, npm 11.8.0. The previous record (first release) is superseded; the before/after evidence for this iteration is in [VISUAL_UPGRADE.md](VISUAL_UPGRADE.md).

## Automated checks

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | clean (exit 0) |
| Unit tests | `npm test` | 5 files, 34 tests passed |
| Production build | `npm run build` | `dist/` 177 kB app JS (58.7 kB gzip) + 532 kB three (132.9 kB gzip) + 18.8 kB worker + 13.5 kB CSS |
| Real-browser tests | `npm run test:e2e` | 11 passed (desktop: 6 interaction + 3 smoke; mobile emulation: 2) |

### Unit tests (`tests/`)

- `world.test.ts`: same seed/coordinates → identical samples, biome weights and chunk meshes regardless of generation order (negative coordinates included); adjacent chunk edges match exactly at LOD0 and LOD2; coarser-LOD edge vertices coincide with every other finer vertex; height-grid interpolation reproduces the rendered triangles; the showcase region (seed 1207) contains all six land biome families plus ocean (temperate 41 %, alpine 11 %, coast 3 %, arid 9 %, wetland 5 %, upland 6 %, ocean 25 %; heights −48…1229 m; ~1.9 µs per sample).
- `map.test.ts`: `worldToMap`/`mapToWorld` round trips with negative coordinates, north-up orientation, zoom-around-anchor, panning, click → waypoint → bearing, heading conventions, deterministic tile pixels with ocean pixels blue.
- `flight.test.ts`: identical flight state under 60 Hz, 30 Hz and irregular frame schedules; bounded catch-up after a 30 s pause; turning/banking/gliding; climb/dive/flap/boost energy; no tunnelling into a 1000 m wall at boost speed; obstacle cylinders push out without teleporting; safe recovery position; autopilot reaches a waypoint across the showcase range with ≥ 8 m clearance.
- `persistence.test.ts`: save validation and clamping; seed precedence; **migration** of older world versions (seed and x/z kept, geography-bound progress reset, newer-version saves rejected); settings validation.
- `origin.test.ts`: floating-origin rebasing leaves global positions unchanged; 16 deterministic landmarks of 8 types inside the region, on land, ≥ 1 km apart.

### Browser tests (`e2e/`, production build served by `vite preview`, Chromium 153 headless with SwiftShader)

- `smoke.spec.ts` (desktop 1280×720): start → fly (climb, turn, flap, boost) → hard dive stays above terrain → R recovers → map pauses time, click places a waypoint, HUD bearing within 4° → teleport near a landmark discovers it (journal entry, map marker) → autopilot on, manual interrupt → save/reload restores seed, discoveries, waypoint and position → 12 simulated seconds of boost crosses chunk boundaries with zero console errors; `?seed=` precedence; HUD/minimap stay in view at three viewport sizes.
- `interaction.spec.ts` (desktop): scene free-look drag/keep/turn/V-reset; wheel targets the right surface; map drag/out-and-back/click/right-click; anchored wheel zoom, +/−, fit, center-on-bird, arrow keys, view persistence; no stuck input when the map opens mid-gesture and pause state is restored; camera and map correct after an origin rebase.
- `mobile.spec.ts` (Pixel 7 emulation, CDP touch): joystick turns/pitches and clears on release, Flap holds altitude, map button, simulation frozen while the map is open, drag does not move the bird; one-finger scene drag enters free-look without steering; pinch zooms without placing a waypoint; cancelled touch places none; clean tap does.

Waits are expressed in simulated seconds so the suite passes on slow software-GL machines. Known Chrome behaviour encoded in the mobile test: a tap that lands inside the fling window of an instantaneous synthetic flick is consumed as "stop fling" and produces no click, so the test drags at a human pace before tapping.

## Measured performance (real GPU)

Google Chrome stable (headless, GPU) on `ANGLE (Intel, Intel(R) UHD Graphics 770, Direct3D11)`, 1920×1080, dynamic resolution off, seed 1207, fixed autopilot route, time of day fixed. Full method and before/after tables: [VISUAL_UPGRADE.md § Performance](VISUAL_UPGRADE.md#performance-same-device-seed-route-viewport-time-of-day-preset). Summary of the final build:

| Preset | Avg fps | Avg frame | Notes |
| --- | --- | --- | --- |
| Low | 60 (vsync) | 16.7 ms | 132 draw calls, ~1.1 M triangles |
| Medium | 43.8 | 23.0 ms (p95 EMA 28.8 ms; per-frame p95 33.5 ms, 0 frames > 50 ms) | baseline build on the same route: 53.5 fps / 18.8 ms |
| High | 46 | 21.8 ms | 271 draw calls, ~2.2 M triangles |

Raw logs: `docs/perf/ema-before-medium.json`, `docs/perf/ema-after-medium.json`, `docs/perf/after-medium.json` (per-frame), `docs/perf/ema-after-low.json`, `docs/perf/ema-after-high.json`, plus attribution runs (`ema-noclouds/nodetail/plainveg`).

## Screenshots

- `docs/screenshots/before/` and `docs/screenshots/after/`: eleven fixed vantages (opening, low trees, woodland edge [after only], mountain mid/close, clouds below/beside/above, lake, coast, map region/zoom) captured with the same seed, positions, headings, time of day, preset and viewport. See the comparison table in VISUAL_UPGRADE.md.
- `docs/screenshots/*.png` (top level): captures from the first release, kept as historical evidence of that build only.

## Not verified / limitations of this record

- One machine (integrated Intel GPU); Chromium-based browsers only (Chrome stable with GPU, Playwright Chromium with SwiftShader). Firefox and Safari were not run.
- Mobile behaviour through Chromium's Pixel 7 emulation only; no physical device.
- Benchmarks are 60 s routes; no multi-hour soak.
- Audio output is not asserted automatically.
