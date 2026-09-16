/** Decorative ambient life: instanced flocks, deer, ducks, hot-air balloons and sailboats; deterministic habitats, no flight colliders. */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { type QualityPreset } from '../core/config';
import { Biome } from './biomes';
import { hash2, Rng } from './noise';
import { createTerrainSample, type WorldGen } from './WorldGen';

export type WildlifeMode = 'off' | 'subtle' | 'lively';
export interface WildlifeCounts { birds: number; deer: number; ducks: number; balloons: number; boats: number; fish: number }
export function wildlifeBudget(mode: WildlifeMode, quality: QualityPreset): WildlifeCounts {
  if (mode === 'off') return { birds: 0, deer: 0, ducks: 0, balloons: 0, boats: 0, fish: 0 };
  const factor = quality === 'low' ? 0.6 : 1;
  const lively = mode === 'lively';
  return {
    birds: Math.round((lively ? 32 : 16) * factor), deer: Math.round((lively ? 12 : 6) * factor), ducks: Math.round((lively ? 16 : 8) * factor),
    balloons: lively ? 3 : 2, boats: Math.round((lively ? 5 : 3) * factor),
    fish: Math.round((lively ? 16 : 8) * factor),
  };
}

/** Candidate points tried per ground cell before giving up on a pond. */
const GROUND_CANDIDATES = 4;

export type Habitat = 'deer' | 'duck' | null;
export function habitatAt(height: number, slope: number, biome: Biome): Habitat {
  if (height < -1 && height > -12 && slope < 0.2) return 'duck';
  if (height > 2 && slope < 0.22 && [Biome.Temperate, Biome.Upland, Biome.Wetland].includes(biome)) return 'deer';
  return null;
}

export type Kind = 'bird' | 'deer' | 'duck' | 'balloon' | 'boat' | 'fish';
const KINDS: readonly Kind[] = ['bird', 'deer', 'duck', 'balloon', 'boat', 'fish'];

/** Behaviour of a group toward the player. */
export type BehaviourState = 'idle' | 'alert' | 'evade' | 'recover';
/**
 * An evade played on the GPU from its start time: a flock swings aside of the approach axis and
 * closes up again (mode 1), deer run (mode 2) or ducks swim (mode 3) `dist` metres along a planned
 * direction and stop there, fish dive and drift (mode 4). `dh` is the ground height change over a run.
 * When a run expires the displacement is baked into the encounter position, so the next rebuild
 * places the animals where the shader left them; the GPU keeps evaluating the same start time across
 * rebuilds, so re-uploading the instance buffers never restarts an animation.
 */
export interface Reaction { start: number; dirX: number; dirZ: number; mode: 1 | 2 | 3 | 4; dist: number; dh: number; seconds: number; intensity: number; until: number }
export interface Encounter {
  x: number; y: number; z: number; phase: number; kind: Kind; count: number; radius: number;
  state?: BehaviourState; threat?: number; stateSince?: number;
  /** Alert head-turn: start time while alert (> 0), minus the end time while easing back, 0 otherwise; direction toward the player. */
  alertAt?: number; alertX?: number; alertZ?: number;
  react?: Reaction | null; cooldownUntil?: number;
  /** Last wake-ring tick of a paddling duck group. */
  wakeTick?: number;
}
/** Who the player is, for the threat estimate: position, velocity (m/s) and boost. */
export interface Observer { x: number; y: number; z: number; vx: number; vy: number; vz: number; boosting: boolean }

/**
 * Reaction tuning. `radius` is the distance at which proximity reaches its maximum weight; the threat
 * estimate multiplies proximity by closing speed, height above the animals and the player's speed, so
 * a fast low pass straight at a group scores near 1 while a high or departing pass stays near 0.
 */
export const REACT = {
  bird: { radius: 110, height: 60, minDist: 10, maxDist: 24, seconds: 3.4, hold: 0, cooldown: 10 },
  deer: { radius: 95, height: 60, minDist: 14, maxDist: 26, seconds: 2.8, hold: 2.5, cooldown: 12 },
  duck: { radius: 80, height: 45, minDist: 6, maxDist: 11, seconds: 2.6, hold: 2.5, cooldown: 12, skitterAbove: 0.85, skitterDist: 16, skitterSeconds: 1.8, wakeSeconds: 1.8, wakeRange: 160 },
  fish: { radius: 36, seconds: 5, cooldown: 8 },
  /**
   * State thresholds on the smoothed threat (enter above, leave below: hysteresis). At cruise speed
   * and low, deer go alert about 60 m out and run about 40 m out; a slow pass (12 m/s) never scores
   * above 0.4, so it only ever alerts; a boosted pass runs them from about 100 m.
   */
  alertOn: 0.22, alertOff: 0.12, evadeOn: 0.55, evadeOnAlerted: 0.45, evadeOffRecover: 0.28,
  /** Seconds a state must persist before it can move on, so a player hovering at a boundary does not flip it. */
  alertMinSeconds: 0.5, recoverSeconds: 2.5,
  scanInterval: 0.25, scanRadius: 320,
  maxActive: { lively: 4, subtle: 2 } as Record<Exclude<WildlifeMode, 'off'>, number>,
  intensityScale: { lively: 1, subtle: 0.7 } as Record<Exclude<WildlifeMode, 'off'>, number>,
  /** Ripple rings per scan tick for swimming ducks; the splash ring pool holds 32. */
  rippleBudget: 6, rippleSeconds: 1.6,
} as const;
type JobKind = 'ground' | 'air' | 'balloon';
const CAPACITY: Record<Kind, number> = { bird: 32, deer: 12, duck: 16, balloon: 3, boat: 5, fish: 16 };
const MAX_DISTANCE: Record<Kind, number> = { bird: 1600, deer: 550, duck: 550, balloon: 2800, boat: 1400, fish: 420 };
const KIND_SCALE: Record<Kind, number> = { bird: 1.5, deer: 1, duck: 1, balloon: 1, boat: 1, fish: 1.7 };
const BUDGET_KEY: Record<Kind, keyof WildlifeCounts> = { bird: 'birds', deer: 'deer', duck: 'ducks', balloon: 'balloons', boat: 'boats', fish: 'fish' };
/** Instance buffers per kind. A rebuild writes the slot drawn longest ago, so the GPU is never reading the buffer being written. */
const RING = 3;
/** Player travel that triggers a new nearest-encounter selection. */
const REBUILD_DISTANCE = 100;
/** Coalesces the one-habitat-per-frame stream into a few uploads. */
const REBUILD_INTERVAL = 0.5;
const _matrix = new THREE.Matrix4(), _position = new THREE.Vector3(), _scale = new THREE.Vector3(), _rotation = new THREE.Quaternion();

// ---------------------------------------------------------------------------------------------------
// Motion formulas shared by the CPU (threat estimate, ripples, baking) and the vertex shader. The GLSL
// below is written from these; tests/wildlife-react.test.ts checks a transcription of the GLSL against
// them so the two cannot drift apart unnoticed.
// ---------------------------------------------------------------------------------------------------

/** Per-member orbit parameters exactly as `rebuild` writes them into aOrbit / aPhase. */
export function memberOrbit(e: Encounter, j: number): { radius: number; speed: number; angle0: number; bob: number; y: number; phase: number } {
  if (e.kind === 'bird') return { radius: e.radius + j * 6, speed: 0.08, angle0: e.phase - j * 0.03, bob: 1.5, y: e.y + j * 0.6, phase: e.phase + j };
  // Ducks paddle in a line: one circle, each member trailing the one ahead by about 1.5 m of arc.
  if (e.kind === 'duck') return { radius: 3.5, speed: 0.045, angle0: e.phase - j * 0.42, bob: 0, y: 0.015, phase: e.phase + j };
  return { radius: 0, speed: 0, angle0: Math.PI - e.phase, bob: 0, y: e.y, phase: e.phase + j };
}

/** Stable per-instance variation from the phase attribute, as the shader derives it. */
export function memberHash(phase: number): { stagger: number; vigor: number } {
  const fr = (v: number) => v - Math.floor(v);
  return { stagger: fr(phase * 0.618), vigor: fr(phase * 0.318) };
}

/** Ease-out run progress 0..1 after a per-member delay: fast off the mark, slowing to a stop. */
export function runProgress(t: number, delay: number, seconds: number): number {
  const u = Math.min(1, Math.max(0, (t - delay) / seconds));
  return 1 - (1 - u) * (1 - u);
}

