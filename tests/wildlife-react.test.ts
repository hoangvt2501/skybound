import { describe, expect, it } from 'vitest';
import { SEA_LEVEL } from '../src/core/config';
import { REACT, Wildlife, flockEvadeOffset, memberHash, memberOrbit, memberPosition, runDelay, runProgress, type Encounter, type Observer, type WildlifeTerrain } from '../src/world/Wildlife';
import { WorldGen } from '../src/world/WorldGen';

const gen = new WorldGen(1207);
const analytic: WildlifeTerrain = { surfaceAt: (x, z) => Math.max(gen.heightAt(x, z), SEA_LEVEL), heightAt: (x, z) => gen.heightAt(x, z), treeNear: () => false };
const wildlife = new Wildlife(gen, analytic);

/** First point in a grid search satisfying a predicate. */
function find(pred: (x: number, z: number, h: number) => boolean): { x: number; z: number; h: number } {
  for (let z = 6000; z <= 9000; z += 40) for (let x = -6500; x <= -3000; x += 40) { const h = gen.heightAt(x, z); if (pred(x, z, h)) return { x, z, h }; }
  throw new Error('no spot');
}
const flat = (h: number): WildlifeTerrain => ({ surfaceAt: () => Math.max(h, SEA_LEVEL), heightAt: () => h, treeNear: () => false });
const observer = (x: number, y: number, z: number, vx: number, vy: number, vz: number, boosting = false): Observer => ({ x, y, z, vx, vy, vz, boosting });
/** Drive the private behaviour scan directly with one injected group. */
function scanner(terrain: WildlifeTerrain, e: Encounter) {
  const w = new Wildlife(gen, terrain);
  (w as unknown as { encounters: Map<string, Encounter> }).encounters.set('t', e);
  const scan = (time: number, o: Observer, mode: 'lively' | 'subtle' = 'lively') => (w as unknown as { updateBehaviour: (t: number, o: Observer, m: string) => void }).updateBehaviour(time, o, mode);
  return { w, scan };
}

