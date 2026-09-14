/** Decorative wildlife: three instanced draws, deterministic habitats, no flight colliders. */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { type QualityPreset } from '../core/config';
import { Biome } from './biomes';
import { hash2, Rng } from './noise';
import { createTerrainSample, type WorldGen } from './WorldGen';

export type WildlifeMode = 'off' | 'subtle' | 'lively';
export function wildlifeBudget(mode: WildlifeMode, quality: QualityPreset): { birds: number; deer: number; ducks: number } {
  if (mode === 'off') return { birds: 0, deer: 0, ducks: 0 };
  const factor = quality === 'low' ? 0.6 : 1;
  const lively = mode === 'lively';
  return { birds: Math.round((lively ? 32 : 16) * factor), deer: Math.round((lively ? 12 : 6) * factor), ducks: Math.round((lively ? 16 : 8) * factor) };
}

/** Candidate points tried per ground cell before giving up on a pond. */
const GROUND_CANDIDATES = 4;

export type Habitat = 'deer' | 'duck' | null;
export function habitatAt(height: number, slope: number, biome: Biome): Habitat {
  if (height < -1 && height > -12 && slope < 0.2) return 'duck';
  if (height > 2 && slope < 0.22 && [Biome.Temperate, Biome.Upland, Biome.Wetland].includes(biome)) return 'deer';
  return null;
}

type Kind = 'bird' | 'deer' | 'duck';
const KINDS: readonly Kind[] = ['bird', 'deer', 'duck'];
interface Encounter { x: number; y: number; z: number; phase: number; kind: Kind; count: number; radius: number }
const CAPACITY: Record<Kind, number> = { bird: 32, deer: 12, duck: 16 };
const MAX_DISTANCE: Record<Kind, number> = { bird: 1600, deer: 550, duck: 550 };
const KIND_SCALE: Record<Kind, number> = { bird: 1.5, deer: 1, duck: 1 };
/** Instance buffers per kind. A rebuild writes the slot drawn longest ago, so the GPU is never reading the buffer being written. */
const RING = 3;
/** Player travel that triggers a new nearest-encounter selection. */
const REBUILD_DISTANCE = 100;
/** Coalesces the one-habitat-per-frame stream into a few uploads. */
const REBUILD_INTERVAL = 0.5;
const _matrix = new THREE.Matrix4(), _position = new THREE.Vector3(), _scale = new THREE.Vector3(), _rotation = new THREE.Quaternion();

