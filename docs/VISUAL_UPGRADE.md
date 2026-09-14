# Visual overhaul and mouse exploration

Iteration on the existing SKYBOUND project (baseline commit `e2ce585`). Goal: noticeably better scenery (mountains, trees, clouds, water, map) and reliable mouse exploration in both the 3D scene and the world map, without touching flight, collision, autopilot, streaming, persistence or mobile behaviour except where they had to follow.

Everything below was implemented and verified locally on the same machine, seed, route, viewport, time of day and quality preset. Nothing was published or pushed in this iteration.

## Baseline (what was wrong)

Fresh captures of `e2ce585` at fixed vantages (`docs/screenshots/before/`, seed 1207, time of day 07:26, medium preset, 1600×900):

- Mountains: a wall of repeated narrow spikes with smooth grey faces and a jagged snow band; no foothills, so the range rose straight out of a flat plain.
- Trees: broadleaf trees were three or four polygon balls on a stick, pines were stacked clean cones; one mesh per species, identical everywhere, hard cut-off of all vegetation at ~2 km.
- Ground: flat vertex-colored Lambert with no near-field texture or cover.
- Clouds: two horizontal textured planes (paper-thin, wallpaper repetition, hard intersection when crossing their altitude).
- Water: every lake outlined by a thick bright foam ring; the seabed showed through as a checkerboard.
- Map: 3D-style colors with per-pixel speckle, no coastline, contours at every zoom.
- Camera: left-drag orbited relative to the bird's heading and snapped back after 1.6 s.
- Map input: click vs drag decided by a 4 px threshold at the moment of the up event (no max-movement tracking), no pinch pan, no keyboard panning, no +/-/fit controls, no cursor feedback.

## What changed and why (by file)

### Scene free-look — `src/flight/CameraRig.ts`, `src/flight/Input.ts`, `src/core/App.ts`, `src/ui/HUD.ts`, `src/ui/HelpPanel.ts`, `src/ui/SettingsPanel.ts`, `src/persistence/Settings.ts`, `src/styles.css`

- The rig now keeps a world-space spherical orbit (azimuth, elevation, distance) around a bird-centered pivot. A left drag on the canvas enters free-look from the current chase direction (no jump); the chosen direction is kept after release and while the bird turns. Elevation is clamped to −16°…72° so the camera never inverts.
- Look-ahead blends to zero during free-look so the bird stays framed. Roll follow is disabled in free-look.
- **V** and an on-screen *Reset view* button (shown only while free-look is active) ease back behind the bird and re-enter chase. A new setting *Auto-center camera* (default off) restores delayed re-centering.
- Occlusion: the boom is shortened smoothly (fast in, slow out) when terrain, water or a large obstacle sits between the pivot and the camera; the camera is additionally clamped above the surface.
- All smoothing happens in global coordinates and is converted to render space last, so floating-origin rebasing never disturbs the view.
- Camera deltas are consumed whenever present (also when pointer-up lands between frames); `Input.clear()` now also drops pending camera deltas and releases pointer capture; the attract-mode orbit on the start screen is exited when the flight begins.
- Cursor feedback (`grab`/`grabbing`) and a one-time onboarding toast: "Drag to look around · Scroll to zoom · V to reset view".

### World map input — `src/map/WorldMap.ts`, `src/map/TileCache.ts`, `src/styles.css`

- Gesture model: pointer capture on the canvas; the **maximum** movement over the whole gesture decides click vs drag (`CLICK_THRESHOLD_PX = 6`), so dragging away and back is still a drag; multi-touch gestures can never place a waypoint; non-primary mouse buttons are ignored; `pointercancel`, `lostpointercapture`, window blur and overlay close all cancel the gesture and clear state.
- Wheel: delta modes normalized (pixels/lines/pages), per-event delta capped, zoom anchored under the pointer. Two fingers pan around their midpoint and pinch-zoom with a bounded per-move factor.
- Controls: **+ / −**, **Center on bird** (keeps zoom), **Fit region**, arrow-key panning and +/- when the map has focus (`tabindex=-1`, focused on open). View center and zoom persist across close/reopen.
- Labels never overlap (greedy placement); the active destination is drawn first, bold and highlighted. Loading tiles show a stable hatched placeholder; stale worker results are still discarded by request id.

