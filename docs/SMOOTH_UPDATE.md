# Smoothness pass: stutter, the self-opening Settings, and detail without lag

Iteration on top of `d208143` (cheerful update). Reported from play: frames stutter, Settings sometimes appears while flying, and the graphics should be more detailed without lag.

## Settings opening by itself — `src/ui/HUD.ts`, `src/core/App.ts`

Two ways the in-flight Settings button could fire without a deliberate press:

- **Touch.** On phones the button sits top-right, where look-around drags often start. A touch pointer is implicitly captured by the element it starts on, so a drag that began on the button never reached the canvas and ended as a tap on the button: Settings opened. The button now remembers where the pointer went down and ignores a click if the pointer moved more than 8 px before release. A clean tap still opens it (verified with synthetic touch events on a Pixel 7 emulation: drag from the button → nothing; tap → opens).
- **Keyboard.** Closing the dialog returned focus to the button that opened it, so Enter during flight re-opened Settings (Space was already consumed by the flight input). The button now drops focus after every click, and closing Settings back into flight blurs whatever holds focus.

## Stutter — `src/core/App.ts` (`adjustResolution`)

Measured on the integrated Intel UHD 770 at 1080p, medium preset: the frame is **fill-rate bound**. Rendering at 0.75 scale lifts the fixed-route average from 44 to 56 fps, while turning off shadows, clouds, per-pixel terrain detail or the vegetation shader each save under 1 ms. At 44 fps on a 60 Hz display, frames alternate between one and two refreshes (16.7 ms / 33 ms), which is the stutter players see even though the average looks fine.

Adaptive resolution existed but could not do its job. It compared a frame-time average against 24 ms (so it accepted the alternating pattern) and only raised the scale when the average fell below 13 ms, which never happens under vsync: after any dip the scale stayed low for the rest of the session. The new controller counts *missed refreshes* (frames longer than 1.35× the learned refresh interval, never demanding more than 60 fps on faster displays) over 1.5 s windows: more than 8 % missed → scale down one step; a clean window after a cooldown → probe one small step up, but never above the scale that last missed (that scale becomes a ceiling which relaxes slowly). The game settles at the highest scale that keeps every frame inside one refresh.

Results on a fixed autopilot route (see VERIFICATION.md for the table): at a 1.5× device pixel ratio, the old behaviour missed 28 % of refreshes (221 frames over 33 ms in 30 s); the new controller settles at 58 fps with 0.9 % missed and 10 such frames. At 1080p, 1× ratio, medium settles at a render scale of about 0.7–0.75 for the same 58 fps. On a stronger GPU the scale stays at the cap.

A shader warm-up (`renderer.compile`) now runs when the flight begins so the first balloon, boat or flock does not stall a frame on program compilation.

## More detail without lag — `src/core/config.ts`

Because geometry, shadows and clouds are cheap here and the render scale absorbs fill cost, the presets carry more detail and lower pixel-ratio caps:

| Preset | Chunk radius | Ground cover | Cloud puffs | Pixel-ratio cap |
| --- | --- | --- | --- | --- |
| Low | 5 | 0.25 (was 0) | 360 | 1 |
| Medium | 8 (was 7) | 0.85 (was 0.6) | 600 (was 480) | 1.25 (was 1.5) |
| High | 10 | 1 | 900 | 1.5 (was 2) |

"Adaptive resolution" stays on by default; turning it off in Settings pins the scale at the cap for people who prefer sharpness over a steady frame rate.
