# Settings, smoother flight and ambient life

Iteration on top of `7efd524` (Visual overhaul and mouse exploration). The change set was delivered as a source package, merged into this repository by file comparison (14 modified files, 5 new files, one new dev dependency: Happy DOM for the Settings DOM tests) and then verified in a real WebGL2 browser; see [Validation](#validation) below for what was actually checked on this machine.

## Settings repair

The Settings overlay previously shared z-index 30 with later start/pause overlays, allowing those overlays to obscure it. Settings now owns z-index 60, hides the pause menu while open and makes the underlying start/pause content inert. Its header and footer remain outside a scrollable body, selects have explicit dark colors, and narrow screens use one column. Escape closes locally, Tab wraps within the dialog and closing returns focus. Closing restores the previous flying/paused/start state. A Settings button is available during flight; its touch position is separated from Reset view.

## Frame pacing changes

- Render interpolation now captures the previous state before each fixed simulation step, including catch-up frames. Frames with zero simulation steps interpolate the same last pair rather than jumping to the current state. Resume resets the interpolation pair.
- Water depth and shore exposure arrays are calculated with chunk geometry in the terrain worker and transferred as typed arrays. Installing a wet chunk no longer performs 2,401 terrain samples on the main thread.
- Flying installs at most two finished terrain items per frame with a 2 ms between-item budget. An individual install or GPU upload can still exceed that budget. Nearby detail has priority over the far shell; map raster results no longer enter this installation queue.
- Evicting instanced trees detaches borrowed vertex/index attributes before disposal, preserving GPU buffers still shared by other chunks. Quality changes cancel chunk requests without cancelling map/far work.
- Cloud sorting/uploads run at 15 Hz, with immediate refresh on rebasing or large camera movement. HUD refresh runs at 10 Hz. Hidden documents skip rendering. Adaptive resolution remains available.

These address identifiable sources of irregular motion and main-thread work. No measured FPS improvement is claimed for this patch.

## Sound

The procedural Web Audio mix has independent nature/wind, music and effects buses, plus master/mute. Defaults are master 45%, nature 55%, music 20%, effects 45%. Wind is filtered and bounded even while boosting; wing sounds are softer; nearby water fades in gradually; sparse daytime land chirps and quiet, slowly changing sine pads provide ambience. Discoveries use short restrained chimes. Gain changes and pause/resume fade, a compressor controls peaks and transient voices are capped. Audio starts after the flight-start gesture and audio failure does not prevent flight. There are no external audio assets.

## Birds and wildlife

Four selectable player models: Eagle, Gull, Swallow and Owl. They differ in body/head/wing proportions, colors, tail and wingbeat. Swallow has a forked tail; owl has a broader head and face discs. Selection is persisted and changes only the model, preserving flight state and controls.

Ambient wildlife uses three instanced meshes: small circling bird groups, resting deer with subtle head movement, and swimming ducks. Deterministic encounters are prepared one habitat per frame, removed outside the nearby grid and constrained by terrain/water checks. Counts on medium/high are at most 16 birds, 6 deer and 8 ducks in Subtle; 32/12/16 in Lively; Low reduces each limit to approximately 60%. Off hides all wildlife. These are inexpensive decorative models, not detailed animated character assets or autonomous animals.

Two corrections were made after the package was verified in a real browser:

- **Ducks were practically absent.** A ground cell is 180 m and ponds cover only a few percent of a wetland cell, so the single random point per cell almost never landed on water: with seed 1207 there was no duck habitat at all within the 7×7 cells around the opening position, and the nearest was 750 m away (beyond the 550 m duck draw distance). `Wildlife.prepare` now tries up to four candidate points per cell (`GROUND_CANDIDATES`) and takes the first one on a pond; the first meadow point remains the deer fallback, so deer density elsewhere is unchanged. Result near the spawn: 4 duck habitats in the nearby grid, the nearest 205 m away; a habitat costs at most 0.1 ms to prepare, still one per frame.
- **Periodic 50 ms frames from the wildlife draws.** The package moved every animal on the CPU each frame and re-uploaded the instance matrices (and a static-usage phase attribute) with `needsUpdate` every frame. On ANGLE/Direct3D 11 an upload into a buffer the GPU is still reading makes the driver wait for the previous frame, and on the integrated GPU used here that showed up as periodic 50 ms frames. A same-session isolation test (10 s windows alternating: draws hidden / normal / phase upload forced every frame / matrices never re-uploaded) attributed the stalls to the per-frame matrix upload: 4–13 frames over 50 ms per window with it, none without, while the CPU inside `Wildlife.update` was 0.05 ms per frame. Merely marking the buffers dynamic did not help. The animals now animate on the GPU: the instance matrix holds only the encounter center, and a per-instance `aOrbit` attribute (circle radius, angular speed, start angle, bob amplitude) drives position, heading and bobbing in the vertex shader, which also applies the distance fade from `cameraPosition`. Instance buffers are rebuilt only when the nearby set changes (a habitat finished, 100 m of travel, a mode or quality change, an origin rebase; the habitat stream is coalesced to one rebuild per 0.5 s), and each rebuild writes into the next of three ring slots per kind, so the buffer being written was last drawn seconds earlier. After the change the same isolation test shows 0 frames over 50 ms in every window with the draws visible, and forcing the old per-frame upload pattern back on brings 6–7 per window.

## Validation

What the package claimed, and what was actually checked on this machine (Windows 11, Google Chrome stable with the Intel UHD 770 GPU, Playwright Chromium with SwiftShader for the e2e suite). The full record with commands, numbers and log locations is [VERIFICATION.md](VERIFICATION.md).

**As delivered.** The package's own notes said its author had no WebGL2-capable browser: its 48 unit tests passed, but Settings had only been exercised in Happy DOM, and there were no real-browser screenshots, frame-time logs, listening session or e2e run. Those claims were treated as unverified.

**Merge.** The package was a clean superset of `7efd524` (14 modified files, 5 new files, Happy DOM added as a dev dependency). Every changed file was compared against the repository before copying; `npm run typecheck`, `npm test` and `npm run build` passed on the first try.

**Real browser, final build.**

- Playwright e2e suite: 11 of 11 passed (desktop smoke and interaction, mobile emulation), including the existing pause/Escape and map-from-pause flows that the new Settings state machine touches.
- Settings: above the start screen (z-index 60 vs 30) and above the pause menu, focus lands inside the dialog, Tab stays inside, Escape closes and returns focus; body scrolls at 390×640 with fixed header and footer; opened in flight the game pauses and resumes on close; opened from pause it returns to pause with focus on the Settings button.
- Birds: all four species selectable, model swapped in place, close-ups captured (`docs/screenshots/chill/bird-*.jpg`).
- Audio: starts on the start gesture with no errors. It was **not** listened to; the mix is verified only structurally (bounded gains, compressor, voice cap).
- Wildlife: counts follow the budget in Subtle/Lively/Off; ducks confirmed on ponds at the opening position after the candidate-point correction; deer and flocks captured in `docs/screenshots/chill/`.
- Frame pacing: same-batch A/B on a fixed 60 s autopilot route at 1080p medium. Package as delivered: 40.1 fps, 3 frames over 50 ms. Previous commit: 41.7 fps, 4 frames over 50 ms. Final build after the wildlife correction: 40.0 and 42.8 fps in two runs, 5 and 1 frames over 50 ms. That is within the machine's run-to-run noise of the previous commit; the update neither speeds up nor slows down the route measurably. Main-thread CPU per frame for the new systems is small (wildlife 0.05 ms, audio 0.01 ms, clouds 0.05 ms); the frame is GPU-bound on this device.

**Still not verified.** Firefox and Safari; a physical phone; the sound heard by a person; long sessions beyond 60 s benchmarks.
