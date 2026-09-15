# SKYBOUND

**Play it: [hoangvt2501.github.io/skybound](https://hoangvt2501.github.io/skybound/)** · Source: [github.com/hoangvt2501/skybound](https://github.com/hoangvt2501/skybound)

A browser-based 3D bird-flight exploration game. Take off, steer a bird with real inertia and banked turns over a 32 km × 32 km hand-shaped procedural region, discover landmarks, open a real map, set a waypoint and fly there. Or switch on autopilot and just watch.

Built with TypeScript, Vite and Three.js (WebGL2). No accounts, no backend, no external assets: every mountain, lake, tree, landmark and sound is generated on your machine from a seed.

Inspired by [fly-with-me](https://github.com/kunchenguid/fly-with-me) by Kun Chen (MIT). SKYBOUND is an independent implementation; see [Attribution](#attribution).

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
```

Other commands:

| Command | What it does |
| --- | --- |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve `dist/` at http://127.0.0.1:4173 |
| `npm run typecheck` | `tsc --noEmit` over the whole project |
| `npm run test` | Vitest unit tests (world determinism, seams, map projection, flight, saves, origin) |
| `npm run test:e2e` | Playwright real-browser smoke tests (builds and serves `dist/` first) |
| `npm run check` | typecheck + unit tests + build |

Requirements: Node 20+ and a browser with WebGL2. For `test:e2e`, run `npx playwright install chromium` once.

Open `?seed=<number or text>` to fly a specific world. `?seed=…&fresh=1` discards the local save.

## Controls

| Input | Action |
| --- | --- |
| **W / ↑** · **S / ↓** | Climb · descend (invertible in Settings) |
| **A / ←** · **D / →** | Turn left · right (the bird banks into the turn) |
| **Space** (hold) | Flap: extra lift and thrust |
| **Shift** (hold) | Boost: limited resource shown under the speed readout, recovers after a short delay |
| **X** | Air brake |
| **Left mouse drag** | Look around the bird: a 360° spherical orbit around the bird that starts from the view on screen and is kept after release (does not steer, does not cancel autopilot); 0.2° per pixel at the default sensitivity |
| **Mouse wheel** | Camera distance |
| **V** (or the on-screen *Reset view* button) | Smoothly return behind the bird and resume chase behaviour |
| **C** | Chase ↔ cinematic camera |
| **F** | Autopilot on/off (any manual input takes control back) |
| **M** | World map (pauses the flight) |
| **R** | Recover to a validated safe airborne position nearby |
| **H** | Controls help |
| **P** | Photo mode: the flight pauses, the HUD hides, drag and wheel frame the shot, sliders set the lens and the time of day, Enter saves a PNG, Esc returns |
| **Esc** | Close the active overlay (map, help, Settings, photo mode), otherwise pause/resume |
| **Settings** button (bottom-left) | Open Settings during flight; the flight pauses and resumes when it closes |
| **F3** | Developer overlay |

No input = the bird keeps gliding with gentle drag and slow altitude loss. Diving gains speed; climbing costs it.

**Touch devices**: left virtual stick (turn/climb), right-side **Flap** and **Boost** buttons, top-left buttons for Map, Autopilot, Camera, Recover and Pause. Drag on empty canvas to look around the bird, pinch to change distance.

**World map** (M or the minimap): left-drag pans (the view is kept when you close and reopen), a short click (under 6 px of movement) places the waypoint or selects a discovered landmark, wheel/trackpad zoom is anchored under the pointer, **+ / −** zoom, **Center on bird** keeps the zoom, **Fit region** frames the 32 km region, arrow keys pan while the map has focus. One finger pans on touch, two fingers pinch-zoom around their midpoint; a pinch never places a waypoint. Flight stays paused while the map is open, and closing returns to the state you came from (paused or flying).

Settings has an **Auto-center camera** toggle (off by default) that eases the view back behind the bird after a short idle time, and a **Same handling for every bird** toggle for players who want a different look without relearning the feel: with it on, every species flies with the default profile and only the silhouette, colours and wingbeat change.

**Photo mode** (P, or the camera button on touch) freezes the flight and the time of day, hides the HUD and lets you frame a shot: drag to orbit, wheel for distance, a lens slider from 18° to 100°, a time-of-day slider, a hide-the-bird toggle. Enter (or the Capture button) saves a PNG of the current frame at the rendered resolution; Esc returns to the flight exactly where it paused.

**Settings** (from the start screen, the pause menu or the in-flight button) is a scrollable dialog that always sits above the other overlays: it takes focus when it opens, Tab stays inside it, Esc closes it and focus returns to the control that opened it. It holds the bird picker (four illustrated cards: **Eagle**, **Gull**, **Swallow**, **Owl**, each with its own silhouette, colours, wingbeat and handling: speed, agility, glide and flap power differ by up to about a third, the controls stay the same), the music style (**Sunny stroll**, **Meadow waltz**, **Island breeze**, **Calm pad**, **Off**: procedural tunes that start playing the moment you pick one), the soundscape mixer (master, nature & wind, music, wings & discoveries, mute), the ambient life density (**Off**, **Subtle**, **Lively**) and the **Changing skies** toggle.

## What is in the world

- A 32 km × 32 km curated region (an island continent) centered on the origin, with deterministic terrain continuing beyond it (outer continents and islands).
- Six biome families with smooth transitions driven by elevation, temperature, moisture and shoreline distance: temperate forest & meadow, alpine mountains with elevation-based snow, coast/ocean/islands, arid plateau & canyons, wetlands & lakes, flowering uplands.
- 15 deterministic landmarks of 8 types (stone arch, lighthouse, cliffside ruins, giant tree, mountain shrine, canyon bridge, standing stones, watchtower), each with a stable id, name, position, colliders and a discovery radius. Discovery adds them to the journal and the map.
- Water at global sea level (lakes are inland basins below sea level, coast and islands). Rivers are intentionally not shipped: coastlines and lakes first.
- A mist valley between the wetland coast and the mountain spine: a 1 km wide floor that climbs gently toward the spine between two flanks 500-600 m tall, a long lake on the floor, low fog banks that thicken at dawn and dusk, and sun rays that slant between the flanks when the sun sits low along the valley. Inside the valley the fog closes in and takes a cool tint.
- Rising air you can feel: thermals over sun-warmed meadows, uplands and arid ground during the day, and ridge lift on slopes that face the prevailing wind. Both add vertical speed to the bird; a thermal is hinted by warm dust motes spiralling up its core and by flocks circling inside it, and the HUD shows a lift pill with a soft variometer chirp when you are in one. No mission rings.
- Day/night cycle with sun, moon and stars, cumulus clusters built from sorted billboard puffs (lit tops, shaded undersides) under a thin cirrus sheet, distance fog matched to the sky, animated water: a rolling swell with whitecaps on the open sea, surf only on exposed shores, calm lakes. Water is not a wall: a shallow pass skims the surface with spray, ripple rings and a hiss, a steep dive plunges under, sheds speed and pops back up under buoyancy, each with its own splash sound; shoals of fish leap near the bird.
- A procedural Web Audio soundscape with separate buses: a bright, gusting band of air plus a low rush that only grows with speed, soft wingbeats, water that fades in near shores and lakes, sparse daytime birdsong, and a music box that composes short cheerful tunes on the fly (major keys, pentatonic melodies, four-chord loops, plucked or mallet leads, light percussion) in three styles plus a calm pad. No audio files are shipped.
- Ambient life: small flocks circling over the land, deer resting in meadows and uplands, ducks swimming on ponds, hot-air balloons drifting above gentle country, sailboats on open water and leaping fish on any water deeper than a few metres. Encounters are deterministic per seed, prepared one habitat per frame, animated on the GPU, purely decorative (no colliders), and capped per density setting. Animals notice the bird: a flock bursts outward and closes up again when you fly through it, deer lift their heads and trot off when you pass low, ducks paddle away and leave ripples. Reactions are planned per group on a quarter-second tick (a few groups at a time, with a cooldown, run paths checked against the terrain so nothing runs into a hill or onto the shore) and played on the GPU, so they cost no per-frame work.
- Wildflower patches (poppies, daisies, lupines) on meadows and uplands, boulders on alpine, arid and upland slopes, and slowly changing skies: haze and cloud cover drift over minutes so the same route never looks quite the same.
- Terrain shading is procedural per pixel: rock on steep faces with strata and cracks, snow that collects on shelves, wet banks, distance-aware grain (the noise comes from one baked, mipmapped texture rather than sine hashes per pixel). Trees have trunks, branches and layered crowns within about 700 m of the bird, billboard impostors further out, and grass tufts in the near field; trees are placed at a fixed density on every preset so collision is identical, and their shadows are cast by 30-triangle stand-ins rather than the full crowns. Vegetation and impostors dissolve in and out over 0.7 s (a screen-door fade) instead of popping, terrain chunks geomorph between detail levels over 0.6 s (each vertex carries the coarser surface it came from, and collision follows the blended surface), the coarsest chunks rise out of the far shell the same way, and chunks are requested ahead along the flight direction so the detailed tier is usually in place before it comes into view.

Every seed gives a different island with the same geographic structure (a mountain spine, an arid quarter, a wetland coast, an upland quarter), so all six biomes are always reachable. The showcase seed is `1207`.

## Architecture

```text
src/
  main.ts                 boot: WebGL2 check, URL seed, save/settings load, App
  core/
    App.ts                renderer, scene, fixed-step loop, phases, overlays, persistence
    Clock.ts              fixed timestep accumulator with bounded catch-up
    Navigation.ts         waypoint, discoveries, explored cells
    config.ts             all tuning: world scale, LOD rings, flight, camera, autopilot, quality presets
  flight/
    FlightController.ts   arcade flight model + swept collision (pure TS, unit-tested)
    Autopilot.ts          terrain look-ahead, waypoint guidance, spiral climb, loiter
    CameraRig.ts          chase/cinematic camera, orbit, clearance, roll follow
    Bird.ts               procedural articulated bird (3-segment wings, primaries, tail)
    Input.ts              keyboard/mouse/touch input with stuck-key protection
  world/
    WorldGen.ts           THE authoritative sampler: height, climate, biome weights, color, vegetation
    chunkMesh.ts          chunk/far-tile mesh builders (with skirts) + exact triangle interpolation
    ChunkManager.ts       streaming, LOD, worker jobs, water, instanced trees, obstacle queries
    Landmarks.ts          landmark placement, geometry, colliders, discovery
    Vegetation.ts         8 procedural species geometries
    Origin.ts             floating origin (render offset), global coords never change
    noise.ts / biomes.ts / coords.ts
  atmosphere/             DayCycle, Sky dome, Clouds, WaterMaterial, Audio
  map/
    projection.ts         worldToMap / mapToWorld (unit-tested)
    tileRaster.ts         map tile pixels from WorldGen (runs in the worker)
    TileCache.ts          bounded LRU of tiles with coarser fallbacks
    Minimap.ts / WorldMap.ts
  workers/                terrain.worker.ts (chunks, far tiles, map tiles), WorkerPool.ts
  persistence/            Save.ts (versioned + validated), Settings.ts, Storage.ts
  ui/                     StartScreen, HUD, PauseMenu, SettingsPanel, HelpPanel, DevOverlay, TouchControls
tests/                    Vitest
e2e/                      Playwright
```

Key design points:

- **One world-data service.** `WorldGen.sample()` is the only source of terrain height, water, biome and color. Rendered chunks, the far shell, map tiles, landmark placement, vegetation, autopilot look-ahead and collision all sample it (directly or via the chunk height grid), so they always agree.
- **Collision uses the rendered surface.** `ChunkManager.heightAt` interpolates the exact triangle of the loaded chunk (same diagonal as the index buffer). Outside loaded chunks it falls back to the analytic sampler.
- **Fixed simulation step** (60 Hz) with bounded catch-up (max 6 steps/frame, 0.25 s accumulated) and interpolation for rendering. Movement, animation and resource recovery do not depend on display frame rate.
- **Streaming.** 512 m chunks; LOD by Chebyshev ring (4 m → 8 m → 16 m → 32 m vertex spacing) with skirts for crack-free transitions and one ring of hysteresis. Vegetation (instanced) for the two nearest LODs. A far shell of 4096 m tiles (64 m spacing, offset −14 m) extends silhouettes several km beyond the detailed radius; fog hides the boundary. Jobs run in a worker pool with a bounded priority queue that favors chunks ahead of the bird; stale results and evicted jobs are handled explicitly.
- **Floating origin.** The world group is offset by `-origin`; rebasing happens every ~6 km. Global coordinates are used for saves, maps, generation and navigation; only render positions shift.
- **Map.** Canvas 2D tiles (256 px, 128 → 2 m/px) rasterized from `WorldGen` in the worker, cached in a bounded LRU with coarser fallbacks. Minimap is north-up with a rotating marker; the world map pans/zooms/pinches, frames the region initially, shows coordinates, legend, journal, and places one active waypoint. Undiscovered landmarks are hidden; unexplored cells are muted.

## World and map conventions

- 1 unit = 1 meter. **+X east, −Z north, +Y up.** Sea level is y = 0.
- Heading is a compass angle in radians: 0 = north, π/2 = east (clockwise). The HUD shows degrees.
- Global position is authoritative; render position = global − origin.
- Chunk (cx, cz) covers `[cx·512, (cx+1)·512) × [cz·512, (cz+1)·512)`.
- Map tile (zoom, tx, tz) covers `tx·size … (tx+1)·size` where `size = TILE_MPP[zoom] · 256`; pixel rows increase with +Z so north is up when drawn directly.
- Explored cells are 500 m; waypoint arrival is within 110 m horizontally and less than 450 m above the spot.
- Altitude readouts: "m above ground" is height over terrain or water under the bird; "m above sea" is global y.

## Configuration

Everything tunable is in `src/core/config.ts`:

- `QUALITY_PRESETS` (low / medium / high): chunk radius, far-shell radius, vegetation density, shadows, clouds, max pixel ratio, fog distance, worker job concurrency.
- `FLIGHT`: cruise/max/boost speeds, drag, gravity gain, pitch/turn/bank rates, boost capacity and recovery, ground clearance, sweep step.
- `CAMERA`, `AUTOPILOT`, `LOD_SPACING`, `LOD_RINGS`, `CHUNK_SIZE`, `FAR_TILE_*`, `DAY_LENGTH_SECONDS`, `SHOWCASE_SEED`, `WORLD_GEN_VERSION` (bump it when generation changes so old saves are not restored at a wrong place).

Settings (bird species, music style, ambient life density, changing skies, quality, invert vertical, sensitivity, reduced motion, master/nature/music/effects volume and mute, dynamic resolution, dev overlay, day/night cycle) live in the in-game Settings panel and persist in `localStorage`. Dynamic resolution only changes the render pixel ratio, never geography or physics.

## Persistence

A versioned save (`skybound.save.v1`) holds seed, world-generation version, global position/orientation/speed, time of day, autopilot/camera state, discoveries, explored cells and the waypoint. It is validated field by field; malformed or obsolete data is ignored and the player is restored above safe terrain. Saves happen every 5 s while flying (when something changed), on pause, map open, tab hide and page hide.

A `?seed=` URL wins over an unrelated save. Sharing a seed shares the world, not your progress. **New world…** and **Reset progress…** are explicit actions with confirmation.

When terrain generation changes, `WORLD_GEN_VERSION` is bumped and an older save is **migrated** instead of discarded: the seed, horizontal position, time of day and settings are kept, the bird is re-seated in validated clear air above the new terrain, and geography-bound progress (discoveries, explored cells, waypoint) is reset with an on-screen notice.

## Deployment (static hosting)

`npm run build` produces a self-contained static site in `dist/` (relative asset paths, so it works from any folder or sub-path).

- **GitHub Pages**: the included workflow `.github/workflows/pages.yml` builds with `SKYBOUND_BASE=/<repo>/` and publishes `dist/`. Enable Pages → Source: GitHub Actions.
- **Netlify** / **Vercel**: `netlify.toml` and `vercel.json` are included (build `npm run build`, publish `dist`).
- **Any static host**: upload `dist/`. To host under a sub-path with absolute URLs set `SKYBOUND_BASE=/sub/path/ npm run build`.

The app uses module workers (`type: 'module'`), which every current browser supports.

## Verification

Every change is checked three ways before it is deployed: `npm run typecheck` and `npm test` (Vitest: world generation determinism, chunk edges, map transforms, flight model, persistence and migration, floating origin, settings dialog, bird profiles, ambient life and its reactions, scenery rules, water contact, thermals and ridge lift, terrain geomorph data) run in the GitHub Pages workflow before every build; `npm run test:e2e` (Playwright: desktop smoke and interaction flows, Pixel 7 touch emulation) and real-GPU benchmarks on a fixed autopilot route are run locally on an integrated Intel GPU. Frame times, attribution runs and screenshots from those checks live in the commit messages rather than in the repository.

Performance note: the frame is GPU bound on integrated GPUs (measured with `EXT_disjoint_timer_query_webgl2`: terrain, trees and the shadow pass are the three big items). Adaptive resolution (on by default) counts missed display refreshes and settles at the highest render scale that keeps every frame inside one refresh. The scene renders into a multisampled target of the scaled size and is upsampled onto the full-size canvas, so a scale change resizes that target (about a millisecond) instead of the browser's swap chain (20-40 ms), and the controller can step in increments of 0.05 without hitching. The HUD is HTML and stays sharp at every scale. Turning adaptive resolution off pins the scale at the preset cap.

## Limitations

- Water is a single global level: no rivers, no elevated lakes yet. The swell is visual only: flight contact uses the flat surface.
- The procedural music is composed from rules, not authored; it will not sound like a recorded soundtrack.
- Full tree geometry switches to billboard impostors at about 700 m and impostors end at ~3.5 km; the switches are dissolved over 0.7 s. Terrain detail levels geomorph, but vertex colours are not morphed, so a faint colour shift can still be seen at a ring boundary on strongly mottled ground.
- Cloud puffs are camera-facing sprites: convincing from below, beside and above, but a cloud seen from very close is a soft fade rather than a true volume.
- Distant terrain (far shell) is coarse and deliberately sunk 14 m; where the detailed tier is still loading, the far shell shows through briefly, then the detailed chunk morphs up out of it.
- Shadows cover a ±220 m box around the bird only, and tree shadows are cast by simplified stand-ins (a trunk and a crown blob per tree), so a shadow does not show individual branches.
- WebGPU is not used; the renderer is WebGL2 only.
- No gamepad support yet.
- Ambient animals, balloons and boats are low-poly instanced decorations on fixed circles with scripted reactions, not autonomous agents (no pathfinding, no flocking between groups); "changing skies" varies haze and cloud cover but there is no rain or ring course. The wind is a fixed direction used for lift, trees and clouds, not a simulated field.

## Attribution

- Reference project: [fly-with-me](https://github.com/kunchenguid/fly-with-me) by Kun Chen, MIT License, inspected at revision `38857e64e1ab684e74361769f842b2e12180e45e` (2026-09-13). Its README, VISION and engine notes informed the product direction (automatic flight, an infinite seeded world, terrain look-ahead along the turning arc, one CPU heightfield as the terrain truth). No code or assets were copied; SKYBOUND is an independent implementation with a different feature set (precise player control, a curated 32 km region with six biome families, a real map and waypoints, landmarks and persistence).
- [Three.js](https://threejs.org) (MIT).
- Simplex noise follows the public-domain algorithm by Stefan Gustavson; the implementation in `src/world/noise.ts` is original.

License: MIT (see `LICENSE`).