### Mountains and terrain — `src/world/WorldGen.ts`, `src/world/chunkMesh.ts`, `src/world/TerrainMaterial.ts` (new), `src/world/ChunkManager.ts`, `src/workers/terrain.worker.ts`

- The massif is built from three scales: a broad base mass rising toward the spine core, dominant summits from a 2.4 km lattice (wide elliptical bases, per-summit height), medium ridged noise connecting them through a smooth-max (saddles), broad valleys, buttresses/gullies, and only then fine rock detail. Foothills grow toward the range so it rises out of broken ground instead of a flat field.
- Snow line raised to ~930 m (temperature dependent); snow is now decided per pixel from the interpolated normal (collects on shelves, sheds on faces), with exposure and a 16 m mottle so boundaries are irregular rather than a sawtooth band.
- `TerrainMaterial` extends MeshLambert with a fragment pass driven by a new per-vertex `aux` attribute (snow-altitude factor, rockiness, wetness, aridness): near/mid grain, per-pixel rock on steep faces with warped strata and two-octave cracks (red-tinted in the arid biome), wet banks near the water line. Detail fades with distance; the far shell uses the same material with detail off, so LOD tiers agree.
- Collision, height queries, map tiles and landmark placement all still sample the one `WorldGen`; chunk seams and LOD transitions are unchanged (unit-tested). `WORLD_GEN_VERSION` bumped 3→4.

### Trees and vegetation — `src/world/Vegetation.ts`, `src/world/chunkMesh.ts`, `src/world/ChunkManager.ts`, `src/core/config.ts`

- New builders: tapered leaning trunks, three to four visible main branches, crowns from noise-displaced leaf clusters merged by position for smooth normals (oak, birch, willow, shrub), jittered drooping tiers for pines, improved palms/cacti/deadwood. Two geometry variants each for oak and pine; a per-instance random drives crown displacement, stretch and wind phase in the vertex shader so no two trees read identical.
- Wind: anchored trunks, sway weighted by height squared, coherent world wind direction rotated into each instance.
- Distribution: denser woods with gradual edges, clearings from a 230 m noise field, lone trees and shrubs.
- LOD: full geometry in rings 0–1 (~1 km), crossed alpha-tested billboard impostors from a procedural per-species atlas out to ring 6 (~3.5 km), then fog. Ground cover (grass tufts on a small atlas, alpha-tested, distance-faded, wind-swayed) in LOD0 chunks only.
- Budgets: trees are placed at a **fixed** density on every preset (identical colliders everywhere); presets only scale ground cover and cloud puffs (`groundCover`, `cloudPuffs` in `QUALITY_PRESETS`).
- Shared geometry: per-chunk instanced meshes reference the shared vertex buffers and carry only their instance attributes.

### Clouds and sky — `src/atmosphere/Clouds.ts`

- Cumulus clusters: masses placed deterministically on a 2 km lattice (seeded, drifting with the wind), each 9–17 billboard puffs in a flattened ellipsoid with larger puffs in the middle. One InstancedMesh, sorted back-to-front per frame, puff color from height within the mass and sun-facing side (lit tops, shaded undersides), scene fog applied, near-camera fade so crossing a cloud never shows a hard plane. Budget per preset (360/700/1100 puffs).
- The old low sheet is gone; one thin high cirrus sheet (2.8 km) remains as distant haze.

### Water — `src/atmosphere/WaterMaterial.ts`, `src/world/ChunkManager.ts`

- Per-vertex `exposure` from the sampler's land-ness: open sea gets wind ripples and surf on shores, inland lakes are calm, slightly darker/greener, with a narrow wet edge instead of foam.
- Vertical wave displacement removed (it let the seabed poke through as a checkerboard); ripple frequencies lowered and distance-faded; shoreline alpha fades over the last 40 cm of depth so the terrain/water intersection is soft.

### Map presentation — `src/map/tileRaster.ts`, `src/world/biomes.ts`

