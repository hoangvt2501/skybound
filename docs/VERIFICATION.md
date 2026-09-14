# Verification record

Last full pass: 2026-09-14 (chill update: Settings repair, frame pacing, soundscape, bird species, ambient wildlife), Windows 11 (10.0.26200), Node 24.13.1, npm 11.8.0. It supersedes the record for the visual overhaul (7efd524); the before/after evidence for that iteration stays in [VISUAL_UPGRADE.md](VISUAL_UPGRADE.md), and the chill update's own rationale, measurements and corrections are in [CHILL_UPDATE.md](CHILL_UPDATE.md).

## Automated checks

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | clean (exit 0) |
| Unit tests | `npm test` | 7 files, 49 tests passed |
| Production build | `npm run build` | `dist/` 190.8 kB app JS (63.7 kB gzip) + 519.4 kB three (129.8 kB gzip) + 19.0 kB worker (8.3 kB gzip) + 15.3 kB CSS (3.9 kB gzip) |
| Real-browser tests | `npm run test:e2e` | 11 passed (desktop: 6 interaction + 3 smoke; mobile emulation: 2), run on the final build |

### Unit tests (`tests/`)

- `world.test.ts`: same seed/coordinates → identical samples, biome weights and chunk meshes regardless of generation order (negative coordinates included); adjacent chunk edges match exactly at LOD0 and LOD2; coarser-LOD edge vertices coincide with every other finer vertex; height-grid interpolation reproduces the rendered triangles; the showcase region (seed 1207) contains all six land biome families plus ocean.
- `map.test.ts`: `worldToMap`/`mapToWorld` round trips with negative coordinates, north-up orientation, zoom-around-anchor, panning, click → waypoint → bearing, heading conventions, deterministic tile pixels with ocean pixels blue.
- `flight.test.ts`: identical flight state under 60 Hz, 30 Hz and irregular frame schedules; bounded catch-up after a 30 s pause; turning/banking/gliding; climb/dive/flap/boost energy; no tunnelling into a 1000 m wall at boost speed; obstacle cylinders push out without teleporting; safe recovery position; autopilot reaches a waypoint across the showcase range with ≥ 8 m clearance.
- `persistence.test.ts`: save validation and clamping; seed precedence; migration of older world versions; settings validation.
- `origin.test.ts`: floating-origin rebasing leaves global positions unchanged; 16 deterministic landmarks of 8 types inside the region, on land, ≥ 1 km apart.
- `chill-flight.test.ts` (new): the fixed-step clock captures the previous state before every step at 30/60/144 Hz so interpolation never jumps; water depth/exposure arrays computed in the worker match the terrain triangles; shared instance geometry is detached before disposal; old and invalid preferences (missing bird, wildlife or bus volumes) receive defaults; every bird model has finite transforms and distinct wingbeat rates; wind level stays bounded while boosting; habitat rules; wildlife population stays within budget through travel, origin rebasing and the off switch; **ducks exist near the opening position** and, with the same nearby set, later frames upload no instance data (GPU-side animation, ring-buffered rebuilds).
- `settings-panel.test.ts` (new, Happy DOM): the Settings dialog takes focus on open, applies bird/wildlife/volume changes immediately, closes on Escape and returns focus, and its stacking (z-index 60) is above the start and pause overlays (30).

### Browser tests (`e2e/`, production build served by `vite preview`, Chromium 153 headless with SwiftShader)

- `smoke.spec.ts` (desktop 1280×720): start → fly (climb, turn, flap, boost) → hard dive stays above terrain → R recovers → map pauses time, click places a waypoint, HUD bearing within 4° → teleport near a landmark discovers it (journal entry, map marker) → autopilot on, manual interrupt → save/reload restores seed, discoveries, waypoint and position → 12 simulated seconds of boost crosses chunk boundaries with zero console errors; `?seed=` precedence; HUD/minimap stay in view at three viewport sizes.
- `interaction.spec.ts` (desktop): scene free-look drag/keep/turn/V-reset; wheel targets the right surface; map drag/out-and-back/click/right-click; anchored wheel zoom, +/−, fit, center-on-bird, arrow keys, view persistence; no stuck input when the map opens mid-gesture and pause state is restored; camera and map correct after an origin rebase.
- `mobile.spec.ts` (Pixel 7 emulation, CDP touch): joystick turns/pitches and clears on release, Flap holds altitude, map button, simulation frozen while the map is open, drag does not move the bird; one-finger scene drag enters free-look without steering; pinch zooms without placing a waypoint; cancelled touch places none; clean tap does.

### Real-GPU interaction checks (Google Chrome stable, headless with GPU, scripted)

