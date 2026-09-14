# Verification record

Last full pass: 2026-09-14 (cheerful update: procedural music, bird picker with portraits and flight profiles, rebuilt bird models, wildflowers, boulders, balloons, sailboats, changing skies), Windows 11 (10.0.26200), Node 24.13.1, npm 11.8.0. It supersedes the chill-update record (e34279f). The rationale for this iteration is in [CHEERFUL_UPDATE.md](CHEERFUL_UPDATE.md); earlier iterations keep their own documents ([CHILL_UPDATE.md](CHILL_UPDATE.md), [VISUAL_UPGRADE.md](VISUAL_UPGRADE.md)).

## Automated checks

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | clean (exit 0) |
| Unit tests | `npm test` | 8 files, 55 tests passed in 2.5 s |
| Production build | `npm run build` | `dist/` 215.5 kB app JS (72.3 kB gzip) + 520.7 kB three (130.3 kB gzip) + 19.3 kB worker (8.4 kB gzip) + 16.7 kB CSS (4.2 kB gzip) |
| Real-browser tests | `npm run test:e2e` | 11 passed on the final build (desktop: 6 interaction + 3 smoke; mobile emulation: 2) |

The e2e specs now ignore one console message that headless Chromium emits when it has no audio output device and the machine is loaded ("The AudioContext encountered an error from the audio device or the WebAudio renderer"); it is produced by the browser, not the app, and appeared once during a run that shared the CPU with a unit-test run. With the filter, the smoke spec passed again on its own (3 of 3, 7.6 min under SwiftShader).

### Unit tests (`tests/`)

- `world.test.ts`, `map.test.ts`, `flight.test.ts`, `persistence.test.ts`, `origin.test.ts`: unchanged coverage of generation determinism, chunk edges, map transforms, flight model, saves and migration, floating origin and landmarks.
- `chill-flight.test.ts`: interpolation at 30/60/144 Hz, worker water arrays, geometry disposal, preference validation (now including the music style, the new music default and the `skyMoods` flag), bird models with finite transforms, wind bounds, habitats, wildlife budgets (five kinds), ducks near the opening position, GPU-side animation with no per-frame uploads, ring-buffered rebuilds.
- `settings-panel.test.ts` (Happy DOM): stacking above the pause overlay, accessible modal with focus inside, Escape handled locally, the bird picker (four cards, default selection, one change per click, `aria-checked`, no event on re-click, portraits attach to cards), volume labels, focus wrap and return.
- `cheerful.test.ts` (new): species profiles stay within 0.8–1.4× and traits are 1–5 dots; `tuneFlight` with the default profile equals the shared constants; the swallow turns more than 20 % faster than the eagle, the eagle glides flatter than the swallow, the gull cruises faster than the eagle (simulated with the real controller); five music styles and setting validation; boulders registered as the ninth species with collider and impostor tile, and present on a known alpine slope; wildflower kinds only in meadow patches; balloons near the opening position and sailboats on the open sea within budget.

### Browser tests (`e2e/`, production build served by `vite preview`, Chromium 153 headless with SwiftShader)

Unchanged scenarios: start → fly → dive/recover → map and waypoint → discovery → autopilot → save/reload → boost across chunk boundaries; `?seed=` precedence; resized layouts; free-look and map gesture model; pause state restoration; origin rebase; touch layout and gestures on a Pixel 7 emulation.

### Real-GPU checks (Google Chrome stable, headless with GPU, scripted; session scripts not in the repository)