function geometry(kind: 'bird' | 'deer' | 'duck'): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const ellipsoid = (x: number, y: number, z: number, sx: number, sy: number, sz: number, color: number, motion = 0) => {
    const g = new THREE.SphereGeometry(1, 8, 6); g.scale(sx, sy, sz); g.translate(x, y, z);
    const c = new THREE.Color(color), n = g.attributes.position.count, colors = new Float32Array(n * 3), weights = new Float32Array(n);
    for (let i = 0; i < n; i++) { colors.set([c.r, c.g, c.b], i * 3); weights[i] = motion; }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3)); g.setAttribute('aMotion', new THREE.BufferAttribute(weights, 1));
    parts.push(g);
  };
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
  private active: Record<Kind, number> = { bird: 0, deer: 0, duck: 0 };
  private materials: THREE.Material[] = [];
  private clock = { value: 0 };
  private encounters = new Map<string, Encounter | null>();
  private pending: { key: string; cx: number; cz: number; kind: 'ground' | 'air' }[] = [];
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
    this.rings = { bird: this.makeRing('bird'), deer: this.makeRing('deer'), duck: this.makeRing('duck') };
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
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        if (aMotion > 0.5 && aMotion < 1.5) {
          float beat = sin(uWildTime * 5.5 + aPhase);
          transformed.y += abs(position.x) * beat * 0.38;
          transformed.x *= 0.88 + 0.12 * cos(uWildTime * 5.5 + aPhase);
        } else if (aMotion > 1.5) {
          transformed.y += sin(uWildTime * 0.65 + aPhase) * 0.045;
        }
        vec3 wildCenter = (modelMatrix * instanceMatrix)[3].xyz;
        float wildFade = 1.0 - smoothstep(uMaxDistance * 0.8, uMaxDistance, distance(cameraPosition, wildCenter));
        transformed = wildRotate(transformed * wildFade, wildHeading);
        transformed += vec3(cos(wildAngle) * aOrbit.x, aOrbit.w * sin(uWildTime * 0.4 + aPhase), sin(wildAngle) * aOrbit.x);`);
    };
    material.customProgramCacheKey = () => 'skybound-wildlife-v2';
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

  private prepare(cx: number, cz: number, kind: 'ground' | 'air'): Encounter | null {
    const rng = new Rng(hash2(cx, cz, this.gen.seed ^ (kind === 'air' ? 0xb17d : 0xdeea)));
    const size = kind === 'air' ? 900 : 180;
    const x = (cx + 0.18 + rng.next() * 0.64) * size, z = (cz + 0.18 + rng.next() * 0.64) * size;
    const s = this.gen.sample(x, z, this.sample);
    if (kind === 'air') {
      const radius = 65 + rng.next() * 80;
      let y = Math.max(0, s.height);
      for (let i = 0; i < 8; i++) y = Math.max(y, this.gen.heightAt(x + Math.cos(i * Math.PI / 4) * (radius + 40), z + Math.sin(i * Math.PI / 4) * (radius + 40)));
      return { kind: 'bird', x, z, y: y + 75 + rng.next() * 80, phase: rng.next() * Math.PI * 2, radius, count: 4 + rng.int(4) };
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
      this.pending.sort((a, b) => {
        const distance = (v: typeof a) => Math.hypot((v.cx + 0.5) * (v.kind === 'air' ? 900 : 180) - px, (v.cz + 0.5) * (v.kind === 'air' ? 900 : 180) - pz);
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
    const budget = wildlifeBudget(mode, quality), used = { bird: 0, deer: 0, duck: 0 };
    const target: Record<Kind, THREE.InstancedMesh> = { bird: this.nextSlot('bird'), deer: this.nextSlot('deer'), duck: this.nextSlot('duck') };
    const sorted = Array.from(this.encounters.values()).filter((e): e is Encounter => e !== null).sort((a, b) => Math.hypot(a.x - px, a.z - pz) - Math.hypot(b.x - px, b.z - pz));
    for (const e of sorted) {
      const max = e.kind === 'bird' ? budget.birds : e.kind === 'deer' ? budget.deer : budget.ducks;
      if (Math.hypot(e.x - px, e.y - py, e.z - pz) > MAX_DISTANCE[e.kind]) continue;
      for (let j = 0; j < e.count && used[e.kind] < max; j++) {
        let x = e.x, z = e.z, y = e.y, radius = 0, speed = 0, angle0 = Math.PI - e.phase, bob = 0;
        if (e.kind === 'bird') {
          radius = e.radius + j * 6; speed = 0.08; angle0 = e.phase - j * 0.03; bob = 1.5; y += j * 0.6;
        } else if (e.kind === 'duck') {
          radius = 3 + j; speed = 0.045; angle0 = e.phase + j * 0.8; y = 0.015;
          // The complete swimming circle was checked when this habitat was created.
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

  counts(): { birds: number; deer: number; ducks: number } {
    return this.group.visible ? { birds: this.activeMesh('bird').count, deer: this.activeMesh('deer').count, ducks: this.activeMesh('duck').count } : { birds: 0, deer: 0, ducks: 0 };
  }
  dispose(): void {
    for (const kind of KINDS) for (const mesh of this.rings[kind]) { mesh.geometry.dispose(); mesh.dispose(); }
    for (const m of this.materials) m.dispose();
    this.group.clear();
  }
}