- Cartographic palette separate from 3D styling: lowland/forest/upland/wetland/arid/alpine tints from biome weights and elevation only (no per-pixel speckle), lakes vs ocean distinguished, subtle NW hillshade, coastline stroke, faint contours only from zoom 2 (100 m) and zoom 4 (50 m), pale shoreline band. Legend swatches updated to match.

### Persistence — `src/persistence/Save.ts`, `src/core/App.ts`, `src/main.ts`

- Older saves are migrated instead of discarded: seed, x/z, time of day and flight state kept; discoveries, explored cells and waypoint reset; the bird is re-seated in validated clear air above the new terrain, and a notice is shown once.

### Tests — `e2e/interaction.spec.ts` (new), `e2e/mobile.spec.ts`, `tests/persistence.test.ts`, `tests/world.test.ts`

Real pointer sequences (see Results).

## Before / after comparisons

Same seed (1207), same positions and headings, same time of day (07:26, cycle off), same preset (medium), same viewport (1600×900), real GPU. `docs/screenshots/before/` vs `docs/screenshots/after/`:

| View | Before | After |
| --- | --- | --- |
| Opening valley | `before/01-opening.jpg` | `after/01-opening.jpg` |
| Low flight beside trees | `before/02-low-trees.jpg` | `after/02-low-trees.jpg` |
| Temperate woodland edge (added vantage) | — | `after/02b-forest.jpg` |
| Mountain, middle distance | `before/03-mountain-mid.jpg` | `after/03-mountain-mid.jpg` |
| Mountain rock/snow, close | `before/04-mountain-close.jpg` | `after/04-mountain-close.jpg` |
| Clouds from below / beside / above | `before/05..07-*.jpg` | `after/05..07-*.jpg` |
| Calm lake | `before/08-lake.jpg` | `after/08-lake.jpg` |
| Coastline | `before/09-coast.jpg` | `after/09-coast.jpg` |
| Map at region scale / closer | `before/10-map-region.jpg`, `before/11-map-zoom.jpg` | `after/10-map-region.jpg`, `after/11-map-zoom.jpg` |

Coordinates were preserved: the opening position is computed from the seed's macro layout (unchanged) and the terrain under it changed height only marginally, so the opening comparison is an exact A/B. The mountain vantages are relative to the first shrine landmark; the landmark set was re-placed on the new geography, so those two views are "same rule, new terrain" rather than the exact old spot. The other vantages are fixed world offsets from the opening position.

## Results

### Automated checks (final build)

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm test` (Vitest) | 34 passed (world determinism/seams, map projection, flight, persistence incl. migration, origin, landmarks) |
| `npm run build` | `dist/` 177 kB app JS (58.7 kB gzip) + 532 kB three + 18.8 kB worker + 13.5 kB CSS |
| `npm run test:e2e` (Playwright, production build) | 11 passed: 6 interaction, 3 smoke, 2 mobile |

### Interaction regressions (`e2e/interaction.spec.ts`, `e2e/mobile.spec.ts`, real pointer sequences)

- Left-drag orbits the bird (world-space azimuth changes by > 0.5 rad); the view is kept for 5 simulated seconds while the bird flies on (odometer +100 m); a keyboard turn during free-look changes the heading without moving the camera azimuth; V returns behind the bird.
- Dragging sets no flight input and the pointer state clears on release.
- Wheel over the scene changes camera distance; wheel over the map zooms the map and leaves the camera distance untouched.
- Map: a 200 px drag pans the content with the pointer (center shifts by exactly 200 px × m/px) and places no waypoint; a drag out and back to the start is still a drag; a sub-threshold click places the waypoint at the computed global coordinate (±0.5 m); a right click is ignored.
- Wheel zoom around an off-center pointer keeps the world point under the pointer fixed (±0.5 m); +/− and Fit region work; Center on bird keeps the zoom; arrow keys pan; the view survives close/reopen.
- Opening the map with W held and a drag in progress leaves no stuck input after closing; map gestures never move the camera; closing from pause returns to pause with simulation time frozen.
- After a 9 km teleport (origin rebase) the free-look azimuth is unchanged, the camera position is finite, and a map click resolves next to the bird.
- Touch: one-finger drag on empty canvas enters free-look without steering; a two-finger pinch zooms the map and places no waypoint; a cancelled touch places none; a clean tap does.

Two real defects surfaced only through these tests: the HUD root (and the fading start overlay) intercepted canvas mouse/wheel/touch input because `#ui > *` has ID specificity, and the start-screen attract orbit left free-look enabled at flight start. Both are fixed (`src/ui/HUD.ts`, `src/ui/StartScreen.ts`, `src/ui/TouchControls.ts`, `src/styles.css`, `src/core/App.ts`).