/** Per-member start delay of a run or swim (seconds), so a group does not move as one block. */
export function runDelay(phase: number): number { return 0.08 + 0.3 * memberHash(phase).stagger; }

/**
 * Flock evade of one member at time `t` since the start: which side of the approach axis the bird is on
 * decides its side, its position along the axis decides its delay (those nearest the player go first),
 * and the envelope returns to zero so the formation closes up again without a jump.
 */
export function flockEvadeOffset(offX: number, offZ: number, dirX: number, dirZ: number, radius: number, amplitude: number, seconds: number, phase: number, t: number): { x: number; y: number; z: number } {
  const along = offX * dirX + offZ * dirZ; // negative = nearer the player
  const cross = offX * dirZ - offZ * dirX;
  const h = memberHash(phase);
  const side = Math.abs(cross) < 1e-3 ? (h.stagger > 0.5 ? 1 : -1) : Math.sign(cross);
  const near = Math.min(1, Math.max(0, (along + radius) / (2 * radius)));
  const delay = 0.08 + 0.5 * near * near;
  const u = Math.min(1, Math.max(0, (t - delay) / seconds));
  const env = Math.sin(Math.PI * u) * amplitude * (0.7 + 0.6 * h.vigor);
  return { x: (-dirZ * side + dirX * 0.3) * env, y: 0.4 * env, z: (dirX * side + dirZ * 0.3) * env };
}

/** World position of one member as displayed (orbit plus the current reaction displacement). */
export function memberPosition(e: Encounter, j: number, time: number): { x: number; y: number; z: number } {
  const o = memberOrbit(e, j);
  const angle = o.angle0 + time * o.speed;
  let x = e.x + Math.cos(angle) * o.radius, z = e.z + Math.sin(angle) * o.radius;
  let y = o.y + o.bob * Math.sin(time * 0.4 + o.phase);
  if (e.kind === 'deer') { x = e.x + j * 3.2; z = e.z + j * 2; }
  const r = e.react;
  if (r && time >= r.start) {
    const t = time - r.start;
    if (r.mode === 1) {
      const f = flockEvadeOffset(x - e.x, z - e.z, r.dirX, r.dirZ, e.radius, r.dist * r.intensity, r.seconds, o.phase, t);
      x += f.x; y += f.y; z += f.z;
    } else if (r.mode === 2 || r.mode === 3) {
      const k = runProgress(t, runDelay(o.phase), r.seconds);
      x += r.dirX * r.dist * k; z += r.dirZ * r.dist * k; y += r.dh * k;
    }
  }
  return { x, y, z };
}

function geometry(kind: Kind): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const paint = (source: THREE.BufferGeometry, color: number | ((x: number, y: number, z: number) => number), motion: number) => {
    const g = source.index ? source.toNonIndexed() : source; // merge needs every part indexed the same way
    if (g !== source) source.dispose();
    const n = g.attributes.position.count, colors = new Float32Array(n * 3), weights = new Float32Array(n), pos = g.attributes.position, c = new THREE.Color();
    for (let i = 0; i < n; i++) { c.set(typeof color === 'number' ? color : color(pos.getX(i), pos.getY(i), pos.getZ(i))); colors.set([c.r, c.g, c.b], i * 3); weights[i] = motion; }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3)); g.setAttribute('aMotion', new THREE.BufferAttribute(weights, 1));
    g.deleteAttribute('uv');
    parts.push(g);
  };
  const ellipsoid = (x: number, y: number, z: number, sx: number, sy: number, sz: number, color: number, motion = 0) => {
    const g = new THREE.SphereGeometry(1, 8, 6); g.scale(sx, sy, sz); g.translate(x, y, z);
    paint(g, color, motion);
  };
  const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number, color: number, motion = 0) => {
    const g = new THREE.BoxGeometry(sx, sy, sz); g.translate(x, y, z); paint(g, color, motion);
  };
  if (kind === 'balloon') {
    // Envelope in eight gores (two colours; the shader rotates the hue per instance), throat, basket, ropes.
    const env = new THREE.SphereGeometry(6.5, 20, 14); env.scale(1, 1.12, 1); env.translate(0, 11.5, 0);
    paint(env, (x, _y, z) => (Math.floor((Math.atan2(z, x) / (Math.PI * 2) + 1) * 8) % 2 === 0 ? 0xe4483c : 0xf7ecd2), 4);
    const throat = new THREE.ConeGeometry(2.4, 3.2, 12, 1, true); throat.rotateX(Math.PI); throat.translate(0, 4.6, 0);
    paint(throat, 0xb8352b, 5);
    box(0, 1.6, 0, 2.2, 1.5, 2.2, 0x7a5638, 5);
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const rope = new THREE.CylinderGeometry(0.06, 0.06, 3.2, 4); rope.translate(sx * 1.0, 3.6, sz * 1.0); paint(rope, 0x4c4038, 5);
    }
  } else if (kind === 'fish') {
    // Silver fish about 0.6 m long, nose toward -Z, forked tail; the leap arc is evaluated in the shader (aMotion 6).
    ellipsoid(0, 0, 0, 0.09, 0.12, 0.3, 0xe6eef2, 6);
    ellipsoid(0, 0.05, 0.05, 0.06, 0.08, 0.22, 0x5b8aa6, 6);
    const tail = new THREE.ConeGeometry(0.11, 0.18, 3); tail.rotateX(Math.PI / 2); tail.translate(0, 0, 0.36); paint(tail, 0xa9bcc7, 6);
    const fin = new THREE.ConeGeometry(0.05, 0.12, 3); fin.translate(0, 0.14, -0.02); paint(fin, 0xa9bcc7, 6);
  } else if (kind === 'boat') {
    // Hull with a narrowed bow (-Z), deck, mast, main and jib sails.
    const hull = new THREE.BoxGeometry(2.8, 1.3, 8.4, 1, 1, 4);
    const hp = hull.attributes.position;
    for (let i = 0; i < hp.count; i++) { const z = hp.getZ(i), t = THREE.MathUtils.clamp(-z / 4.2, 0, 1); hp.setX(i, hp.getX(i) * (1 - 0.8 * t * t)); if (hp.getY(i) < 0) hp.setX(i, hp.getX(i) * 0.8); }
    hull.translate(0, 0.35, 0);
    paint(hull, (_x, y) => (y > 0.75 ? 0xf1ece0 : y > 0.05 ? 0xf5f2ea : 0x27466e), 3);
    box(0, 1.1, 0.6, 2.0, 0.35, 4.2, 0xd8c29a, 3); // deck cabin
    const mast = new THREE.CylinderGeometry(0.1, 0.13, 9.5, 5); mast.translate(0, 5.6, -0.4); paint(mast, 0x6f5a45, 3);
    const sail = (a: [number, number, number], b: [number, number, number], c: [number, number, number], color: number) => {
      for (const order of [[a, b, c], [a, c, b]]) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(order.flat(), 3));
        g.computeVertexNormals();
        paint(g, color, 3);
      }
    };
    sail([0.05, 1.6, -0.3], [0.05, 9.8, -0.4], [0.35, 1.9, 3.9], 0xfbf8ef);
    sail([-0.05, 1.7, -0.5], [-0.05, 8.6, -0.45], [-0.3, 1.9, -3.8], 0xf4e7c8);
  }
  if (kind === 'bird') {
    ellipsoid(0, 0, 0, 0.13, 0.12, 0.45, 0xdbdcd3);
    ellipsoid(0, 0.04, -0.37, 0.1, 0.1, 0.12, 0xf3ece0);
    ellipsoid(0, 0, -0.51, 0.04, 0.035, 0.1, 0xcda85b);
    ellipsoid(0, 0, 0.46, 0.14, 0.02, 0.19, 0x79818a);
    for (const side of [-1, 1]) {
      ellipsoid(side * 0.42, 0.02, 0.02, 0.48, 0.025, 0.19, 0xc7cdd0, 1);
      ellipsoid(side * 0.95, 0.02, 0.17, 0.38, 0.018, 0.105, 0x4c5965, 1);
    }
  } else if (kind === 'deer') {
    ellipsoid(0, 0.98, 0, 0.28, 0.34, 0.6, 0x947358);
    // Neck, head, nose and ears carry aMotion 2: they lift and turn toward the player when alert.
    ellipsoid(0, 1.26, -0.49, 0.17, 0.4, 0.21, 0xa58465, 2);
    ellipsoid(0, 1.52, -0.66, 0.17, 0.18, 0.32, 0xb09472, 2);
    ellipsoid(0, 1.45, -0.91, 0.1, 0.09, 0.07, 0x45372c, 2);
    for (const side of [-1, 1]) {
      ellipsoid(side * 0.17, 1.78, -0.58, 0.08, 0.19, 0.05, 0xb09876, 2);
      // Legs in two segments: the thigh (aMotion 7) swings from the hip at y 0.92, the shin and hoof
      // (aMotion 8) fold at the knee at y 0.52 while the deer runs; diagonal pairs move together.
      for (const z of [-0.36, 0.37]) {
        ellipsoid(side * 0.18, 0.72, z, 0.065, 0.22, 0.075, 0x6f5947, 7);
        ellipsoid(side * 0.18, 0.29, z, 0.05, 0.25, 0.055, 0x695445, 8);
        ellipsoid(side * 0.18, 0.05, z + 0.01, 0.06, 0.05, 0.07, 0x3a2f27, 8);
      }
    }
    ellipsoid(0, 1.1, 0.62, 0.09, 0.11, 0.18, 0xe4d6b9, 2);
  } else {
    ellipsoid(0, 0.18, 0, 0.21, 0.18, 0.37, 0xa5957e);
    ellipsoid(0, 0.4, -0.22, 0.1, 0.16, 0.11, 0x466555, 2);
    ellipsoid(0, 0.53, -0.28, 0.13, 0.12, 0.14, 0x3b6b51, 2);
    ellipsoid(0, 0.49, -0.44, 0.11, 0.03, 0.1, 0xd9b55a, 2);
    for (const side of [-1, 1]) {
      ellipsoid(side * 0.18, 0.21, 0.04, 0.06, 0.11, 0.23, 0x625c56);
      // Wings (aMotion 9): folded along the body, beating only when the duck skitters across the water.
      ellipsoid(side * 0.2, 0.3, 0.02, 0.22, 0.03, 0.17, 0x8a7a63, 9);
    }
  }
  const merged = mergeGeometries(parts, false)!;
  for (const part of parts) part.dispose();
  return merged;
}

