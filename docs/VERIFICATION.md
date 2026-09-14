# Verification record

Last full pass: 2026-09-14, Windows 11 (10.0.26200), Node 24.13.1, npm 11.8.0.

## Automated checks

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | clean (exit 0) |
| Unit tests | `npm test` | 5 files, 34 tests passed |
| Production build | `npm run build` | `dist/` 141.7 kB app JS (47.0 kB gzip) + 531.8 kB three (132.9 kB gzip) + 15.3 kB worker + 12.7 kB CSS |
| Real-browser tests | `npm run test:e2e` | 4 passed (desktop ×3, mobile emulation ×1), 3.3 min |

### What the unit tests cover (`tests/`)

- `world.test.ts`: same seed/coordinates → identical samples, biome weights and chunk meshes regardless of generation order (including negative coordinates); adjacent chunk edges match exactly at LOD0 and LOD2; coarser-LOD edge vertices coincide with every other finer vertex; height-grid interpolation reproduces the rendered triangles; the showcase region (seed 1207) contains all six land biome families plus ocean (temperate 45.9 %, alpine 5.8 %, coast 3.4 %, arid 8.8 %, wetland 5.1 %, upland 5.8 %, ocean 25.1 %; heights −48…1342 m; ~1.7 µs per sample).
- `map.test.ts`: `worldToMap`/`mapToWorld` round trips with negative coordinates, north-up orientation, zoom-around-anchor, panning, click → waypoint → bearing (45° check), heading conventions, deterministic tile pixels with ocean pixels blue.
- `flight.test.ts`: identical flight state under 60 Hz, 30 Hz and irregular frame schedules (bitwise for the fixed-step cases); bounded catch-up after a 30 s pause; turning/banking/gliding behaviour; climb/dive/flap/boost energy; no tunnelling into a 1000 m wall at boost speed with a bounded number of impacts; obstacle cylinders push out without teleporting; safe recovery position; autopilot reaches a waypoint across the showcase mountain range while keeping ≥ 8 m clearance.
- `persistence.test.ts`: save validation (malformed, wrong version, out-of-range), clamping, seed precedence (`?seed=` beats an unrelated save, matching seed restores, obsolete world version ignored), settings validation.
- `origin.test.ts`: floating-origin rebasing leaves global positions unchanged and render positions small; 16 deterministic landmarks of 8 types inside the region, on land, ≥ 1 km apart.

### What the browser tests cover (`e2e/`, production build served by `vite preview`, Chromium 153 headless with SwiftShader)

Desktop (1280×720):
1. Start screen → Start flying; W climbs and moves the bird; D turns clockwise (bank verified indirectly through heading change); Space flap; Shift boost drains the resource.
2. Hard dive keeps the bird above terrain and the impact handler slows it; R recovers to > 30 m clearance.
3. M opens the map (simulation time frozen while open), click places a waypoint, M closes, HUD bearing matches the computed bearing within 4°.
4. Teleport next to a landmark → "Discovered" toast → journal entry and map marker.
5. F engages autopilot; A interrupts it.
6. Save → reload → "Continue flying" → same seed, discoveries and waypoint, position within 400 m.
7. Boost + flap for 12 simulated seconds crosses several chunk boundaries with the player chunk loaded; zero console errors for the whole scenario.
8. `?seed=777` takes precedence over the existing save.
9. HUD and minimap stay inside the viewport at 900×600, 1600×900 and 700×1000.

Mobile emulation (Pixel 7, touch): joystick turns and pitches, releasing clears input, Flap button holds altitude, Map button opens the map, the simulation is frozen while open, dragging the map does not move the bird, Close returns to flight, no console errors.

Waits in these tests are expressed in simulated seconds (fixed-step clock), so they pass on slow software-GL machines. Note: a synthetic instantaneous drag followed by a tap within the browser's fling window is consumed by Chrome as "stop fling" and yields no click; the mobile test drags at a human pace for that reason (this is browser gesture behaviour, not app logic).

## Measured performance (real GPU)

Google Chrome (stable channel, headless new mode) on this machine's integrated GPU:
`ANGLE (Intel, Intel(R) UHD Graphics 770, Direct3D11)`, 1920×1080, dynamic resolution off, autopilot flying from the wetland coast toward the mountains, 30–70 s samples every 2 s (raw logs in `docs/perf-*.json`).

| Preset | Avg fps | Avg frame | Max frame (EMA) | Draw calls | Triangles | Loaded chunks / far tiles | JS heap |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Low | 60.0 (vsync) | 16.7 ms | 16.7 ms | 141–156 | 0.9–1.3 M | 99–116 / 25–30 | 43 → 61 MB |
| Medium | 57.5 | 17.7 ms | 18.6 ms | 198–213 | 1.7–2.1 M | 178–194 / 48–49 | 52 → 62 MB |
| High | 46.7 | 21.3 ms | 24.6 ms | 256–277 | 2.1–3.2 M | 353–389 / 79–88 | 68 → 81 MB |

Observations: the 60 fps target at 1080p medium is met on an integrated Intel GPU; high quality is GPU-bound there (~3 M triangles) and is expected to reach 60 fps on a discrete GPU. Chunk generation runs in 4 workers; after the streaming fixes the pending-job count stays at 0 in steady flight and heap growth over a 70 s flight was +20 MB with GC returning it. Chunk GPU uploads are budgeted (≤ 4 ms or 6 chunks per frame) so bursts after start/teleport do not stall single frames.

Earlier in the session a 6 fps reading was recorded; it was reproduced as machine load from a concurrent process (the same build measured 57.5 fps minutes later), not an app regression.

## Screenshots (`docs/screenshots/`)

- `desktop-opening-1080p-medium.png`: the opening scene at 1080p medium (wetland lakes below, forest, mountain range, cloud layer, HUD, minimap).
- `coast-morning.png`: coast/islands biome with tree shadows and shore foam.
- `canyon-bridge.png`, `stone-arch.png`, `mountain-shrine.png`, `giant-tree-night.png`, `lighthouse-dusk.png`: landmarks in the arid, alpine and temperate biomes, plus night and dusk lighting.
- `world-map-waypoint.png`, `world-map-discovered.png`: the full map framing the 32 km region with a waypoint line, and after a discovery (journal + label).
- `mobile-flight.png`, `mobile-map.png`: Pixel 7 layout with the virtual stick, Flap/Boost buttons and the map overlay.

## Not verified / limitations of this record

- No physical phone or tablet was available; mobile behaviour was verified through Chromium's Pixel 7 emulation only (touch events via CDP). 30 fps on real mobile hardware is a goal, not a measured result.
- Only Chromium-based browsers were exercised (Chrome stable with GPU, Playwright Chromium with SwiftShader). Firefox and Safari were not run.
- The extended-flight measurement was 70 s (medium) and 40 s (high/low) along one route from wetlands into temperate lowlands; a multi-hour soak was not run.
- Audio output was not asserted automatically (Web Audio graph creation is exercised; no waveform checks).
- Frame-rate figures are from one machine; results elsewhere will differ.