- **Music preview flow** (`musicflow.mjs`): on the start screen, picking a style starts the audio context and the music box (`debug().musicStyle()` follows); pausing suspends; picking a style from the pause menu resumes for the preview and closing the dialog suspends again; Off and Calm switch; the choice persists in `localStorage`. Live master-bus level with Sunny stroll at cruise: RMS 0.004, peak 0.037 before the master gain.
- **Offline music analysis** (`musiccheck.mjs`, 20 s per style rendered with `OfflineAudioContext`, stepped with `suspend/resume` so voices release as in real time): note onsets 2.45/s (Sunny), 1.8/s (Waltz), 1.75/s (Island); envelope autocorrelation peaks at 0.55 s, 0.42 s and 0.64 s (≈110, 143 and 94 BPM, matching the style tempos); spectral centroids 760, 357 and 730 Hz; the Calm pad has no onsets and a 217 Hz centroid; peaks 0.04–0.06 at the bus, no clipping. Spectrograms show regular note columns with harmonic stacks. Not listened to by a person.
- **Bird picker** (`pickercheck.mjs`): four cards with rendered portraits (`data:` PNGs, `has-portrait`), eagle selected and focused on open, click plus two ArrowRight presses select the owl, the flight controller's tuned cruise speed becomes 29.24 m/s (0.86×) and its turn rate 1.55 rad/s, and after six seconds of flight the owl settles at 30.1 m/s. Phone-width layout stacks the cards.
- **Bird models** (`birdshots.mjs`): the four species captured in glide and mid-flap with no console errors; 2.18 M triangles in the scene at high.
- **Scenery** (`scenerycheck.mjs`): no shader or console errors with the new species, cover atlas and wildlife kinds; ambient counts at the opening position 32 flock birds, 12 deer, 3 ducks, 3 balloons; on the open sea 4 sailboats and 16 ducks; a balloon and a sailboat located from the live instance buffers and captured; the sky-mood state drifts continuously (haze 0.839→0.836, cloudiness 0.531→0.514 over 12 s) and the "Changing skies" switch restores the preset fog distance (8600 m) immediately.

## Measured performance (real GPU)

Google Chrome stable (headless, GPU) on `ANGLE (Intel, Intel(R) UHD Graphics 770, Direct3D11)`, 1920×1080, medium preset, dynamic resolution off, seed 1207, fixed autopilot route, time of day fixed, 60 s per run. Same-batch A/B: the final build, then the previous commit (e34279f) rebuilt from a stash, then the final build again.

| Build | Avg fps | Avg frame | Per-frame p95 / p99 / max | Frames > 50 ms | Draw calls | EMA sampler avg fps |
| --- | --- | --- | --- | --- | --- | --- |
| Final build (run 1) | 44.3 | 22.6 ms | 34.3 / 34.4 / 34.9 ms | 0 of 2678 | 234–309 | 44.7 |
| Previous commit e34279f | 44.8 | 22.3 ms | 34.3 / 34.4 / 34.7 ms | 0 of 2707 | 198–248 | 44.8 |
| Final build (run 2) | 44.7 | 22.4 ms | 34.3 / 34.4 / 34.9 ms | 0 of 2700 | 235–309 | 44.8 |

The extra draw calls (boulder instances per chunk, flower cover, two more ambient kinds) and the more detailed bird model cost nothing measurable on this route; the frame remains GPU-bound at this resolution.

Raw logs: `docs/perf/cheer-medium.json`, `cheer2-medium.json`, `base3-medium.json` (per-frame) and `ema-cheer-medium.json`, `ema-cheer2-medium.json`, `ema-base3-medium.json` (EMA sampler). Earlier logs (`final*`, `base2*`, `chill*`, `before*`, `after*`, `ema-noclouds/nodetail/plainveg`) belong to previous iterations.

## Screenshots

- `docs/screenshots/cheer/`: the bird picker, the four rebuilt bird models, a wildflower patch, boulders on an alpine slope, a sailboat and a balloon (final build, high preset).
- `docs/screenshots/chill/`: Settings, the previous bird models and wildlife close-ups from the chill update.
- `docs/screenshots/before/` and `docs/screenshots/after/`: the visual overhaul's eleven fixed vantages (see VISUAL_UPGRADE.md).

## Not verified / limitations of this record

- The music and wind have been analysed, not listened to. Balance between styles and against the wind may need adjustment after a listening session; the Music volume slider and the per-bus mixer exist for that.
- One machine (integrated Intel GPU); Chromium-based browsers only. Firefox and Safari were not run.
- Mobile behaviour through Chromium's Pixel 7 emulation only; no physical device.
- Benchmarks are 60 s routes; no multi-hour soak.