describe('wildlife reactions: planning', () => {
  it('sends deer away from the player over land close to their own height', () => {
    const spot = find((x, z, h) => h > 3 && h < 60 && gen.slopeAt(x, z) < 0.12 && [0, 0.7, -0.7, 1.4, -1.4, Math.PI].every((a) => gen.heightAt(x + Math.cos(a) * 26, z + Math.sin(a) * 26) > 1.5));
    const e: Encounter = { kind: 'deer', x: spot.x, z: spot.z, y: spot.h, phase: 0.3, count: 2, radius: 0 };
    const r = wildlife.planReaction(e, { x: spot.x - 30, z: spot.z }, 10, 1)!;
    expect(r).not.toBeNull();
    expect(r.mode).toBe(2);
    expect(r.dist).toBe(REACT.deer.maxDist);
    expect(r.dirX).toBeGreaterThan(0.5); // roughly away from the player (positive x)
    const endH = gen.heightAt(e.x + r.dirX * r.dist, e.z + r.dirZ * r.dist);
    expect(endH).toBeGreaterThan(1.5);
    expect(Math.abs(endH - e.y)).toBeLessThan(5);
    expect(r.dh).toBeCloseTo(endH - e.y, 5);
    expect(r.until).toBeCloseTo(10 + REACT.deer.seconds + 0.4 + REACT.deer.hold, 5);
    // Lower intensity: a shorter run.
    expect(wildlife.planReaction(e, { x: spot.x - 30, z: spot.z }, 10, 0.2)!.dist).toBeCloseTo(REACT.deer.minDist + (REACT.deer.maxDist - REACT.deer.minDist) * 0.2, 5);
  });
  it('checks the whole corridor: a tree, a steep step or water on any lane rejects a direction', () => {
    const e: Encounter = { kind: 'deer', x: 0, z: 0, y: 10, phase: 0, count: 2, radius: 0 };
    // A tree 12 m out on the away direction, offset 2 m to the side (inside the group's width): that direction is rejected, the next one is not.
    const treed: WildlifeTerrain = { ...flat(10), treeNear: (x, z, r) => Math.hypot(x - 12, z - 2.8) < r };
    const w1 = new Wildlife(gen, treed);
    const r1 = w1.planReaction(e, { x: -30, z: 0 }, 0, 1)!;
    expect(r1).not.toBeNull();
    expect(Math.abs(r1.dirX - 1) > 0.05 || Math.abs(r1.dirZ) > 0.05).toBe(true); // not straight away
    // A ledge: the ground drops 4 m between stations 2 and 3 along the away direction only.
    const ledge: WildlifeTerrain = { ...flat(10), heightAt: (x, z) => (Math.abs(z) < 3 && x > 12 ? 6 : 10) };
    const r2 = new Wildlife(gen, ledge).planReaction(e, { x: -30, z: 0 }, 0, 1)!;
    expect(r2).not.toBeNull();
    expect(Math.abs(r2.dirZ)).toBeGreaterThan(0.5); // swung sideways
    // Water everywhere but the start: nowhere to run, so the plan is null and the group keeps watching.
    const island: WildlifeTerrain = { ...flat(10), heightAt: (x, z) => (Math.hypot(x, z) < 4 ? 10 : -2) };
    expect(new Wildlife(gen, island).planReaction(e, { x: -30, z: 0 }, 0, 1)).toBeNull();
  });
  it('keeps ducks on the water across their whole width and gives up on the shore', () => {
    const pond = find((x, z, h) => h < -2 && [0, 0.7, -0.7].every((a) => [4, 8, 12].every((d) => [-5.5, 0, 5.5].every((lane) => gen.heightAt(x + Math.cos(a) * d - Math.sin(a) * lane, z + Math.sin(a) * d + Math.cos(a) * lane) < -0.5))));
    const duck: Encounter = { kind: 'duck', x: pond.x, z: pond.z, y: pond.h, phase: 1, count: 3, radius: 3 };
    const r = wildlife.planReaction(duck, { x: pond.x - 20, z: pond.z }, 5, 0.7)!;
    expect(r.mode).toBe(3);
    expect(r.dist).toBeLessThan(REACT.duck.skitterDist);
    expect(gen.heightAt(duck.x + r.dirX * r.dist, duck.z + r.dirZ * r.dist)).toBeLessThan(-0.5);
    // A pond just wide enough for the center line but not for the outer lane: rejected in that direction.
    const channel: WildlifeTerrain = { ...flat(-3), heightAt: (_x, z) => (Math.abs(z) < 3 ? -3 : 1) };
    const e: Encounter = { kind: 'duck', x: 0, z: 0, y: -3, phase: 0, count: 3, radius: 3 };
    expect(new Wildlife(gen, channel).planReaction(e, { x: -20, z: 0 }, 0, 0.7)).toBeNull();
    // Dived at (threat at the skitter level) on open water: a longer, faster flutter-run.
    const sk = new Wildlife(gen, flat(-4)).planReaction(e, { x: -20, z: 0 }, 0, 0.95)!;
    expect(sk.dist).toBe(REACT.duck.skitterDist);
    expect(sk.seconds).toBe(REACT.duck.skitterSeconds);
    expect(sk.intensity).toBeGreaterThanOrEqual(REACT.duck.skitterAbove);
    // Ducks paddle in a line on one circle, each trailing the one ahead.
    const o0 = memberOrbit(e, 0), o1 = memberOrbit(e, 1), o2 = memberOrbit(e, 2);
    expect(o1.radius).toBe(o0.radius); expect(o2.radius).toBe(o0.radius);
    expect(o1.angle0).toBeLessThan(o0.angle0); expect(o2.angle0).toBeLessThan(o1.angle0);
    expect(o1.bob).toBe(0);
    const dry = find((x, z, h) => h > 8 && [0, 0.7, -0.7, 1.4, -1.4, Math.PI].every((a) => gen.heightAt(x + Math.cos(a) * 9, z + Math.sin(a) * 9) > 2));
    expect(wildlife.planReaction({ kind: 'duck', x: dry.x, z: dry.z, y: dry.h, phase: 0, count: 3, radius: 3 }, { x: dry.x - 20, z: dry.z }, 5, 1)).toBeNull();
  });
  it('lets a flock swing aside with no permanent displacement, less over rising ground', () => {
    const r = new Wildlife(gen, flat(0)).planReaction({ kind: 'bird', x: 0, z: 0, y: 200, phase: 0, count: 5, radius: 80 }, { x: 10, z: 10 }, 2, 1)!;
    expect(r.mode).toBe(1);
    expect(r.dist).toBeCloseTo(REACT.bird.maxDist, 5);
    expect(r.until).toBeCloseTo(2 + REACT.bird.seconds + 0.5, 5);
    const wall: WildlifeTerrain = { ...flat(0), heightAt: (x) => (x > 60 ? 195 : 0) };
    const near = new Wildlife(gen, wall).planReaction({ kind: 'bird', x: 0, z: 0, y: 200, phase: 0, count: 5, radius: 40 }, { x: 0, z: 30 }, 2, 1)!;
    expect(near.dist).toBeCloseTo(REACT.bird.maxDist * 0.5, 5);
  });
});