### Performance (same device, seed, route, viewport, time of day, preset)

Machine: Intel UHD Graphics 770 (integrated), Google Chrome stable headless with GPU, 1920×1080, dynamic resolution **off**, seed 1207, autopilot route from the opening position toward (6000, −6000), time of day fixed at 07:26, 60 s samples after a 3 s settle. Two methods:

1. **Like-for-like A/B** (`docs/perf/ema-before-medium.json`, `docs/perf/ema-after-medium.json`): the app's own frame-time EMA sampled every 500 ms, runnable on both builds. Baseline build was measured by stashing the change set, building and running the identical script minutes apart.

| Build | Avg fps | Avg frame | p95 frame (EMA) | Samples > 33 ms | Draw calls | Triangles |
| --- | --- | --- | --- | --- | --- | --- |
| Before (`e2ce585`) | 53.5 | 18.8 ms | 21.0 ms | 0 | 215 | 2.50 M |
| After | 43.8 | 23.0 ms | 28.8 ms | 0 | 222 | 2.40 M |

2. **Per-frame log** on the after build (`docs/perf/after-medium.json`): 2,400+ frames, average 22.9 ms (43.7 fps), p50 16.7 ms, p95 33.5 ms, max 33.8 ms, **0 frames over 50 ms** (no loading stalls on the route), heap 72 → 89 MB over the run. (A per-frame baseline was also recorded earlier in `docs/perf/before-medium.json`, but that run coincided with other load on the machine — 38 ms average, 261 stalls — and is not a fair comparison; the EMA A/B above is.)

Other presets, after build (EMA, 30 s): **low 60 fps** (vsync-locked, 16.7 ms), **high 46 fps** (21.8 ms).

So the overhaul costs about 4 ms per frame on this integrated GPU at medium/1080p with dynamic resolution disabled. Attribution runs (clouds off, terrain detail off, plain tree shader, 30 s each) each recovered only ~1.5 ms; the cost is spread across the new fragment work (per-pixel terrain detail, alpha-tested impostors and cover, sorted cloud sprites, water) rather than one feature. Triangle counts and draw calls are unchanged. With dynamic resolution on (the default) the renderer scales the pixel ratio to hold the frame budget; on a discrete GPU the difference is not expected to be visible.

Per-preset budgets now in `QUALITY_PRESETS`: detailed chunk radius 5/7/10, far shell 2/3/4 tiles, ground cover 0/0.6/1, cloud puffs 360/480/900, shadows off/on/on, max pixel ratio 1/1.5/2, fog 4.2/6.2/8.6 km. Tree density does not vary by preset.

### Not verified / remaining limitations

- Measured on one machine (integrated Intel GPU) and only in Chromium-based browsers; a discrete GPU and Firefox/Safari were not exercised.
- Mobile behaviour was verified through Chromium's Pixel 7 emulation, not a physical device.
- Tree impostor and full-geometry transitions are pops (softened by distance and fog), not cross-fades; impostors are crossed quads, so they thin out when seen from directly above.
- Clouds are sorted billboard sprites: convincing from below, beside and above and when crossing their altitude (near fade), but not a true volume; a very close puff is a soft fade.
- Terrain shading is procedural; there is no texture-based cliff detail. Rock strata are subtle by design.
- The near-field crown displacement leaves crowns slightly angular up close; the base geometry is smooth-shaded (verified: co-located vertex normals identical).
- Water still uses one global level (no rivers). Small ponds now render, but their shoreline fade depends on the 10.7 m water grid.
- The opening position is preserved exactly; the two mountain vantages follow the re-placed shrine landmark and are therefore "same rule, new terrain" comparisons.
