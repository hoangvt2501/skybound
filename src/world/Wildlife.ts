/** Decorative ambient life: instanced flocks, deer, ducks, hot-air balloons and sailboats; deterministic habitats, no flight colliders. */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { type QualityPreset } from '../core/config';
import { Biome } from './biomes';
import { hash2, Rng } from './noise';
import { createTerrainSample, type WorldGen } from './WorldGen';

export type WildlifeMode = 'off' | 'subtle' | 'lively';
export interface WildlifeCounts { birds: number; deer: number; ducks: number; balloons: number; boats: number }
export function wildlifeBudget(mode: WildlifeMode, quality: QualityPreset): WildlifeCounts {
  if (mode === 'off') return { birds: 0, deer: 0, ducks: 0, balloons: 0, boats: 0 };
  const factor = quality === 'low' ? 0.6 : 1;
  const lively = mode === 'lively';
  return {
    birds: Math.round((lively ? 32 : 16) * factor), deer: Math.round((lively ? 12 : 6) * factor), ducks: Math.round((lively ? 16 : 8) * factor),
    balloons: lively ? 3 : 2, boats: Math.round((lively ? 5 : 3) * factor),
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

type Kind = 'bird' | 'deer' | 'duck' | 'balloon' | 'boat';
const KINDS: readonly Kind[] = ['bird', 'deer', 'duck', 'balloon', 'boat'];
interface Encounter { x: number; y: number; z: number; phase: number; kind: Kind; count: number; radius: number }
type JobKind = 'ground' | 'air' | 'balloon';
const CAPACITY: Record<Kind, number> = { bird: 32, deer: 12, duck: 16, balloon: 3, boat: 5 };
const MAX_DISTANCE: Record<Kind, number> = { bird: 1600, deer: 550, duck: 550, balloon: 2800, boat: 1400 };
const KIND_SCALE: Record<Kind, number> = { bird: 1.5, deer: 1, duck: 1, balloon: 1, boat: 1 };
const BUDGET_KEY: Record<Kind, keyof WildlifeCounts> = { bird: 'birds', deer: 'deer', duck: 'ducks', balloon: 'balloons', boat: 'boats' };
/** Instance buffers per kind. A rebuild writes the slot drawn longest ago, so the GPU is never reading the buffer being written. */
const RING = 3;
/** Player travel that triggers a new nearest-encounter selection. */
const REBUILD_DISTANCE = 100;
/** Coalesces the one-habitat-per-frame stream into a few uploads. */
const REBUILD_INTERVAL = 0.5;
const _matrix = new THREE.Matrix4(), _position = new THREE.Vector3(), _scale = new THREE.Vector3(), _rotation = new THREE.Quaternion();

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
    ellipsoid(0, 1.26, -0.49, 0.17, 0.4, 0.21, 0xa58465);
    ellipsoid(0, 1.52, -0.66, 0.17, 0.18, 0.32, 0xb09472, 2);
    ellipsoid(0, 1.45, -0.91, 0.1, 0.09, 0.07, 0x45372c, 2);
    for (const side of [-1, 1]) {
      ellipsoid(side * 0.17, 1.78, -0.58, 0.08, 0.19, 0.05, 0xb09876, 2);
      for (const z of [-0.36, 0.37]) ellipsoid(side * 0.18, 0.45, z, 0.055, 0.47, 0.06, 0x695445);
    }
    ellipsoid(0, 1.1, 0.62, 0.09, 0.11, 0.18, 0xe4d6b9, 2);
  } else {
    ellipsoid(0, 0.18, 0, 0.21, 0.18, 0.37, 0xa5957e);
    ellipsoid(0, 0.4, -0.22, 0.1, 0.16, 0.11, 0x466555, 2);
    ellipsoid(0, 0.53, -0.28, 0.13, 0.12, 0.14, 0x3b6b51, 2);
    ellipsoid(0, 0.49, -0.44, 0.11, 0.03, 0.1, 0xd9b55a, 2);
    for (const side of [-1, 1]) ellipsoid(side * 0.18, 0.21, 0.04, 0.06, 0.11, 0.23, 0x625c56);
  }
  const merged = mergeGeometries(parts, false)!;
  for (const part of parts) part.dispose();
  return merged;
}

export class Wildlife {
  readonly group = new THREE.Group();
  private rings: Record<Kind, THREE.InstancedMesh[]>;
  private active: Record<Kind, number> = { bird: 0, deer: 0, duck: 0, balloon: 0, boat: 0 };
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

  constructor(private gen: WorldGen, private surfaceAt: (x: number, z: number) => number) {
    this.rings = { bird: this.makeRing('bird'), deer: this.makeRing('deer'), duck: this.makeRing('duck'), balloon: this.makeRing('balloon'), boat: this.makeRing('boat') };
    this.group.name = 'Ambient wildlife';
  }