describe('wildlife reactions: threat and states', () => {
  const deer: Encounter = { kind: 'deer', x: 100, z: 0, y: 10, phase: 0.2, count: 2, radius: 0 };
  it('scores a fast low pass straight at the group high, and high, slow or departing passes low', () => {
    const w = new Wildlife(gen, flat(10));
    const low = w.threatTo(deer, observer(60, 18, 0, 34, 0, 0), 0).threat; // 40 m out, 8 m up, cruising straight at them
    const closer = w.threatTo(deer, observer(75, 18, 0, 34, 0, 0), 0).threat; // 25 m out
    const high = w.threatTo(deer, observer(60, 130, 0, 34, 0, 0), 0).threat; // same but 120 m up
    const away = w.threatTo(deer, observer(60, 18, 0, -34, 0, 0), 0).threat; // flying away
    const slow = w.threatTo(deer, observer(60, 18, 0, 12, 0, 0), 0).threat; // slow approach
    const slowClose = w.threatTo(deer, observer(92, 14, 0, 12, 0, 0), 0).threat; // slow, 8 m out
    const boost = w.threatTo(deer, observer(20, 18, 0, 70, 0, 0, true), 0).threat; // boosting, 80 m out
    expect(low).toBeGreaterThan(REACT.evadeOn); // runs about 40 m out at cruise
    expect(closer).toBeGreaterThan(low);
    expect(high).toBeLessThan(0.05);
    expect(away).toBeLessThan(0.05);
    expect(slow).toBeGreaterThan(REACT.alertOn); // alert...
    expect(slowClose).toBeLessThan(REACT.evadeOn); // ...but a slow pass never makes them run
    expect(boost).toBeGreaterThan(REACT.evadeOn); // a boosted pass runs them from far out
  });
  it('goes idle -> alert -> evade -> recover with hysteresis, and does not flicker at the boundary', () => {
    const e: Encounter = { ...deer };
    const { scan } = scanner(flat(10), e);
    let t = 0;
    const tick = (o: Observer, n = 1) => { for (let i = 0; i < n; i++) { scan(t, o); t += REACT.scanInterval; } };
    // A slow approach 30 m out: alert only.
    tick(observer(70, 18, 0, 12, 0, 0), 5);
    expect(e.state).toBe('alert');
    expect(e.react ?? null).toBeNull();
    expect(e.alertX).toBeLessThan(-0.9); // head toward the player, who is at lower x
    // Hovering around the alert threshold for a while: the state stays put (smoothing + minimum dwell).
    const states = new Set<string>();
    for (let i = 0; i < 20; i++) { tick(observer(i % 2 === 0 ? 66 : 74, 18, 0, 12, 0, 0)); states.add(e.state!); }
    expect(states.size).toBe(1);
    // Fast and low, straight at them: they run.
    tick(observer(70, 16, 0, 40, 0, 0), 3);
    expect(e.state).toBe('evade');
    expect(e.react!.mode).toBe(2);
    const started = e.react!.start;
    tick(observer(80, 16, 0, 40, 0, 0), 4);
    expect(e.react!.start).toBe(started); // the run is planned once and left alone
    // The run expires: the group is baked where it stopped and recovers; a cooldown blocks a second run.
    t = e.react!.until + 0.01;
    tick(observer(200, 60, 0, -40, 0, 0));
    expect(e.state).toBe('recover');
    expect(e.react ?? null).toBeNull();
    expect(Math.hypot(e.x - 100, e.z)).toBeGreaterThanOrEqual(REACT.deer.minDist); // baked where the run ended
    expect(e.cooldownUntil).toBeGreaterThan(t);
    tick(observer(200, 60, 0, -40, 0, 0), 12);
    expect(e.state).toBe('idle');
  });
  it('keeps watching instead of running when no corridor is usable', () => {
    const island: WildlifeTerrain = { ...flat(10), heightAt: (x, z) => (Math.hypot(x - 100, z) < 4 ? 10 : -2) };
    const e: Encounter = { ...deer };
    const { scan } = scanner(island, e);
    let t = 0;
    for (let i = 0; i < 12; i++) { scan(t, observer(70, 16, 0, 40, 0, 0)); t += REACT.scanInterval; }
    expect(e.state).toBe('alert');
    expect(e.react ?? null).toBeNull();
  });
  it('limits simultaneous evades and softens them in subtle mode', () => {
    const groups: Encounter[] = [0, 1, 2, 3, 4].map((i) => ({ kind: 'deer' as const, x: 100 + i * 30, z: i * 6, y: 10, phase: i, count: 2, radius: 0 }));
    const w = new Wildlife(gen, flat(10));
    const map = (w as unknown as { encounters: Map<string, Encounter> }).encounters;
    groups.forEach((g, i) => map.set(`g${i}`, g));
    const scan = (t: number, o: Observer, mode: 'lively' | 'subtle') => (w as unknown as { updateBehaviour: (t: number, o: Observer, m: string) => void }).updateBehaviour(t, o, mode);
    let t = 0;
    for (let i = 0; i < 8; i++) { scan(t, observer(140, 14, 10, 40, 0, 0, true), 'subtle'); t += REACT.scanInterval; }
    const evading = groups.filter((g) => g.react);
    expect(evading.length).toBeGreaterThan(0);
    expect(evading.length).toBeLessThanOrEqual(REACT.maxActive.subtle);
    for (const g of evading) expect(g.react!.intensity).toBeLessThanOrEqual(REACT.intensityScale.subtle + 1e-9);
  });
  it('drops every reaction when wildlife is switched off, so nothing resumes later', () => {
    const e: Encounter = { ...deer, react: { start: 1, dirX: 1, dirZ: 0, mode: 2, dist: 20, dh: 0, seconds: 3, intensity: 1, until: 9 }, state: 'evade', alertAt: 1 };
    const w = new Wildlife(gen, flat(10));
    (w as unknown as { encounters: Map<string, Encounter> }).encounters.set('t', e);
    (w as unknown as { lastMode: string }).lastMode = 'lively';
    w.update(2, observer(0, 0, 0, 0, 0, 0), 0, 0, 'off', 'medium');
    expect(e.react ?? null).toBeNull();
    expect(e.state).toBe('idle');
    expect(e.alertAt).toBe(0);
  });
});