/** Ground queries the behaviour needs; the chunk manager provides the rendered surface and tree colliders. */
export interface WildlifeTerrain {
  /** Water surface or terrain height at a global position. */
  surfaceAt(x: number, z: number): number;
  /** Terrain height (below water where there is water). */
  heightAt(x: number, z: number): number;
  /** Is any tree collider within `radius` of the point? */
  treeNear(x: number, z: number, radius: number): boolean;
}

export class Wildlife {
  readonly group = new THREE.Group();
  private rings: Record<Kind, THREE.InstancedMesh[]>;
  private active: Record<Kind, number> = { bird: 0, deer: 0, duck: 0, balloon: 0, boat: 0, fish: 0 };
  private materials: THREE.Material[] = [];
  private clock = { value: 0 };
  private encounters = new Map<string, Encounter | null>();
  private pending: { key: string; cx: number; cz: number; kind: JobKind }[] = [];
  private cellX = NaN;
  private cellZ = NaN;
  private sample = createTerrainSample();
  private lastMode: WildlifeMode = 'off';
  private lastQuality: QualityPreset = 'medium';
  private dirty = true;
  private builtAt = -Infinity;
  private builtX = NaN;
  private builtZ = NaN;
  private builtOX = NaN;
  private builtOZ = NaN;
  /** Fish instances currently drawn, for the CPU-side launch/landing splashes. */
  private fishInstances: { e: Encounter; x: number; z: number; heading: number; len: number; rate: number; phase: number; cycle: number }[] = [];
  /** Nearest thermal to a point within a radius, if any; flocks prefer to circle in it. */
  thermalFinder: ((x: number, z: number, radius: number) => { x: number; z: number; radius: number; base: number; top: number } | null) | null = null;
  /** Called when a fish breaks the surface (landing = true when it falls back in). */
  onFishSplash: ((x: number, z: number, landing: boolean) => void) | null = null;
  /** Called for a ripple ring behind a duck swimming away (a few per scan tick at most). */
  onDuckRipple: ((x: number, z: number, size: number) => void) | null = null;
  private lastReactScan = -Infinity;
  private terrain: WildlifeTerrain;
  /** Behaviour cost of the last scan tick (ms), for diagnostics. */
  lastScanMs = 0;

  constructor(private gen: WorldGen, terrain: WildlifeTerrain | ((x: number, z: number) => number)) {
    this.terrain = typeof terrain === 'function'
      ? { surfaceAt: terrain, heightAt: (x, z) => gen.heightAt(x, z), treeNear: () => false }
      : terrain;
    this.rings = { bird: this.makeRing('bird'), deer: this.makeRing('deer'), duck: this.makeRing('duck'), balloon: this.makeRing('balloon'), boat: this.makeRing('boat'), fish: this.makeRing('fish') };
    this.group.name = 'Ambient wildlife';
  }

