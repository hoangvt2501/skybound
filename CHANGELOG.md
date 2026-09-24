# Changelog

Each entry is one pass over the game, in the order they landed on `main`. The live build at
https://hoangvt2501.github.io/skybound/ follows `main`.

## 2026-09-17 · More trees and colour, a smoother bird, a brook and a waterfall (`4db373b`)

- Four new tree species (maple, cypress, blossom, fir) with impostor tiles, colliders and biome shares; softer crown lumps painted with a lift toward the sunlit top; a per-instance crown tint on trees and impostors with regional autumn zones.
- Ground cover grows from 7 to 11 tile kinds (ferns, tall grass, cornflowers, buttercups); flower fields are colour-coherent per zone; tufts carry their own tint. The upland's hard-edged per-vertex flower patches give way to heather and a soft blush.
- Terrain greens follow the climate, rock drifts by region from grey to ochre to basalt, scree speckles the soil band.
- Bird: 40-segment lathed body, finer head and beak, wing plates that overlap at the hinges so no gap opens when the wing folds, a row of coverts, crisp neck marks.
- A brook down the mist valley into its lake, fed by a waterfall off the head wall, with spray puffs and a rush on the water bus.
- Three cloud sizes; deer coats from reddish to grey-brown; brown-headed duck hens.
- Shadows are cast by two instanced unit shapes per chunk instead of one proxy per species and variant. Performance equal to the previous build within measurement noise; 320-face leaf clusters were tried and rejected (4-7 fps on an integrated GPU).

## 2026-09-17 · Stand the bird on the real crown top (`e0393bf`)

- Tree and boulder perches use the model's highest point over the trunk (per variant, with the instance's stretch and yaw) instead of the collision cylinder, so the bird sits on the crown rather than inside it.

## 2026-09-16 · Land on perches and take off again; calmer far ground, warmer dawn, a real dusk (`e46ef41`)

- Landing: every landmark, the biggest trees and boulders offer a perch; a slow pass is captured, the bird flares, settles with folded wings, looks around, preens and casts a contact shadow; the soundscape rests with it; Space hops off.
- Art pass compared at the same views: mid-field mottle fades sooner, a soil band between grass and rock, wider rock and snow blends, aerial perspective ahead of the scene fog, a cool sky light at sunrise, an evening palette blended in over the afternoon, the sky's horizon band biased to the sun side when the sun is low, a wrapped diffuse on the bird.

## 2026-09-16 · Ease the free-look orbit toward the drag (`5e22b15`)

- Mouse-drag orbit eases toward a goal angle so uneven per-frame deltas no longer stutter; the resolution controller steps down at 6 % late frames and probes up only from clean windows.

## 2026-09-16 · Smoother view drags, ducks that paddle in line, deer that run on legs (`a767ff1`)

- Every new mesh is drawn once off-screen on install so a view drag no longer triggers hundreds of first draws; a burst step in the resolution controller; look-ahead follows the orbit deviation.
- Ducks paddle in a line and skitter across the water when dived at; shoals never sit next to duck ponds; deer legs fold at the knee while running.

## 2026-09-16 · Wildlife reacts to how the bird approaches (`a9dbccd`)

- Per-group idle/alert/evade/recover state on a smoothed threat (proximity, closing speed, height, pace); deer and duck runs planned over terrain-checked corridors; flocks evade sideways and close up again; fish dive when the bird touches the water.

## 2026-09-15 · Frame pacing pass, geomorph terrain, reactive wildlife, calmer controls (`17a7544`)

- Adaptive render scale into a multisampled render target, baked noise texture for terrain and water, full trees within 700 m and impostors beyond, shadow proxies, terrain LOD geomorphs, calmer mouse and turn tuning. Late frames fell from 13 % to 4-5 %.

## 2026-09-15 · Valley, rising air, smooth LOD, photo mode, living water (`c0f94a6`)

- The mist valley with its lake, fog banks and sun shafts; thermals and ridge lift; photo mode; swell, whitecaps, surf, skimming and plunging into water; leaping fish.