describe('wildlife reactions: fish and ducks', () => {
  it('keeps shoals away from duck groups, never within 60 m of each other', () => {
    // Populate the wetland around the spawn (many ponds) and look at every duck / fish pair.
    const w = new Wildlife(gen, analytic);
    for (let i = 0; i < 200; i++) w.update(i / 60, observer(-4740, 120, 7165, 0, 0, 0), 0, 0, 'lively', 'high');
    const groups = w.groupsNear(-4740, 7165, 2000);
    const ducks = groups.filter((g) => g.kind === 'duck'), fish = groups.filter((g) => g.kind === 'fish');
    expect(ducks.length).toBeGreaterThan(0);
    let nearest = Infinity;
    for (const d of ducks) for (const f of fish) nearest = Math.min(nearest, Math.hypot(d.x - f.x, d.z - f.z));
    expect(nearest).toBeGreaterThan(60);
  });
  it('dives only the nearest shoals on water contact, once, and mutes their splashes meanwhile', () => {
    const w = new Wildlife(gen, flat(-5));
    const map = (w as unknown as { encounters: Map<string, Encounter> }).encounters;
    const shoals: Encounter[] = [3, 12, 25, 60].map((d, i) => ({ kind: 'fish' as const, x: d, z: 0, y: 0, phase: i, count: 3, radius: 5 }));
    // Keys the cell scan around (0, 0) wants, so update() keeps the injected groups instead of replacing them.
    shoals.forEach((s, i) => map.set(`g:${i}:0`, s));
    (w as unknown as { lastMode: string }).lastMode = 'lively';
    w.onWaterContact(0, 0, 0.8, 10);
    expect(shoals.map((s) => !!s.react)).toEqual([true, true, false, false]);
    expect(shoals[0].react!.mode).toBe(4);
    expect(shoals[0].react!.until).toBeCloseTo(10 + REACT.fish.seconds + 2 * 0.8, 5);
    // The same contact again does not restart the dive (already reacting), and a cooldown follows.
    const start = shoals[0].react!.start;
    w.onWaterContact(0, 0, 0.8, 11);
    expect(shoals[0].react!.start).toBe(start);
    expect(shoals[0].cooldownUntil).toBeGreaterThan(shoals[0].react!.until);
    // Splash callbacks: a diving shoal produces none while its dive lasts; the others keep leaping.
    const perShoal = [0, 0, 0, 0];
    w.onFishSplash = (x) => { let best = 0; for (let i = 1; i < 4; i++) if (Math.abs(x - shoals[i].x) < Math.abs(x - shoals[best].x)) best = i; perShoal[best]++; };
    const o = observer(0, 5, 0, 0, 0, 0);
    w.update(10.05, o, 0, 0, 'lively', 'medium'); // rebuild registers the fish instances
    for (let t = 10.1; t < 16; t += 0.05) w.update(t, o, 0, 0, 'lively', 'medium');
    expect(perShoal[0] + perShoal[1]).toBe(0);
    expect(perShoal[2] + perShoal[3]).toBeGreaterThan(0);
    for (let t = 16.05; t < 40; t += 0.05) w.update(t, o, 0, 0, 'lively', 'medium');
    expect(perShoal[0] + perShoal[1]).toBeGreaterThan(0);
  });
  it('gives swimming ducks a short, budgeted ripple trail at their displayed positions', () => {
    const e: Encounter = { kind: 'duck', x: 0, z: 0, y: -3, phase: 0.5, count: 3, radius: 3 };
    const { w, scan } = scanner(flat(-3), e);
    const rings: { x: number; z: number }[] = [];
    w.onDuckRipple = (x, z) => rings.push({ x, z });
    e.react = { start: 0, dirX: 1, dirZ: 0, mode: 3, dist: 9, dh: 0, seconds: 2.6, intensity: 1, until: 6 }; e.state = 'evade';
    scan(0.5, observer(-20, 3, 0, 20, 0, 0));
    expect(rings.length).toBe(3);
    for (let j = 0; j < 3; j++) { const p = memberPosition(e, j, 0.5); expect(rings[j].x).toBeCloseTo(p.x, 6); expect(rings[j].z).toBeCloseTo(p.z, 6); }
    scan(2.5, observer(-20, 3, 0, 20, 0, 0)); // past the ripple window
    expect(rings.length).toBe(3);
  });
});