  /**
   * Animals move on the GPU: the instance matrix holds only the encounter
   * center; the per-instance orbit (radius, angular speed, start angle, bob)
   * and the distance fade are evaluated in the vertex shader from uWildTime
   * and cameraPosition. Instance buffers therefore change only when the set of
   * nearby encounters or a group's behaviour changes. Re-uploading them every
   * frame (the previous design) made ANGLE/Direct3D wait for the GPU to release
   * the buffer and produced periodic 50 ms frames on an integrated GPU.
   */
  private makeRing(kind: Kind): THREE.InstancedMesh[] {
    const base = geometry(kind), material = new THREE.MeshLambertMaterial({ vertexColors: true });
    material.onBeforeCompile = shader => {
      shader.uniforms.uWildTime = this.clock;
      shader.uniforms.uMaxDistance = { value: MAX_DISTANCE[kind] };
      shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
        uniform float uWildTime;
        uniform float uMaxDistance;
        attribute float aMotion;
        attribute float aPhase;
        attribute vec4 aOrbit; // radius, angular speed, start angle, bob amplitude
        attribute vec4 aReact; // reaction start time, direction x/z, mode + packed ground delta
        attribute vec4 aReact2; // intensity, alert time (+start / -end), direction toward the player x/z
        vec3 wildRotate(vec3 v, float heading) { float c = cos(heading), s = sin(heading); return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z); }
        // Shared with Wildlife.ts (memberHash, runProgress, runDelay, flockEvadeOffset).
        float wildStagger(float phase) { return fract(phase * 0.618); }
        float wildVigor(float phase) { return fract(phase * 0.318); }
        float wildRunProgress(float t, float delay, float seconds) { float u = clamp((t - delay) / seconds, 0.0, 1.0); return 1.0 - (1.0 - u) * (1.0 - u); }
        float wildRunDelay(float phase) { return 0.08 + 0.3 * wildStagger(phase); }`);
      shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        float wildAngle = aOrbit.z + uWildTime * aOrbit.y;
        // Local -Z forward follows the circle tangent; leaping fish (aMotion 6) keep a fixed heading.
        float wildHeading = (aMotion > 5.5 && aMotion < 6.5) ? PI - aOrbit.z : PI - wildAngle;
        // Reaction state: rt = seconds since it started, mode 1 flock, 2 run, 3 swim, 4 dive.
        float reactMode = floor(aReact.w);
        float reactT = uWildTime - aReact.x;
        float reactOn = (reactMode > 0.5 && reactT > 0.0) ? 1.0 : 0.0;
        float runDelay = wildRunDelay(aPhase);
        float runSeconds = aReact2.x > 0.0 ? aReact2.y : 3.0; // seconds ride in aReact2.y only for runs (see rebuild)
        // Runners and swimmers face their run direction, easing back to the circle tangent after they stop.
        float faceRun = 0.0;
        if (reactOn > 0.5 && reactMode > 1.5 && reactMode < 3.5) {
          faceRun = smoothstep(0.0, 0.25, reactT - runDelay + 0.25) * (1.0 - smoothstep(runSeconds, runSeconds + 0.8, reactT - runDelay));
        }
        if (faceRun > 0.001) {
          vec2 f = normalize(mix(vec2(-sin(wildHeading), -cos(wildHeading)), normalize(aReact.yz), faceRun));
          wildHeading = atan(-f.x, -f.y);
        }
        objectNormal = wildRotate(objectNormal, wildHeading);`);
      shader.vertexShader = shader.vertexShader.replace('#include <color_vertex>', `#include <color_vertex>
        #ifdef USE_COLOR
        if (aMotion > 3.5 && aMotion < 4.5) { // balloon envelope: rotate the two gore colours per instance
          float tint = fract(aPhase * 0.618);
          if (tint > 0.66) vColor.rgb = vColor.rgb.brg; else if (tint > 0.33) vColor.rgb = vColor.rgb.gbr;
        }
        #endif`);
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        // Alert: 0..1 while the group watches the player (rises over 0.6 s, eases off over 1.2 s).
        float alertT = aReact2.z;
        float alertOn = alertT > 0.5 ? smoothstep(0.0, 0.6, uWildTime - alertT) : (alertT < -0.5 ? 1.0 - smoothstep(0.0, 1.2, uWildTime + alertT) : 0.0);
        alertOn *= 1.0 - faceRun; // a running deer looks where it runs
        float runK = 0.0, runSpeed = 0.0;
        if (reactOn > 0.5 && reactMode > 1.5 && reactMode < 3.5) {
          runK = wildRunProgress(reactT, runDelay, runSeconds);
          runSpeed = 1.0 - clamp((reactT - runDelay) / runSeconds, 0.0, 1.0); // 1 at the start, 0 when stopped
        }
        if (aMotion > 0.5 && aMotion < 1.5) {
          // Wing beat, quicker while the flock evades.
          float flee = (reactOn > 0.5 && reactMode < 1.5) ? sin(PI * clamp(reactT / runSeconds, 0.0, 1.0)) : 0.0;
          float beat = sin(uWildTime * (5.5 + 3.0 * flee) + aPhase);
          transformed.y += abs(position.x) * beat * 0.38;
          transformed.x *= 0.88 + 0.12 * cos(uWildTime * (5.5 + 3.0 * flee) + aPhase);
        } else if (aMotion > 1.5 && aMotion < 2.5) {
          transformed.y += sin(uWildTime * 0.65 + aPhase) * 0.045;
          if (alertOn > 0.001) {
            // Head and neck turn toward the player (up to about 65 degrees) and lift a little.
            vec3 toward = wildRotate(vec3(aReact2.w, 0.0, aReact2.x), -wildHeading); // player direction in local space (x = aReact2.w, z = aReact2.x when alert)
            float yaw = clamp(atan(toward.x, -toward.z), -1.15, 1.15) * alertOn;
            vec3 pivot = vec3(0.0, 1.22, -0.45);
            vec3 p = transformed - pivot;
            float c = cos(yaw), s = sin(yaw);
            p = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
            transformed = p + pivot + vec3(0.0, 0.08 * alertOn, 0.0);
          }
        } else if (aMotion > 6.5 && aMotion < 8.5) {
          // Deer legs: diagonal pairs swing from the hip while running; the shin folds at the knee on the
          // forward swing and the hoof follows it (a gallop read from the side, not a rocking block).
          if (runSpeed > 0.02) {
            float pair = sign(position.x) * sign(position.z);
            float phi = (reactT - runDelay) * 11.0 + (pair > 0.0 ? 0.0 : PI);
            float swing = 0.7 * runSpeed * sin(phi);
            float bend = -0.95 * runSpeed * max(0.0, sin(phi + 0.6));
            float legZ = sign(position.z) * 0.365;
            if (aMotion > 7.5) {
              vec3 knee = vec3(0.0, 0.52, legZ);
              vec3 q = transformed - knee;
              float cb = cos(bend), sb = sin(bend);
              transformed = vec3(q.x, cb * q.y - sb * q.z, sb * q.y + cb * q.z) + knee;
            }
            vec3 hip = vec3(0.0, 0.92, legZ);
            vec3 p = transformed - hip;
            float c = cos(swing), s = sin(swing);
            transformed = vec3(p.x, c * p.y - s * p.z, s * p.y + c * p.z) + hip;
          }
        } else if (aMotion > 8.5 && aMotion < 9.5) {
          // Duck wings: folded (shortened) unless the duck skitters across the water, then a fast beat.
          float skitter = (runSpeed > 0.02 && reactMode > 2.5 && reactMode < 3.5 && aReact2.x > 0.85) ? 1.0 : 0.0;
          float beat = sin(uWildTime * 16.0 + aPhase);
          transformed.x *= mix(0.55, 1.0, skitter);
          transformed.y += abs(position.x) * beat * 0.5 * skitter;
        } else if (aMotion > 2.5 && aMotion < 3.5) {
          transformed.y += sin(uWildTime * 0.9 + aPhase) * 0.22; // sailboat heave
          transformed.x += position.y * sin(uWildTime * 0.7 + aPhase) * 0.06; // and a little roll
        } else if (aMotion > 3.5 && aMotion < 5.5) {
          transformed.y += sin(uWildTime * 0.3 + aPhase) * 1.6; // balloon drift
        }
        vec3 wildCenter = (modelMatrix * instanceMatrix)[3].xyz;
        float wildFade = 1.0 - smoothstep(uMaxDistance * 0.8, uMaxDistance, distance(cameraPosition, wildCenter));
        if (aMotion > 5.5 && aMotion < 6.5) {
          // Leaping fish (aOrbit: leap length, cycle rate, heading, leap height). For the first third of
          // each cycle it dashes forward in a parabola, pitching along the arc; the rest it waits 1.4 m down.
          // A dive (mode 4) keeps it under and drifts it away from the splash for a few seconds.
          float dive = 0.0;
          if (reactOn > 0.5 && reactMode > 3.5) dive = smoothstep(0.0, 0.5, reactT) * (1.0 - smoothstep(aReact2.y - 1.5, aReact2.y, reactT));
          float cycle = fract(uWildTime * aOrbit.y + aPhase * 0.159);
          float leaping = step(cycle, 0.32) * (1.0 - step(0.5, dive));
          float leap = clamp(cycle / 0.32, 0.0, 1.0);
          float up = aOrbit.w * sin(leap * 3.14159);
          float pitch = (0.5 - leap) * 1.6 * leaping;
          vec3 shaped = transformed * wildFade;
          shaped = vec3(shaped.x, shaped.y * cos(pitch) - shaped.z * sin(pitch), shaped.y * sin(pitch) + shaped.z * cos(pitch));
          transformed = wildRotate(shaped, wildHeading);
          float along = mix(aOrbit.x * 0.5, (leap - 0.5) * aOrbit.x, leaping);
          float depth = mix(-1.4 - 1.2 * dive, up - 0.7, leaping); // starts and ends 0.7 m under, clears the surface by up to 2.3 m
          transformed += vec3(-sin(wildHeading) * along, depth, -cos(wildHeading) * along);
          transformed += vec3(aReact.y, 0.0, aReact.z) * (3.0 * dive * (0.6 + 0.8 * wildVigor(aPhase)));
        } else {
          if (runSpeed > 0.02) {
            // Gallop / paddle bob while moving, in step with the legs; a skittering duck rides higher.
            transformed.y += abs(sin((reactT - runDelay) * 11.0)) * (reactMode < 2.5 ? 0.1 : 0.04) * runSpeed;
            if (reactMode > 2.5 && reactMode < 3.5 && aReact2.x > 0.85) transformed.y += 0.14 * runSpeed;
            if (reactMode < 2.5 && aMotion > 1.5 && aMotion < 2.5) transformed.y -= 0.1 * runSpeed; // head down at a gallop
          }
          transformed = wildRotate(transformed * wildFade, wildHeading);
          transformed += vec3(cos(wildAngle) * aOrbit.x, aOrbit.w * sin(uWildTime * 0.4 + aPhase), sin(wildAngle) * aOrbit.x);
          if (aMotion < 1.5 && aOrbit.w > 0.5) transformed.y += 2.5 * alertOn; // an alert flock rises a little
          if (reactOn > 0.5) {
            if (reactMode < 1.5) {
              // Flock evade (flockEvadeOffset): sideways of the approach axis, nearest birds first, back to formation.
              vec2 off = vec2(cos(wildAngle), sin(wildAngle)) * aOrbit.x;
              vec2 dir = aReact.yz;
              float along = off.x * dir.x + off.y * dir.y;
              float cross = off.x * dir.y - off.y * dir.x;
              float side = abs(cross) < 1e-3 ? (wildStagger(aPhase) > 0.5 ? 1.0 : -1.0) : sign(cross);
              float radius = aReact2.w;
              float near = clamp((along + radius) / (2.0 * radius), 0.0, 1.0);
              float delay = 0.08 + 0.5 * near * near;
              float u = clamp((reactT - delay) / runSeconds, 0.0, 1.0);
              float env = sin(PI * u) * aReact2.x * (0.7 + 0.6 * wildVigor(aPhase));
              transformed += vec3((-dir.y * side + dir.x * 0.3) * env, 0.4 * env, (dir.x * side + dir.y * 0.3) * env);
            } else if (reactMode < 3.5) {
              // Run or swim along the planned direction and stop at its end (the CPU bakes it in later).
              float dist = aReact2.w;
              float dh = fract(aReact.w) * 32.0 - 8.0;
              transformed += vec3(aReact.y * dist * runK, dh * runK, aReact.z * dist * runK);
            }
          }
        }`);
    };
    material.customProgramCacheKey = () => 'skybound-wildlife-v7';
    this.materials.push(material);
    const ring: THREE.InstancedMesh[] = [];
    for (let slot = 0; slot < RING; slot++) {
      const g = slot === 0 ? base : base.clone();
      const capacity = CAPACITY[kind];
      g.setAttribute('aPhase', new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1));
      g.setAttribute('aOrbit', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4));
      g.setAttribute('aReact', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4).fill(0), 4));
      g.setAttribute('aReact2', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4).fill(0), 4));
      const mesh = new THREE.InstancedMesh(g, material, capacity);
      mesh.count = 0; mesh.frustumCulled = false; mesh.visible = slot === 0;
      mesh.name = `wildlife-${kind}-${slot}`;
      ring.push(mesh); this.group.add(mesh);
    }
    return ring;
  }

  private prepare(cx: number, cz: number, kind: JobKind): Encounter | null {
    const rng = new Rng(hash2(cx, cz, this.gen.seed ^ (kind === 'air' ? 0xb17d : kind === 'balloon' ? 0xba11 : 0xdeea)));
    const size = kind === 'ground' ? 180 : 900;
    if (kind === 'balloon') {
      // About one in three air cells over gentle land carries a balloon, well above the highest ground around.
      if (rng.next() > 0.34) return null;
      const bx = (cx + 0.25 + rng.next() * 0.5) * size, bz = (cz + 0.25 + rng.next() * 0.5) * size;
      const bs = this.gen.sample(bx, bz, this.sample);
      if (bs.height < 4 || bs.height > bs.snowLine - 200 || bs.biome === Biome.Alpine) return null;
      const radius = 220 + rng.next() * 160;
      let top = bs.height;
      for (let i = 0; i < 12; i++) top = Math.max(top, this.gen.heightAt(bx + Math.cos(i * Math.PI / 6) * (radius + 60), bz + Math.sin(i * Math.PI / 6) * (radius + 60)));
      return { kind: 'balloon', x: bx, z: bz, y: top + 190 + rng.next() * 140, phase: rng.next() * Math.PI * 2, radius, count: 1 };
    }
    const x = (cx + 0.18 + rng.next() * 0.64) * size, z = (cz + 0.18 + rng.next() * 0.64) * size;
    const s = this.gen.sample(x, z, this.sample);
    if (kind === 'air') {
      let radius = 65 + rng.next() * 80, fx = x, fz = z, lift = 0;
      const thermal = this.thermalFinder?.(x, z, 450);
      if (thermal) { fx = thermal.x; fz = thermal.z; radius = Math.max(45, thermal.radius * 0.8); lift = 120 + rng.next() * 160; }
      let y = Math.max(0, this.gen.sample(fx, fz, this.sample).height);
      for (let i = 0; i < 8; i++) y = Math.max(y, this.gen.heightAt(fx + Math.cos(i * Math.PI / 4) * (radius + 40), fz + Math.sin(i * Math.PI / 4) * (radius + 40)));
      return { kind: 'bird', x: fx, z: fz, y: y + 75 + rng.next() * 80 + lift, phase: rng.next() * Math.PI * 2, radius, count: 4 + rng.int(4) };
    }
    // Water at least 2.5 m deep: open water may hold a sailboat (one deep cell in six, 80 m of clear
    // water around its circle); otherwise a small shoal of leaping fish, but never next to ducks: a
    // shoal is placed only if none of the eight neighbouring cells would hold a duck habitat (their
    // candidates are replayed from their own RNG, so the rule holds whichever cell is prepared first).
    if (s.height < -2.5) {
      if (s.height < -6 && rng.next() < 0.18) {
        let open = true;
        for (let i = 0; i < 8 && open; i++) if (this.gen.heightAt(x + Math.cos(i * Math.PI / 4) * 80, z + Math.sin(i * Math.PI / 4) * 80) > -3) open = false;
        if (open) return { kind: 'boat', x, z, y: 0, phase: rng.next() * Math.PI * 2, radius: 45, count: 1 };
      }
      if (s.height < -3 && rng.next() < 0.7) {
        let open = true; // open water 12 m around: shoals sit in the middle of ponds and lakes
        for (let i = 0; i < 8 && open; i++) if (this.gen.heightAt(x + Math.cos(i * Math.PI / 4) * 12, z + Math.sin(i * Math.PI / 4) * 12) > -2) open = false;
        if (open && !this.ducksAround(cx, cz)) return { kind: 'fish', x, z, y: 0, phase: rng.next() * Math.PI * 2, radius: 4 + rng.next() * 3, count: 3 + rng.int(3) };
      }
      return null;
    }
    return this.groundHabitat(cx, cz, rng, x, z, s);
  }

  /**
   * Duck pond or deer meadow of a ground cell. Ponds cover only a few percent of a wetland cell, so a
   * single random point almost never lands on water and ducks would be a rarity: try a few candidates
   * per cell and prefer the first one that sits on a pond; the first suitable meadow point is the
   * fallback, so deer density elsewhere is unchanged. The cell RNG keeps every candidate deterministic.
   */
  private groundHabitat(cx: number, cz: number, rng: Rng, x: number, z: number, s: ReturnType<typeof createTerrainSample>): Encounter | null {
    const size = 180;
    let land: { x: number; z: number; y: number } | null = null;
    for (let attempt = 0; attempt < GROUND_CANDIDATES; attempt++) {
      const px = attempt === 0 ? x : (cx + 0.18 + rng.next() * 0.64) * size;
      const pz = attempt === 0 ? z : (cz + 0.18 + rng.next() * 0.64) * size;
      const sample = attempt === 0 ? s : this.gen.sample(px, pz, this.sample);
      const habitat = habitatAt(sample.height, this.gen.slopeAt(px, pz), sample.biome);
      if (habitat === 'duck') {
        // Ducks need water around the whole small swimming circle, not only its center.
        let wet = true;
        for (let i = 0; i < 8 && wet; i++) if (this.gen.heightAt(px + Math.cos(i * Math.PI / 4) * 10, pz + Math.sin(i * Math.PI / 4) * 10) > -0.3) wet = false;
        if (wet) return { kind: 'duck', x: px, z: pz, y: sample.height, radius: 3, phase: rng.next() * Math.PI * 2, count: 3 };
      } else if (habitat === 'deer' && !land) land = { x: px, z: pz, y: sample.height };
    }
    return land ? { kind: 'deer', x: land.x, z: land.z, y: land.y, radius: 0, phase: rng.next() * Math.PI * 2, count: 2 } : null;
  }

  /** Would any of the eight cells around (cx, cz) hold a duck habitat? Replays their candidate draws without storing anything. */
  private ducksAround(cx: number, cz: number): boolean {
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dz === 0) continue;
      const ncx = cx + dx, ncz = cz + dz;
      const rng = new Rng(hash2(ncx, ncz, this.gen.seed ^ 0xdeea));
      const x = (ncx + 0.18 + rng.next() * 0.64) * 180, z = (ncz + 0.18 + rng.next() * 0.64) * 180;
      const s = this.gen.sample(x, z, this.sample);
      if (s.height < -2.5) continue; // a water-first cell holds fish or a boat, never ducks
      if (this.groundHabitat(ncx, ncz, rng, x, z, s)?.kind === 'duck') return true;
    }
    return false;
  }

  update(time: number, observer: Observer, ox: number, oz: number, mode: WildlifeMode, quality: QualityPreset): void {
    this.clock.value = time;
    this.group.visible = mode !== 'off';
    const px = observer.x, py = observer.y, pz = observer.z;
    if (mode === 'off') {
      // Nothing reacts while off, and nothing resumes a stale reaction when switched back on.
      if (this.lastMode !== 'off') for (const e of this.encounters.values()) if (e) { e.react = null; e.state = 'idle'; e.threat = 0; e.alertAt = 0; }
      this.lastMode = mode; return;
    }
    const cx = Math.floor(px / 180), cz = Math.floor(pz / 180);
    if (cx !== this.cellX || cz !== this.cellZ || mode !== this.lastMode) {
      this.cellX = cx; this.cellZ = cz; this.pending.length = 0;
      const wanted = new Set<string>();
      for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
        const key = `g:${cx + dx}:${cz + dz}`; wanted.add(key);
        if (!this.encounters.has(key)) this.pending.push({ key, cx: cx + dx, cz: cz + dz, kind: 'ground' });
      }
      const ax = Math.floor(px / 900), az = Math.floor(pz / 900);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const key = `a:${ax + dx}:${az + dz}`; wanted.add(key);
        if (!this.encounters.has(key)) this.pending.push({ key, cx: ax + dx, cz: az + dz, kind: 'air' });
      }
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        const key = `b:${ax + dx}:${az + dz}`; wanted.add(key);
        if (!this.encounters.has(key)) this.pending.push({ key, cx: ax + dx, cz: az + dz, kind: 'balloon' });
      }
      this.pending.sort((a, b) => {
        const distance = (v: typeof a) => Math.hypot((v.cx + 0.5) * (v.kind === 'ground' ? 180 : 900) - px, (v.cz + 0.5) * (v.kind === 'ground' ? 180 : 900) - pz);
        return distance(a) - distance(b);
      });
      for (const key of this.encounters.keys()) if (!wanted.has(key)) { this.encounters.delete(key); this.dirty = true; }
    }
    // One habitat per frame: crossing a cell must not create an expensive burst.
    const job = this.pending.shift();
    if (job) { this.encounters.set(job.key, this.prepare(job.cx, job.cz, job.kind)); this.dirty = true; }
    const changed = mode !== this.lastMode || quality !== this.lastQuality;
    this.lastMode = mode; this.lastQuality = quality;
    this.fishSplashes(time);
    if (time - this.lastReactScan >= REACT.scanInterval) {
      this.lastReactScan = time;
      const t0 = performance.now();
      this.updateBehaviour(time, observer, mode);
      this.lastScanMs = performance.now() - t0;
    }
    const moved = !(Math.hypot(px - this.builtX, pz - this.builtZ) <= REBUILD_DISTANCE);
    const rebased = ox !== this.builtOX || oz !== this.builtOZ;
    const drained = job !== undefined && this.pending.length === 0; // last habitat of a cell change: show it even if the clock is paused
    if (changed || moved || rebased || drained || (this.dirty && time - this.builtAt >= REBUILD_INTERVAL)) this.rebuild(time, px, py, pz, ox, oz, mode, quality);
  }

  /** Select the nearest encounters within budget and write them into the next ring slot of each kind. */
  private rebuild(time: number, px: number, py: number, pz: number, ox: number, oz: number, mode: WildlifeMode, quality: QualityPreset): void {
    this.dirty = false; this.builtAt = time; this.builtX = px; this.builtZ = pz; this.builtOX = ox; this.builtOZ = oz;
    const budget = wildlifeBudget(mode, quality), used: Record<Kind, number> = { bird: 0, deer: 0, duck: 0, balloon: 0, boat: 0, fish: 0 };
    this.fishInstances.length = 0;
    const target: Record<Kind, THREE.InstancedMesh> = { bird: this.nextSlot('bird'), deer: this.nextSlot('deer'), duck: this.nextSlot('duck'), balloon: this.nextSlot('balloon'), boat: this.nextSlot('boat'), fish: this.nextSlot('fish') };
    const sorted = Array.from(this.encounters.values()).filter((e): e is Encounter => e !== null).sort((a, b) => Math.hypot(a.x - px, a.z - pz) - Math.hypot(b.x - px, b.z - pz));
    for (const e of sorted) {
      const max = budget[BUDGET_KEY[e.kind]];
      if (Math.hypot(e.x - px, e.y - py, e.z - pz) > MAX_DISTANCE[e.kind]) continue;
      for (let j = 0; j < e.count && used[e.kind] < max; j++) {
        let x = e.x, z = e.z, y = e.y, radius = 0, speed = 0, angle0 = Math.PI - e.phase, bob = 0;
        if (e.kind === 'bird' || e.kind === 'duck' || e.kind === 'deer') {
          // The orbit parameters come from memberOrbit so the CPU formulas match what is uploaded.
          const o = memberOrbit(e, j);
          radius = o.radius; speed = o.speed; angle0 = o.angle0; bob = o.bob; y = o.y;
          if (e.kind === 'deer') { x += j * 3.2; z += j * 2; y = this.terrain.surfaceAt(x, z); if (y <= 1) continue; }
        } else if (e.kind === 'balloon') {
          radius = e.radius; speed = 0.012; angle0 = e.phase;
        } else if (e.kind === 'boat') {
          radius = e.radius; speed = 0.028; angle0 = e.phase; y = 0.05;
        } else if (e.kind === 'fish') {
          // aOrbit for fish: leap length, cycle rate (Hz), heading, leap height. Members spread out and leap in sequence.
          x += Math.cos(e.phase + j * 1.9) * (2 + j * 1.6); z += Math.sin(e.phase + j * 1.9) * (2 + j * 1.6);
          radius = e.radius; speed = 0.19 + (j % 3) * 0.03; angle0 = Math.PI - (e.phase + j * 0.35); bob = 2.3 + (j % 2) * 0.7; y = 0;
          this.fishInstances.push({ e, x, z, heading: e.phase + j * 0.35, len: radius, rate: speed, phase: e.phase + j, cycle: -1 });
        }
        const mesh = target[e.kind], index = used[e.kind]++;
        _position.set(x - ox, y, z - oz); _scale.setScalar(KIND_SCALE[e.kind]); _rotation.identity();
        mesh.setMatrixAt(index, _matrix.compose(_position, _rotation, _scale));
        (mesh.geometry.attributes.aPhase as THREE.InstancedBufferAttribute).setX(index, e.phase + j);
        (mesh.geometry.attributes.aOrbit as THREE.InstancedBufferAttribute).setXYZW(index, radius, speed, angle0, bob);
        const r = e.react;
        (mesh.geometry.attributes.aReact as THREE.InstancedBufferAttribute).setXYZW(index, r ? r.start : -1e9, r ? r.dirX : 0, r ? r.dirZ : 0, r ? r.mode + (Math.max(-8, Math.min(7.9, r.dh)) + 8) / 32 : 0);
        // aReact2: x = intensity (flock: amplitude in metres), y = run/dive seconds, z = alert time (+start / -end),
        // w = run distance (metres) or the flock radius. Alert direction toward the player rides in x/w while
        // the group is alert and not reacting (deer only turn their heads then).
        const react2 = mesh.geometry.attributes.aReact2 as THREE.InstancedBufferAttribute;
        const alertT = e.alertAt ?? 0;
        if (r) {
          if (r.mode === 1) react2.setXYZW(index, r.dist * r.intensity, r.seconds, 0, e.radius);
          else react2.setXYZW(index, Math.max(0.05, r.intensity), r.seconds, 0, r.dist);
        } else if (alertT !== 0) {
          react2.setXYZW(index, e.alertZ ?? 0, 3, alertT, e.alertX ?? 0);
        } else {
          react2.setXYZW(index, 0, 3, 0, 0);
        }
      }
    }
    for (const kind of KINDS) {
      const mesh = target[kind]; mesh.count = used[kind];
      if (used[kind] > 0) { mesh.instanceMatrix.needsUpdate = true; mesh.geometry.attributes.aPhase.needsUpdate = true; mesh.geometry.attributes.aOrbit.needsUpdate = true; mesh.geometry.attributes.aReact.needsUpdate = true; mesh.geometry.attributes.aReact2.needsUpdate = true; }
      for (const other of this.rings[kind]) other.visible = other === mesh;
    }
  }

  /**
   * Threat the player poses to a group right now, 0..1: proximity to the nearest displayed member,
   * closing speed toward it, height above it and the player's speed. Flying high, slow or away
   * multiplies toward zero; a fast low pass straight at the group scores near one.
   */
  threatTo(e: Encounter, o: Observer, time: number): { threat: number; dist: number; towardX: number; towardZ: number } {
    const tune = e.kind === 'bird' ? REACT.bird : e.kind === 'deer' ? REACT.deer : REACT.duck;
    let best = Infinity, bx = 0, by = 0, bz = 0;
    for (let j = 0; j < e.count; j++) {
      const p = memberPosition(e, j, time);
      const d = Math.hypot(p.x - o.x, p.y - o.y, p.z - o.z);
      if (d < best) { best = d; bx = p.x; by = p.y; bz = p.z; }
    }
    if (best === Infinity) return { threat: 0, dist: Infinity, towardX: 0, towardZ: 0 };
    if (e.kind === 'bird') {
      // A flock is a ring 130-300 m across: a bird flying through its disc is among the flock even
      // when every member happens to be on the far side, so the ring itself counts as a target.
      const dh = Math.hypot(e.x - o.x, e.z - o.z), ring = Math.hypot(Math.max(0, dh - e.radius), o.y - e.y);
      if (ring < best) { best = ring; const k = dh > 1e-3 ? Math.min(1, e.radius / dh) : 0; bx = o.x + (e.x - o.x) * (1 - k); bz = o.z + (e.z - o.z) * (1 - k); by = e.y; }
    }
    const tx = (bx - o.x) / best, ty = (by - o.y) / best, tz = (bz - o.z) / best;
    const closing = o.vx * tx + o.vy * ty + o.vz * tz; // m/s toward the animal
    const speed = Math.hypot(o.vx, o.vy, o.vz);
    const reach = tune.radius * (o.boosting ? 1.5 : 1);
    const proximity = Math.max(0, 1 - best / reach);
    const approach = Math.min(1.3, Math.max(0, 0.3 + closing / 40));
    const above = e.kind === 'bird' ? Math.abs(o.y - by) : o.y - by;
    const height = Math.min(1, Math.max(0, 1 - (above - 15) / tune.height));
    const pace = Math.min(1.4, Math.max(0.4, 0.4 + speed / 45));
    const threat = Math.min(1, proximity * approach * height * pace);
    const hx = bx - o.x, hz = bz - o.z, hl = Math.hypot(hx, hz) || 1;
    return { threat, dist: best, towardX: -hx / hl, towardZ: -hz / hl };
  }

  /**
   * Low-rate behaviour pass over the groups near the player: the threat estimate drives a per-group
   * state machine (idle, alert, evade, recover) with hysteresis and cooldowns; evades are planned once
   * and then play on the GPU; expired runs are baked into the group position. Distances are checked
   * per member against the player only, never between animals.
   */
  private updateBehaviour(time: number, o: Observer, mode: WildlifeMode): void {
    const tier = mode === 'lively' ? 'lively' : 'subtle';
    let active = 0;
    for (const e of this.encounters.values()) if (e?.react && time < e.react.until) active++;
    let ripples = 0;
    for (const e of this.encounters.values()) {
      if (!e) continue;
      if (e.kind === 'fish') { if (e.react && time >= e.react.until) { e.react = null; e.state = 'idle'; this.dirty = true; } continue; }
      if (e.kind !== 'bird' && e.kind !== 'deer' && e.kind !== 'duck') continue;
      if (Math.abs(e.x - o.x) > REACT.scanRadius || Math.abs(e.z - o.z) > REACT.scanRadius) {
        if (e.state && e.state !== 'idle' && !e.react) { e.state = 'idle'; e.threat = 0; if (e.alertAt && e.alertAt > 0) { e.alertAt = -time; this.dirty = true; } }
        continue;
      }
      const tune = e.kind === 'bird' ? REACT.bird : e.kind === 'deer' ? REACT.deer : REACT.duck;
      const r = e.react;
      if (r && time >= r.until) {
        // Run over: bake the displacement so the next rebuild keeps the animals where they stopped.
        if (r.mode === 2 || r.mode === 3) { e.x += r.dirX * r.dist; e.z += r.dirZ * r.dist; e.y += r.dh; }
        e.react = null; e.state = 'recover'; e.stateSince = time; e.cooldownUntil = time + tune.cooldown;
        this.dirty = true; active--;
      }
      const t = this.threatTo(e, o, time);
      const prev = e.threat ?? 0;
      e.threat = prev + (t.threat - prev) * 0.5; // two scans to settle: a single grazing sample does not trip a state
      const threat = e.threat;
      const state = e.state ?? 'idle';
      const since = time - (e.stateSince ?? -Infinity);
      // Ducks swimming away leave a short ripple trail (budgeted; the ring pool is small); a skitter
      // throws bigger rings. Paddling ducks near the player leave a small wake ring every 1.8 s each.
      if (e.kind === 'duck' && this.onDuckRipple) {
        if (e.react && time - e.react.start < REACT.rippleSeconds) {
          const size = e.react.intensity >= REACT.duck.skitterAbove ? 0.65 : 0.4;
          for (let j = 0; j < e.count && ripples < REACT.rippleBudget; j++) { const p = memberPosition(e, j, time); this.onDuckRipple(p.x, p.z, size); ripples++; }
        } else if (!e.react && t.dist < REACT.duck.wakeRange) {
          const tick = Math.floor(time / REACT.duck.wakeSeconds);
          if (tick !== (e.wakeTick ?? -1)) {
            e.wakeTick = tick;
            const j = tick % e.count; // one member per tick, so a group of three wakes every 0.6 s on average
            if (ripples < REACT.rippleBudget) { const p = memberPosition(e, j, time); this.onDuckRipple(p.x, p.z, 0.22); ripples++; }
          }
        }
      }
      if (e.react) continue; // the GPU is playing the evade; the state advances when it expires
      const evadeAllowed = active < REACT.maxActive[tier] && time >= (e.cooldownUntil ?? -Infinity);
      const wantsEvade = threat >= REACT.evadeOn || (state === 'alert' && threat >= REACT.evadeOnAlerted && since >= REACT.alertMinSeconds);
      if (state === 'idle') {
        if (threat >= REACT.alertOn) { e.state = 'alert'; e.stateSince = time; e.alertAt = time; e.alertX = t.towardX; e.alertZ = t.towardZ; this.dirty = true; }
      } else if (state === 'alert') {
        if (wantsEvade && evadeAllowed && since >= REACT.alertMinSeconds) {
          const planned = this.planReaction(e, o, time, REACT.intensityScale[tier] * threat);
          if (planned) { e.react = planned; e.state = 'evade'; e.stateSince = time; e.alertAt = 0; active++; this.dirty = true; this.builtAt = -Infinity; }
          else e.cooldownUntil = time + 2; // nowhere safe to go: keep watching instead of running into the scenery
        } else if (threat < REACT.alertOff && since >= REACT.alertMinSeconds * 2) {
          e.state = 'idle'; e.stateSince = time; e.alertAt = -time; this.dirty = true;
        } else if (Math.abs(t.towardX - (e.alertX ?? 0)) + Math.abs(t.towardZ - (e.alertZ ?? 0)) > 0.35) {
          e.alertX = t.towardX; e.alertZ = t.towardZ; this.dirty = true; // head follows the player, updated only on real change
        }
      } else if (state === 'recover') {
        if (threat >= REACT.evadeOn && evadeAllowed) {
          const planned = this.planReaction(e, o, time, REACT.intensityScale[tier] * threat);
          if (planned) { e.react = planned; e.state = 'evade'; e.stateSince = time; active++; this.dirty = true; this.builtAt = -Infinity; }
        } else if (threat >= REACT.alertOn && since >= 0.5) {
          e.state = 'alert'; e.stateSince = time; e.alertAt = time; e.alertX = t.towardX; e.alertZ = t.towardZ; this.dirty = true;
        } else if (threat < REACT.evadeOffRecover && since >= REACT.recoverSeconds) {
          e.state = 'idle'; e.stateSince = time;
        }
      }
    }
  }

  /**
   * Plan an evade for a group at the given intensity (0..1). Flocks swing aside of the approach axis
   * (amplitude reduced if the ground rises under the swing). Deer and ducks run along the first of six
   * directions (away, then swung sideways, then back) whose whole corridor is usable: five stations
   * along the run and three lanes across the group's width, checked for ground they can use (deer:
   * land close to their own height, no steep step, no tree; ducks: water). No usable corridor: null.
   */
  planReaction(e: Encounter, o: { x: number; z: number }, time: number, intensity = 1): Reaction | null {
    intensity = Math.min(1, Math.max(0, intensity));
    let ax = e.x - o.x, az = e.z - o.z;
    const l = Math.hypot(ax, az);
    if (l < 1e-3) { ax = Math.cos(e.phase); az = Math.sin(e.phase); } else { ax /= l; az /= l; }
    if (e.kind === 'bird') {
      const tune = REACT.bird;
      let amplitude = tune.minDist + (tune.maxDist - tune.minDist) * intensity;
      // The swing must not carry the outer birds into a slope: check the ground under both sides.
      for (const side of [-1, 1]) {
        const sx = e.x - az * side * (e.radius + amplitude), sz = e.z + ax * side * (e.radius + amplitude);
        if (this.terrain.heightAt(sx, sz) > e.y - 12) amplitude *= 0.5;
      }
      return { start: time, dirX: ax, dirZ: az, mode: 1, dist: amplitude, dh: 0, seconds: tune.seconds, intensity: 1, until: time + tune.seconds + 0.5 };
    }
    const tune = e.kind === 'deer' ? REACT.deer : REACT.duck;
    // A duck that is dived at (threat above the skitter level) flutter-runs across the water instead
    // of paddling off: farther and faster, wings beating (the shader reads the intensity).
    const skitter = e.kind === 'duck' && intensity >= REACT.duck.skitterAbove;
    const dist = skitter ? REACT.duck.skitterDist : tune.minDist + (tune.maxDist - tune.minDist) * intensity;
    const seconds = skitter ? REACT.duck.skitterSeconds : tune.seconds;
    const halfWidth = e.kind === 'deer' ? 2.8 : 4.5; // group spread plus body
    for (const a of [0, 0.7, -0.7, 1.4, -1.4, Math.PI]) {
      const c = Math.cos(a), s = Math.sin(a);
      const dx = ax * c - az * s, dz = ax * s + az * c;
      const corridor = this.corridorUsable(e, dx, dz, dist, halfWidth);
      if (corridor !== null) return { start: time, dirX: dx, dirZ: dz, mode: e.kind === 'deer' ? 2 : 3, dist, dh: corridor, seconds, intensity, until: time + seconds + 0.4 + tune.hold };
    }
    return null;
  }

  /**
   * Ground change over the run if the corridor is usable, else null. Stations every 2.6 m (at least
   * five) on three lanes; the tree test radius covers the gap between stations plus the body, so a
   * trunk between two stations is still caught.
   */
  corridorUsable(e: Encounter, dx: number, dz: number, dist: number, halfWidth: number): number | null {
    const stations = Math.max(5, Math.ceil(dist / 2.6)), lanes = [-halfWidth, 0, halfWidth];
    const step = dist / stations;
    const px = -dz, pz = dx;
    let endH = e.y;
    for (const lane of lanes) {
      let prev = this.terrain.heightAt(e.x + px * lane, e.z + pz * lane);
      for (let i = 1; i <= stations; i++) {
        const along = step * i;
        const x = e.x + dx * along + px * lane, z = e.z + dz * along + pz * lane;
        const h = this.terrain.heightAt(x, z);
        if (e.kind === 'deer') {
          if (h <= 1.5 || Math.abs(h - e.y) > 5) return null; // water, or a drop / climb they would not take
          if (Math.abs(h - prev) > step * 0.45) return null; // a steep step
          if (this.terrain.treeNear(x, z, step * 0.5 + 0.35)) return null;
        } else if (h > -0.5) {
          return null; // ducks stay on water deep enough to swim
        }
        prev = h;
        if (lane === 0 && i === stations) endH = h;
      }
    }
    return e.kind === 'deer' ? endH - e.y : 0;
  }

  /**
   * The player touched or skimmed the water: the nearest shoal or two within reach dive and drift
   * away for a few seconds (no leaps meanwhile). Wired to the flight's existing water-contact events.
   */
  onWaterContact(x: number, z: number, strength: number, time: number): void {
    if (this.lastMode === 'off') return;
    const near: { e: Encounter; d: number }[] = [];
    for (const e of this.encounters.values()) {
      if (!e || e.kind !== 'fish') continue;
      const d = Math.hypot(e.x - x, e.z - z);
      if (d < REACT.fish.radius && !e.react && time >= (e.cooldownUntil ?? -Infinity)) near.push({ e, d });
    }
    near.sort((a, b) => a.d - b.d);
    for (const { e, d } of near.slice(0, 2)) {
      let ax = e.x - x, az = e.z - z;
      if (d < 1e-3) { ax = Math.cos(e.phase); az = Math.sin(e.phase); } else { ax /= d; az /= d; }
      const seconds = REACT.fish.seconds + 2 * Math.min(1, strength);
      e.react = { start: time, dirX: ax, dirZ: az, mode: 4, dist: 3, dh: 0, seconds, intensity: 1, until: time + seconds };
      e.state = 'evade'; e.stateSince = time; e.cooldownUntil = time + seconds + REACT.fish.cooldown;
      this.dirty = true; this.builtAt = -Infinity;
      this.onFishSplash?.(e.x, e.z, false); // the shoal breaks the surface as it turns down
    }
  }



  /** Groups currently reacting or alert, by kind (diagnostics and tests). */
  reactions(): { kind: Kind; state: BehaviourState; mode: number; x: number; z: number; until: number; threat: number }[] {
    const out: { kind: Kind; state: BehaviourState; mode: number; x: number; z: number; until: number; threat: number }[] = [];
    for (const e of this.encounters.values()) if (e && (e.react || (e.state && e.state !== 'idle'))) out.push({ kind: e.kind, state: e.state ?? 'idle', mode: e.react?.mode ?? 0, x: e.x, z: e.z, until: e.react?.until ?? 0, threat: e.threat ?? 0 });
    return out;
  }

  /** Groups within a radius of a point, with their behaviour (diagnostics and tests). */
  groupsNear(x: number, z: number, radius: number): { kind: Kind; x: number; y: number; z: number; count: number; radius: number; state: BehaviourState; threat: number }[] {
    const out: { kind: Kind; x: number; y: number; z: number; count: number; radius: number; state: BehaviourState; threat: number }[] = [];
    for (const e of this.encounters.values()) if (e && Math.hypot(e.x - x, e.z - z) <= radius) out.push({ kind: e.kind, x: e.x, y: e.y, z: e.z, count: e.count, radius: e.radius, state: e.state ?? 'idle', threat: e.threat ?? 0 });
    return out;
  }

  /** The encounter nearest a point of a kind, for tests and probes that want to poke one directly. */
  encounterNear(x: number, z: number, kind: Kind): Encounter | null {
    let best: Encounter | null = null, bd = Infinity;
    for (const e of this.encounters.values()) if (e && e.kind === kind) { const d = Math.hypot(e.x - x, e.z - z); if (d < bd) { bd = d; best = e; } }
    return best;
  }

  /** Mirror of the shader's leap cycle: a ring when a fish launches (cycle wraps) and a splash when it lands (cycle passes 0.32). */
  private fishSplashes(time: number): void {
    if (!this.onFishSplash) return;
    for (const f of this.fishInstances) {
      const cycle = ((time * f.rate + f.phase * 0.159) % 1 + 1) % 1;
      const prev = f.cycle; f.cycle = cycle;
      if (prev < 0) continue;
      if (f.e.react && time >= f.e.react.start && time < f.e.react.until) continue; // diving: no leaps, no splashes
      const at = (leap: number) => ({ x: f.x - Math.sin(f.heading) * (leap - 0.5) * f.len, z: f.z - Math.cos(f.heading) * (leap - 0.5) * f.len });
      if (cycle < prev) { const p = at(0); this.onFishSplash(p.x, p.z, false); }
      else if (prev < 0.32 && cycle >= 0.32) { const p = at(1); this.onFishSplash(p.x, p.z, true); }
    }
  }

  private nextSlot(kind: Kind): THREE.InstancedMesh {
    this.active[kind] = (this.active[kind] + 1) % RING;
    return this.rings[kind][this.active[kind]];
  }

  private activeMesh(kind: Kind): THREE.InstancedMesh { return this.rings[kind][this.active[kind]]; }

  counts(): WildlifeCounts {
    if (!this.group.visible) return { birds: 0, deer: 0, ducks: 0, balloons: 0, boats: 0, fish: 0 };
    return { birds: this.activeMesh('bird').count, deer: this.activeMesh('deer').count, ducks: this.activeMesh('duck').count, balloons: this.activeMesh('balloon').count, boats: this.activeMesh('boat').count, fish: this.activeMesh('fish').count };
  }
  dispose(): void {
    for (const kind of KINDS) for (const mesh of this.rings[kind]) { mesh.geometry.dispose(); mesh.dispose(); }
    for (const m of this.materials) m.dispose();
    this.group.clear();
  }
}