  /**
   * Animals move on the GPU: the instance matrix holds only the encounter
   * center; the per-instance orbit (radius, angular speed, start angle, bob)
   * and the distance fade are evaluated in the vertex shader from uWildTime
   * and cameraPosition. Instance buffers therefore change only when the set of
   * nearby encounters changes. Re-uploading them every frame (the previous
   * design) made ANGLE/Direct3D wait for the GPU to release the buffer and
   * produced periodic 50 ms frames on an integrated GPU.
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
        vec3 wildRotate(vec3 v, float heading) { float c = cos(heading), s = sin(heading); return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z); }`);
      shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        float wildAngle = aOrbit.z + uWildTime * aOrbit.y;
        float wildHeading = PI - wildAngle; // local -Z forward follows the circle tangent
        objectNormal = wildRotate(objectNormal, wildHeading);`);
      shader.vertexShader = shader.vertexShader.replace('#include <color_vertex>', `#include <color_vertex>
        #ifdef USE_COLOR
        if (aMotion > 3.5 && aMotion < 4.5) { // balloon envelope: rotate the two gore colours per instance
          float tint = fract(aPhase * 0.618);
          if (tint > 0.66) vColor.rgb = vColor.rgb.brg; else if (tint > 0.33) vColor.rgb = vColor.rgb.gbr;
        }
        #endif`);
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        if (aMotion > 0.5 && aMotion < 1.5) {
          float beat = sin(uWildTime * 5.5 + aPhase);
          transformed.y += abs(position.x) * beat * 0.38;
          transformed.x *= 0.88 + 0.12 * cos(uWildTime * 5.5 + aPhase);
        } else if (aMotion > 1.5 && aMotion < 2.5) {
          transformed.y += sin(uWildTime * 0.65 + aPhase) * 0.045;
        } else if (aMotion > 2.5 && aMotion < 3.5) {
          transformed.y += sin(uWildTime * 0.9 + aPhase) * 0.22; // sailboat heave
          transformed.x += position.y * sin(uWildTime * 0.7 + aPhase) * 0.06; // and a little roll
        } else if (aMotion > 3.5) {
          transformed.y += sin(uWildTime * 0.3 + aPhase) * 1.6; // balloon drift
        }
        vec3 wildCenter = (modelMatrix * instanceMatrix)[3].xyz;
        float wildFade = 1.0 - smoothstep(uMaxDistance * 0.8, uMaxDistance, distance(cameraPosition, wildCenter));
        transformed = wildRotate(transformed * wildFade, wildHeading);
        transformed += vec3(cos(wildAngle) * aOrbit.x, aOrbit.w * sin(uWildTime * 0.4 + aPhase), sin(wildAngle) * aOrbit.x);`);
    };
    material.customProgramCacheKey = () => 'skybound-wildlife-v3';
    this.materials.push(material);
    const ring: THREE.InstancedMesh[] = [];
    for (let slot = 0; slot < RING; slot++) {
      const g = slot === 0 ? base : base.clone();
      const capacity = CAPACITY[kind];
      g.setAttribute('aPhase', new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1));
      g.setAttribute('aOrbit', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4));
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
      const radius = 65 + rng.next() * 80;
      let y = Math.max(0, s.height);
      for (let i = 0; i < 8; i++) y = Math.max(y, this.gen.heightAt(x + Math.cos(i * Math.PI / 4) * (radius + 40), z + Math.sin(i * Math.PI / 4) * (radius + 40)));
      return { kind: 'bird', x, z, y: y + 75 + rng.next() * 80, phase: rng.next() * Math.PI * 2, radius, count: 4 + rng.int(4) };
    }
    // Open water: a sailboat on roughly one deep-water cell in six, given 80 m of clear water around its circle.
    if (s.height < -6) {
      if (rng.next() > 0.18) return null;
      for (let i = 0; i < 8; i++) if (this.gen.heightAt(x + Math.cos(i * Math.PI / 4) * 80, z + Math.sin(i * Math.PI / 4) * 80) > -3) return null;
      return { kind: 'boat', x, z, y: 0, phase: rng.next() * Math.PI * 2, radius: 45, count: 1 };
    }
    // Ponds cover only a few percent of a wetland cell, so a single random
    // point almost never lands on water and ducks would be a rarity. Try a few
    // candidates per cell and prefer the first one that sits on a pond; the
    // first suitable meadow point is the fallback, so deer density elsewhere
    // is unchanged. The cell RNG keeps every candidate deterministic per seed.
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

  update(time: number, px: number, py: number, pz: number, ox: number, oz: number, mode: WildlifeMode, quality: QualityPreset): void {
    this.clock.value = time;
    this.group.visible = mode !== 'off';
    if (mode === 'off') { this.lastMode = mode; return; }
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
    const moved = !(Math.hypot(px - this.builtX, pz - this.builtZ) <= REBUILD_DISTANCE);
    const rebased = ox !== this.builtOX || oz !== this.builtOZ;
    const drained = job !== undefined && this.pending.length === 0; // last habitat of a cell change: show it even if the clock is paused
    if (changed || moved || rebased || drained || (this.dirty && time - this.builtAt >= REBUILD_INTERVAL)) this.rebuild(time, px, py, pz, ox, oz, mode, quality);
  }

  /** Select the nearest encounters within budget and write them into the next ring slot of each kind. */
  private rebuild(time: number, px: number, py: number, pz: number, ox: number, oz: number, mode: WildlifeMode, quality: QualityPreset): void {
    this.dirty = false; this.builtAt = time; this.builtX = px; this.builtZ = pz; this.builtOX = ox; this.builtOZ = oz;
    const budget = wildlifeBudget(mode, quality), used: Record<Kind, number> = { bird: 0, deer: 0, duck: 0, balloon: 0, boat: 0 };
    const target: Record<Kind, THREE.InstancedMesh> = { bird: this.nextSlot('bird'), deer: this.nextSlot('deer'), duck: this.nextSlot('duck'), balloon: this.nextSlot('balloon'), boat: this.nextSlot('boat') };
    const sorted = Array.from(this.encounters.values()).filter((e): e is Encounter => e !== null).sort((a, b) => Math.hypot(a.x - px, a.z - pz) - Math.hypot(b.x - px, b.z - pz));
    for (const e of sorted) {
      const max = budget[BUDGET_KEY[e.kind]];
      if (Math.hypot(e.x - px, e.y - py, e.z - pz) > MAX_DISTANCE[e.kind]) continue;
      for (let j = 0; j < e.count && used[e.kind] < max; j++) {
        let x = e.x, z = e.z, y = e.y, radius = 0, speed = 0, angle0 = Math.PI - e.phase, bob = 0;
        if (e.kind === 'bird') {
          radius = e.radius + j * 6; speed = 0.08; angle0 = e.phase - j * 0.03; bob = 1.5; y += j * 0.6;
        } else if (e.kind === 'duck') {
          radius = 3 + j; speed = 0.045; angle0 = e.phase + j * 0.8; y = 0.015;
          // The complete swimming circle was checked when this habitat was created.
        } else if (e.kind === 'balloon') {
          radius = e.radius; speed = 0.012; angle0 = e.phase;
        } else if (e.kind === 'boat') {
          radius = e.radius; speed = 0.028; angle0 = e.phase; y = 0.05;
        } else {
          x += j * 3.2; z += j * 2; y = this.surfaceAt(x, z);
          if (y <= 1) continue;
        }
        const mesh = target[e.kind], index = used[e.kind]++;
        _position.set(x - ox, y, z - oz); _scale.setScalar(KIND_SCALE[e.kind]); _rotation.identity();
        mesh.setMatrixAt(index, _matrix.compose(_position, _rotation, _scale));
        (mesh.geometry.attributes.aPhase as THREE.InstancedBufferAttribute).setX(index, e.phase + j);
        (mesh.geometry.attributes.aOrbit as THREE.InstancedBufferAttribute).setXYZW(index, radius, speed, angle0, bob);
      }
    }
    for (const kind of KINDS) {
      const mesh = target[kind]; mesh.count = used[kind];
      if (used[kind] > 0) { mesh.instanceMatrix.needsUpdate = true; mesh.geometry.attributes.aPhase.needsUpdate = true; mesh.geometry.attributes.aOrbit.needsUpdate = true; }
      for (const other of this.rings[kind]) other.visible = other === mesh;
    }
  }

  private nextSlot(kind: Kind): THREE.InstancedMesh {
    this.active[kind] = (this.active[kind] + 1) % RING;
    return this.rings[kind][this.active[kind]];
  }

  private activeMesh(kind: Kind): THREE.InstancedMesh { return this.rings[kind][this.active[kind]]; }

  counts(): WildlifeCounts {
    if (!this.group.visible) return { birds: 0, deer: 0, ducks: 0, balloons: 0, boats: 0 };
    return { birds: this.activeMesh('bird').count, deer: this.activeMesh('deer').count, ducks: this.activeMesh('duck').count, balloons: this.activeMesh('balloon').count, boats: this.activeMesh('boat').count };
  }
  dispose(): void {
    for (const kind of KINDS) for (const mesh of this.rings[kind]) { mesh.geometry.dispose(); mesh.dispose(); }
    for (const m of this.materials) m.dispose();
    this.group.clear();
  }
}