/**
 * The GPU evaluates the same motion from the same attributes. This is a line-by-line transcription of
 * the vertex shader's flock, run and orbit branches; if the GLSL changes, this must change with it.
 */
function shaderPosition(e: Encounter, j: number, time: number): { x: number; y: number; z: number } {
  const o = memberOrbit(e, j);
  const aPhase = o.phase, aOrbit = { x: o.radius, y: o.speed, z: o.angle0, w: o.bob };
  const r = e.react;
  const aReact = { x: r ? r.start : -1e9, y: r ? r.dirX : 0, z: r ? r.dirZ : 0, w: r ? r.mode + (Math.max(-8, Math.min(7.9, r.dh)) + 8) / 32 : 0 };
  const aReact2 = r ? (r.mode === 1 ? { x: r.dist * r.intensity, y: r.seconds, w: e.radius } : { x: 1, y: r.seconds, w: r.dist }) : { x: 0, y: 3, w: 0 };
  const fract = (v: number) => v - Math.floor(v);
  const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
  const wildAngle = aOrbit.z + time * aOrbit.y;
  const reactMode = Math.floor(aReact.w), reactT = time - aReact.x, reactOn = reactMode > 0.5 && reactT > 0 ? 1 : 0;
  const runDelayG = 0.08 + 0.3 * fract(aPhase * 0.618);
  const runSeconds = aReact2.x > 0 ? aReact2.y : 3;
  let runK = 0;
  if (reactOn > 0.5 && reactMode > 1.5 && reactMode < 3.5) { const u = clamp((reactT - runDelayG) / runSeconds, 0, 1); runK = 1 - (1 - u) * (1 - u); }
  // instance translation (matrix) + orbit
  let x = e.kind === 'deer' ? e.x + j * 3.2 : e.x, z = e.kind === 'deer' ? e.z + j * 2 : e.z, y = o.y;
  x += Math.cos(wildAngle) * aOrbit.x; y += aOrbit.w * Math.sin(time * 0.4 + aPhase); z += Math.sin(wildAngle) * aOrbit.x;
  if (reactOn > 0.5) {
    if (reactMode < 1.5) {
      const off = { x: Math.cos(wildAngle) * aOrbit.x, y: Math.sin(wildAngle) * aOrbit.x }, dir = { x: aReact.y, y: aReact.z };
      const along = off.x * dir.x + off.y * dir.y, cross = off.x * dir.y - off.y * dir.x;
      const side = Math.abs(cross) < 1e-3 ? (fract(aPhase * 0.618) > 0.5 ? 1 : -1) : Math.sign(cross);
      const radius = aReact2.w, near = clamp((along + radius) / (2 * radius), 0, 1), delay = 0.08 + 0.5 * near * near;
      const u = clamp((reactT - delay) / runSeconds, 0, 1);
      const env = Math.sin(Math.PI * u) * aReact2.x * (0.7 + 0.6 * fract(aPhase * 0.318));
      x += (-dir.y * side + dir.x * 0.3) * env; y += 0.4 * env; z += (dir.x * side + dir.y * 0.3) * env;
    } else if (reactMode < 3.5) {
      const dist = aReact2.w, dh = fract(aReact.w) * 32 - 8;
      x += aReact.y * dist * runK; y += dh * runK; z += aReact.z * dist * runK;
    }
  }
  return { x, y, z };
}

