# Cheerful music, bird picker, better birds, richer scenery

Iteration on top of `e34279f` (chill update). Requested as: the music sounded like an aircraft cabin; the birds should be pickable from illustrated cards and feel different; the bird models should be more detailed; the scenery should vary more.

## Music and wind — `src/atmosphere/Music.ts`, `src/atmosphere/Audio.ts`

The old "music" was three sine pads under a 330 Hz low-passed noise bed, which together read as a constant drone. Both halves were replaced.

- **Procedural music box.** Short tunes are composed on the fly: a major key drawn from C/D/E/F/G, a four-chord loop (I–V–vi–IV and friends), a pentatonic melody in four-bar phrases (A, A′, B, A″ with a cadence on the root), an accompaniment pattern, bass and light percussion, all played by oscillator instruments (plucked string, marimba, kalimba, triangle bass, filtered-noise shaker, sine kick). Songs last 24–32 bars, rest a bar and re-draw key and loop, so the music keeps changing without repeating a file. Notes are scheduled 0.45 s ahead from a timer, independent of the render loop.
- **Styles** (Settings → Music): *Sunny stroll* (112 BPM 4/4, plucks), *Meadow waltz* (138 BPM 3/4, marimba, oom-pah-pah), *Island breeze* (98 BPM swing, kalimba), *Calm pad* (the previous sustained chords) and *Off*. Picking a style plays it immediately, even on the start screen or from the pause menu (the pause suspends audio again when the dialog closes).
- **Wind.** Now two layers: a bright band-passed "air" layer (700–1600 Hz, gusting on a slow random walk) and a low rush that only grows with speed² and boost. The cabin-like low drone is gone at cruise.
- The music bus default rose from 20 % to 35 %; preferences saved before music existed receive the new default.

No audio files are shipped; the offline render of each style (20 s, Chrome `OfflineAudioContext`) showed 1.8–2.5 note onsets per second, envelope periodicity matching the tempos (0.55 s ≈ 110 BPM, 0.42 s ≈ 143 BPM, 0.64 s ≈ 94 BPM), spectral centroids of 360–760 Hz, and peaks far below clipping. Nobody has listened to it on speakers yet.

## Bird picker and species handling — `src/ui/SettingsPanel.ts`, `src/ui/BirdPortraits.ts`, `src/flight/BirdSpecies.ts`, `src/flight/FlightController.ts`

- The species select became a radio group of four cards, each with a portrait rendered by the game from the real model (three-quarter front view, 320×220, rendered the first time Settings opens), two lines of character, and 1–5 dots for Speed, Agility, Glide and Power. Cards work with click, arrow keys and Tab; the selected card carries the `aria-checked` state.
- Each species now has a **flight profile**: modest multipliers on the shared constants (speed, agility, flap power, glide). Eagle: best glide, deliberate turns, strong flaps. Gull: fastest cruise, efficient. Swallow: 35 % quicker turns and response, quick flaps, short glides. Owl: slowest cruise, nimble. The reference constants are unchanged, so existing tests and saves behave as before; `tuneFlight()` derives the tuned constants and the controller uses them from the next step.

## Bird models — `src/flight/Bird.ts`

Rebuilt with the same API: a lathed body with neck, a species head (hooked yellow beak and brow ridge on the eagle; slim beak with a red spot on the gull; tiny beak, steel-blue crown and rusty throat on the swallow; facial discs with dark rims, yellow irises and ear tufts on the owl), eye glints, cambered wing plates with a scalloped trailing edge and darker coverts, fanned rounded primaries (seven splayed "fingers" on the eagle, a pointed tip on gull and swallow, broad soft tips on the owl), species patterns (barring on the owl, black wingtips with white mirrors and a black tail band on the gull, a white tail on the eagle, streamers with white spots on the swallow), tucked feet and joint fillers where the wing segments flex. The animation adds hand twist on the downstroke and wrist flex on the upstroke.

## Scenery — `src/world/Vegetation.ts`, `src/world/chunkMesh.ts`, `src/world/WorldGen.ts`, `src/world/Wildlife.ts`, `src/atmosphere/Clouds.ts`, `src/core/App.ts`

- **Wildflower patches.** Three flower tiles (poppies, daisies, lupines) join the ground-cover atlas; a 90 m patch field in the generator (`flowerPatch`) makes meadows and uplands bloom in clumps, with denser cover inside a patch. Purely visual, like the rest of the cover.
- **Boulders.** A ninth vegetation species: displaced icospheres with lichen tints, placed by the same deterministic rules as trees on alpine, arid and upland slopes (and rarely in temperate woods), with a low, wide collider and an impostor tile.
- **Hot-air balloons and sailboats.** Two more ambient kinds in the instanced wildlife system: balloons drift on 220–380 m circles above gentle land (about one air cell in three, up to three in view), striped in two colours with the hue rotated per instance in the shader; sailboats heave and roll gently on open water (deep-water cells with 80 m of clear water, up to five in view). Both obey the Ambient life setting and the same GPU-side animation and ring-buffered uploads as the animals.
- **Changing skies.** Haze and cloud cover drift slowly with time (periods of a few minutes, phase by seed): fog distance moves between 0.55× and 1.15× the preset, the horizon warms in haze, the sun dims a little, and cloud opacity/contrast follow a coverage uniform. Sessions start close to clear; heavy haze and overcast are occasional. Settings → "Changing skies" turns it off.

## Screenshots (`docs/screenshots/cheer/`, final build, real GPU)

- `picker.jpg`: the Settings bird picker with portraits rendered from the live models and trait dots.
- `bird-eagle.jpg`, `bird-gull.jpg`, `bird-swallow.jpg`, `bird-owl.jpg`: the rebuilt models in a glide over the opening wetland.
- `wildflowers.jpg`: a poppy, daisy and lupine patch on a meadow; `boulders.jpg`: boulders among pines on an alpine slope.
- `sailboat.jpg`: a sailboat on the sea north of the wetland coast; `balloon.jpg`: a balloon over the plain with a second one, in different colours, in the distance.

## Validation

See [VERIFICATION.md](VERIFICATION.md) for the record. In short: typecheck, unit tests (including new ones for profiles, boulders, flower cover and the two ambient kinds) and the production build pass; the full Playwright suite passes on the final build; real-Chrome checks covered the music preview flow (start screen, pause, persistence), the picker (portraits present, click and arrow selection, the owl's cruise speed applied), the four models in glide and mid-flap, flowers, boulders, a sailboat, balloons and the sky-mood drift and its off switch. Not verified: how the music sounds to a person; Firefox/Safari; a physical phone.