Run against the final build with `chillcheck.mjs`, `duckcheck.mjs` and `closeups.mjs` (session scripts, not part of the repository):

- Settings opened from the start screen renders above the start overlay (computed z-index 60 vs 30), the first control has focus, Escape closes it and the start screen is unchanged. At 390×640 the dialog body scrolls (card 608 px tall) with header and footer fixed.
- Settings opened from the in-flight button pauses the flight; Escape returns to flying. Opened from the pause menu it renders above the menu, the menu is hidden and inert, and Escape returns to the pause menu with focus on its Settings button.
- All four birds can be selected from the dialog and the model swaps in place (`debug().birdSpecies()` follows the selection); close-ups in `docs/screenshots/chill/bird-*.jpg`.
- Audio starts after the start gesture (`audio.started === true`); no console or page errors in any run.
- Wildlife in Lively mode at the opening position: 32 flock birds, 12 deer, 5–6 ducks; next to a pond 6–12 ducks (`docs/screenshots/chill/ducks.jpg`, `deer.jpg`, `flock.jpg`).

## Measured performance (real GPU)

Google Chrome stable (headless, GPU) on `ANGLE (Intel, Intel(R) UHD Graphics 770, Direct3D11)`, 1920×1080, medium preset, dynamic resolution off, seed 1207, fixed autopilot route, time of day fixed, 60 s per run. The machine receives intermittent external load that can halve the frame rate of a whole run, so only same-batch A/B runs are compared: the final build, then the previous commit (7efd524) rebuilt from a stash, then the final build again.

| Build | Avg fps | Avg frame | Per-frame p95 / p99 / max | Frames > 50 ms | EMA sampler avg fps |
| --- | --- | --- | --- | --- | --- |
| Final build (run 1) | 40.0 | 25.0 ms | 33.5 / 33.7 / 66.7 ms | 5 of 2418 | 43.0 |
| Previous commit 7efd524 | 41.7 | 24.0 ms | 33.5 / 33.6 / 50.5 ms | 4 of 2525 | 42.8 |
| Final build (run 2) | 42.8 | 23.4 ms | 33.5 / 33.6 / 50.2 ms | 1 of 2585 | 41.1 |

The chill update as delivered in the package measured 40.1 fps with 3 frames over 50 ms on the same route (`docs/perf/chill-medium.json`), and its wildlife layer was isolated as the source of periodic 50 ms frames (per-frame instance-buffer uploads; see CHILL_UPDATE.md). After moving the animation to the GPU, the final build is within run-to-run noise of the previous commit on both average and stall count. Draw calls: 225 vs 222 (three wildlife draws); triangles ≈ 2.41 M vs 2.40 M.

Raw logs: `docs/perf/final-medium.json`, `docs/perf/final2-medium.json`, `docs/perf/base2-medium.json` (per-frame) and `docs/perf/ema-final-medium.json`, `ema-final2-medium.json`, `ema-base2-medium.json` (EMA sampler); `docs/perf/chill-medium.json` and `ema-chill-medium.json` for the package as delivered. Earlier runs (`before-*`, `after-*`, `ema-noclouds/nodetail/plainveg`) belong to the visual overhaul.

Main-thread CPU attribution (in-page wrappers around each per-frame system, 30 s): renderer submit 1.4–1.6 ms, simulation 0.16–0.23 ms, clouds 0.05–0.08 ms, wildlife 0.05 ms, HUD 0.03 ms, chunk installs 0.02 ms, audio 0.01–0.02 ms per frame. The frame is GPU-bound at this resolution on this device.

## Screenshots

- `docs/screenshots/chill/`: Settings at desktop (1280×720) and phone (390×780) sizes, the four bird species at the same vantage, and wildlife close-ups (deer pair, ducks on a pond, a flock over the wetland) captured on the final build.
- `docs/screenshots/before/` and `docs/screenshots/after/`: the visual overhaul's eleven fixed vantages (see VISUAL_UPGRADE.md).
- `docs/screenshots/*.png` (top level): captures from the first release, kept as historical evidence of that build only.

## Not verified / limitations of this record

- One machine (integrated Intel GPU); Chromium-based browsers only (Chrome stable with GPU, Playwright Chromium with SwiftShader). Firefox and Safari were not run.
- Mobile behaviour through Chromium's Pixel 7 emulation only; no physical device.
- Audio output is not asserted automatically and was not listened to: the mix (wind, water, birdsong, pad chords, per-bus volumes) is verified only to start without errors and to stay within the compressor. Subjective balance may need adjustment after listening on speakers or headphones.
- Benchmarks are 60 s routes; no multi-hour soak. Absolute frame rates on this machine drift by several fps between batches because of external load, so only same-batch comparisons are meaningful.