describe('wildlife reactions: CPU formulas match the shader', () => {
  it('member positions agree with the shader transcription for flocks, runs and swims over time', () => {
    const cases: Encounter[] = [
      { kind: 'bird', x: 500, z: -200, y: 300, phase: 2.1, count: 7, radius: 90, react: { start: 4, dirX: 0.6, dirZ: 0.8, mode: 1, dist: 20, dh: 0, seconds: 3.4, intensity: 1, until: 8 } },
      { kind: 'deer', x: -40, z: 70, y: 12, phase: 0.7, count: 2, radius: 0, react: { start: 1, dirX: -1, dirZ: 0, mode: 2, dist: 22, dh: 2.5, seconds: 2.8, intensity: 0.8, until: 7 } },
      { kind: 'duck', x: 10, z: 10, y: -2, phase: 3.3, count: 3, radius: 3, react: { start: 2, dirX: 0, dirZ: 1, mode: 3, dist: 9, dh: 0, seconds: 2.6, intensity: 0.5, until: 8 } },
      { kind: 'bird', x: 0, z: 0, y: 250, phase: 1, count: 5, radius: 60 },
    ];
    for (const e of cases) for (let j = 0; j < e.count; j++) for (let t = 0; t <= 9; t += 0.37) {
      const a = memberPosition(e, j, t), b = shaderPosition(e, j, t);
      // dh is packed into 1/32 m steps on the GPU; everything else must agree to float precision.
      expect(Math.abs(a.x - b.x)).toBeLessThan(1e-6);
      expect(Math.abs(a.z - b.z)).toBeLessThan(1e-6);
      expect(Math.abs(a.y - b.y)).toBeLessThan(e.react && e.react.mode === 2 ? 0.05 : 1e-6);
    }
  });
  it('shares the stagger, progress and evade helpers the shader transcribes', () => {
    expect(memberHash(2.5).stagger).toBeCloseTo(2.5 * 0.618 - Math.floor(2.5 * 0.618), 12);
    expect(runProgress(0, 0.2, 3)).toBe(0);
    expect(runProgress(3.2, 0.2, 3)).toBe(1);
    expect(runProgress(1.7, 0.2, 3)).toBeCloseTo(1 - 0.25, 12); // half way: 75 % of the distance already
    expect(runDelay(0)).toBeCloseTo(0.08, 12);
    const f0 = flockEvadeOffset(0, 50, 1, 0, 50, 20, 3.4, 0.3, 0);
    expect(Math.hypot(f0.x, f0.y, f0.z)).toBe(0); // not started
    const fEnd = flockEvadeOffset(0, 50, 1, 0, 50, 20, 3.4, 0.3, 10);
    expect(Math.hypot(fEnd.x, fEnd.y, fEnd.z)).toBeLessThan(1e-9); // back in formation, no residual offset
    // Members nearer the player start earlier than the far side.
    const nearSide = flockEvadeOffset(-50, 0, 1, 0, 50, 20, 3.4, 0.3, 0.3), farSide = flockEvadeOffset(50, 0, 1, 0, 50, 20, 3.4, 0.3, 0.3);
    expect(Math.hypot(nearSide.x, nearSide.z)).toBeGreaterThan(Math.hypot(farSide.x, farSide.z));
  });
});
