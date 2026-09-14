/**
 * Deterministic landmarks: placement that fits the terrain, stable ids,
 * discovery radii, colliders, and procedural geometry built on demand.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LANDMARK_DISCOVERY_RADIUS, REGION_HALF_SIZE, SEA_LEVEL } from '../core/config';
import { Biome } from './biomes';
import { hash2, Rng } from './noise';
import { createTerrainSample, WorldGen } from './WorldGen';

export type LandmarkType = 'arch' | 'lighthouse' | 'ruins' | 'giant-tree' | 'shrine' | 'bridge' | 'stones' | 'tower';

export interface LandmarkCollider {
  /** Offset from landmark origin (global x/z = landmark + offset). */
  dx: number;
  dz: number;
  radius: number;
  bottom: number;
  top: number;
}

export interface Landmark {
  id: string;
  name: string;
  type: LandmarkType;
  x: number;
  y: number;
  z: number;
  heading: number;
  biome: Biome;
  discoveryRadius: number;
  colliders: LandmarkCollider[];
  /** Human description for the journal. */
  blurb: string;
}

const TYPE_LABEL: Record<LandmarkType, string> = {
  arch: 'Stone Arch',
  lighthouse: 'Lighthouse',
  ruins: 'Cliffside Ruins',
  'giant-tree': 'Giant Tree',
  shrine: 'Mountain Shrine',
  bridge: 'Canyon Bridge',
  stones: 'Standing Stones',
  tower: 'Watchtower',
};

const NAME_PARTS = {
  first: ['Gull', 'Ember', 'Hollow', 'Silver', 'Thorn', 'Wren', 'Ash', 'Cinder', 'Moss', 'Stone', 'Fen', 'Harrow', 'Bright', 'Dusk', 'Larch', 'Sable', 'Kestrel', 'Reed', 'Amber', 'Vale'],
  second: ['watch', 'reach', 'fall', 'crest', 'mere', 'gate', 'rest', 'point', 'haven', 'hold', 'wick', 'brook', 'tor', 'span', 'shade', 'hollow'],
};

const BLURBS: Record<LandmarkType, string> = {
  arch: 'Wind and rain carved this arch long before anyone flew through it.',
  lighthouse: 'Its lamp still turns at night, though no ships have called in years.',
  ruins: 'Broken columns cling to the slope. Whoever built here liked the view.',
  'giant-tree': 'An elder tree older than the forest around it. Birds nest in its crown.',
  shrine: 'A quiet shrine above the snow line. The wind sounds like bells here.',
  bridge: 'A span across the canyon, built to be flown under.',
  stones: 'A ring of standing stones. From above, the pattern is obvious.',
  tower: 'A lookout on the hill, with a view over three valleys.',
};

interface Criteria {
  type: LandmarkType;
  count: number;
  fit: (gen: WorldGen, x: number, z: number, s: ReturnType<typeof createTerrainSample>, slope: number) => number;
}

function nearWater(gen: WorldGen, x: number, z: number, dist: number): boolean {
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    if (gen.heightAt(x + Math.cos(a) * dist, z + Math.sin(a) * dist) < SEA_LEVEL) return true;
  }
  return false;
}

/** Height difference to the highest point at distance d in 8 directions. */
function ringRise(gen: WorldGen, x: number, z: number, d: number, h: number): { maxRise: number; dir: number } {
  let maxRise = -Infinity, dir = 0;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const r = gen.heightAt(x + Math.cos(a) * d, z + Math.sin(a) * d) - h;
    if (r > maxRise) {
      maxRise = r;
      dir = a;
    }
  }
  return { maxRise, dir };
}

const CRITERIA: Criteria[] = [
  {
    type: 'lighthouse', count: 2,
    fit: (gen, x, z, s, slope) => {
      if (s.height < 3 || s.height > 45 || slope > 0.35) return -1;
      if (!nearWater(gen, x, z, 160)) return -1;
      return 1 + (nearWater(gen, x, z, 90) ? 0.5 : 0) + s.height / 45;
    },
  },
  {
    type: 'arch', count: 2,
    fit: (gen, x, z, s, slope) => {
      if (s.height < 2 || slope > 0.45) return -1;
      const w = s.weights;
      const score = w[Biome.Coast] * 1.2 + w[Biome.Arid] * 1.4;
      return score > 0.3 ? score : -1;
    },
  },
  {
    type: 'ruins', count: 2,
    fit: (_gen, _x, _z, s, slope) => {
      if (s.height < 40 || slope < 0.3 || slope > 0.85) return -1;
      const w = s.weights;
      return 0.6 + w[Biome.Upland] + w[Biome.Alpine] * 0.6 + w[Biome.Temperate] * 0.4;
    },
  },
  {
    type: 'giant-tree', count: 2,
    fit: (_gen, _x, _z, s, slope) => {
      if (s.height < 15 || s.height > 260 || slope > 0.25) return -1;
      const w = s.weights;
      return w[Biome.Temperate] > 0.75 ? 1 + w[Biome.Temperate] : -1;
    },
  },
  {
    type: 'shrine', count: 2,
    fit: (gen, x, z, s, slope) => {
      if (s.height < 520 || slope > 1.0) return -1;
      const { maxRise } = ringRise(gen, x, z, 120, s.height);
      // Prefer local high points (summits and shoulders).
      return maxRise < 60 ? 1.5 + s.height / 1000 - maxRise / 80 - slope * 0.3 : -1;
    },
  },
  {
    type: 'bridge', count: 2,
    fit: (gen, x, z, s, slope) => {
      if (s.weights[Biome.Arid] < 0.6 || s.height < 5 || slope > 0.5) return -1;
      // Canyon floor: both sides across one axis rise steeply.
      const hx0 = gen.heightAt(x - 75, z), hx1 = gen.heightAt(x + 75, z);
      const hz0 = gen.heightAt(x, z - 75), hz1 = gen.heightAt(x, z + 75);
      const riseX = Math.min(hx0, hx1) - s.height;
      const riseZ = Math.min(hz0, hz1) - s.height;
      const best = Math.max(riseX, riseZ);
      return best > 55 ? 1 + best / 100 : -1;
    },
  },
  {
    type: 'stones', count: 2,
    fit: (_gen, _x, _z, s, slope) => {
      if (s.height < 4 || slope > 0.18) return -1;
      const w = s.weights;
      const score = w[Biome.Upland] * 1.3 + w[Biome.Wetland] * 1.0 + w[Biome.Temperate] * 0.5;
      return score > 0.5 ? score : -1;
    },
  },
  {
    type: 'tower', count: 2,
    fit: (gen, x, z, s, slope) => {
      if (s.height < 60 || s.height > 700 || slope > 0.3) return -1;
      const { maxRise } = ringRise(gen, x, z, 150, s.height);
      return maxRise < 15 ? 1 + s.height / 600 : -1;
    },
  },
];

const MIN_SPACING = 1400;

export function placeLandmarks(gen: WorldGen): Landmark[] {
  const rng = new Rng(hash2(99, 17, gen.seed));
  const s = createTerrainSample();
  const placed: Landmark[] = [];
  const usedNames = new Set<string>();
  const half = REGION_HALF_SIZE - 800;
  // Deterministic candidate cloud.
  const candidates: [number, number][] = [];
  for (let i = 0; i < 2600; i++) candidates.push([rng.range(-half, half), rng.range(-half, half)]);

  const makeName = (type: LandmarkType) => {
    for (let tries = 0; tries < 20; tries++) {
      const a = NAME_PARTS.first[rng.int(NAME_PARTS.first.length)];
      const b = NAME_PARTS.second[rng.int(NAME_PARTS.second.length)];
      const name = `${a}${b} ${TYPE_LABEL[type]}`;
      if (!usedNames.has(name)) {
        usedNames.add(name);
        return name;
      }
    }
    return `${TYPE_LABEL[type]} ${placed.length + 1}`;
  };

  for (const crit of CRITERIA) {
    const scored: { x: number; z: number; score: number; h: number; heading: number; biome: Biome }[] = [];
    for (const [x, z] of candidates) {
      gen.sample(x, z, s);
      const h = s.height;
      const slope = gen.slopeAt(x, z, 8);
      const score = crit.fit(gen, x, z, s, slope);
      if (score <= 0) continue;
      let heading = rng.next() * Math.PI * 2;
      if (crit.type === 'bridge') {
        const hx0 = gen.heightAt(x - 75, z), hx1 = gen.heightAt(x + 75, z);
        const hz0 = gen.heightAt(x, z - 75), hz1 = gen.heightAt(x, z + 75);
        heading = Math.min(hx0, hx1) > Math.min(hz0, hz1) ? Math.PI / 2 : 0; // span direction
      }
      scored.push({ x, z, score, h, heading, biome: s.biome });
    }
    scored.sort((a, b) => b.score - a.score || a.x - b.x || a.z - b.z);
    let n = 0;
    for (const c of scored) {
      if (n >= crit.count) break;
      if (placed.some((p) => Math.hypot(p.x - c.x, p.z - c.z) < MIN_SPACING)) continue;
      const id = `${crit.type}-${placed.length}-${Math.round(c.x)}_${Math.round(c.z)}`;
      placed.push({
        id,
        name: makeName(crit.type),
        type: crit.type,
        x: c.x,
        y: crit.type === 'bridge' ? c.h : c.h,
        z: c.z,
        heading: c.heading,
        biome: c.biome,
        discoveryRadius: LANDMARK_DISCOVERY_RADIUS,
        colliders: collidersFor(crit.type, gen, c.x, c.z, c.h, c.heading),
        blurb: BLURBS[crit.type],
      });
      n++;
    }
  }
  return placed;
}

function collidersFor(type: LandmarkType, gen: WorldGen, x: number, z: number, h: number, heading: number): LandmarkCollider[] {
  switch (type) {
    case 'lighthouse': return [{ dx: 0, dz: 0, radius: 5, bottom: h - 2, top: h + 34 }];
    case 'arch': return [
      { dx: -13, dz: 0, radius: 5, bottom: h - 2, top: h + 26 },
      { dx: 13, dz: 0, radius: 5, bottom: h - 2, top: h + 26 },
      { dx: 0, dz: 0, radius: 15, bottom: h + 16, top: h + 26 },
    ];
    case 'ruins': return [{ dx: 0, dz: 0, radius: 16, bottom: h - 4, top: h + 10 }];
    case 'giant-tree': return [
      { dx: 0, dz: 0, radius: 5, bottom: h - 2, top: h + 26 },
      { dx: 0, dz: 0, radius: 24, bottom: h + 22, top: h + 52 },
    ];
    case 'shrine': return [{ dx: 0, dz: 0, radius: 12, bottom: h - 2, top: h + 14 }];
    case 'bridge': {
      const dir = { x: Math.sin(heading), z: -Math.cos(heading) };
      const rim = Math.max(gen.heightAt(x + dir.x * 75, z + dir.z * 75), gen.heightAt(x - dir.x * 75, z - dir.z * 75));
      const deck = rim + 4;
      const out: LandmarkCollider[] = [];
      for (let k = -3; k <= 3; k++) out.push({ dx: dir.x * k * 22, dz: dir.z * k * 22, radius: 12, bottom: deck - 3, top: deck + 6 });
      return out;
    }
    case 'stones': return [{ dx: 0, dz: 0, radius: 14, bottom: h - 2, top: h + 7 }];
    case 'tower': return [{ dx: 0, dz: 0, radius: 6, bottom: h - 2, top: h + 24 }];
  }
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function paint(g: THREE.BufferGeometry, color: THREE.ColorRepresentation): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}
function at(g: THREE.BufferGeometry, x: number, y: number, z: number, ry = 0, rx = 0, rz = 0, scale: number | THREE.Vector3 = 1): THREE.BufferGeometry {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    typeof scale === 'number' ? new THREE.Vector3(scale, scale, scale) : scale,
  );
  g.applyMatrix4(m);
  return g;
}
function mergeAll(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const list = parts.map((p) => {
    const q = p.index ? p.toNonIndexed() : p;
    q.deleteAttribute('uv');
    return q;
  });
  const m = mergeGeometries(list, false)!;
  m.computeVertexNormals();
  m.computeBoundingSphere();
  for (const p of parts) p.dispose();
  return m;
}

const STONE = '#8d8779';
const STONE_DARK = '#6b665b';
const WOOD = '#7a5533';

/** Build geometry for a landmark in local space (origin at ground level). */
export function buildLandmarkGeometry(lm: Landmark, gen: WorldGen, rng: Rng): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  switch (lm.type) {
    case 'lighthouse': {
      parts.push(at(paint(new THREE.CylinderGeometry(7, 9, 3, 12), STONE_DARK), 0, 0.5, 0));
      parts.push(at(paint(new THREE.CylinderGeometry(2.6, 3.6, 24, 14), '#f2efe6'), 0, 14, 0));
      parts.push(at(paint(new THREE.CylinderGeometry(3.05, 3.35, 4, 14), '#c8352f'), 0, 8, 0));
      parts.push(at(paint(new THREE.CylinderGeometry(2.75, 2.95, 3.5, 14), '#c8352f'), 0, 18, 0));
      parts.push(at(paint(new THREE.CylinderGeometry(3.4, 3.0, 1.2, 14), STONE_DARK), 0, 26.6, 0));
      parts.push(at(paint(new THREE.CylinderGeometry(2.2, 2.2, 3.2, 10), '#ffe8a3'), 0, 28.8, 0));
      parts.push(at(paint(new THREE.ConeGeometry(3.0, 3.2, 12), '#3a3f48'), 0, 32.0, 0));
      break;
    }
    case 'arch': {
      // Sandstone in the desert, grey stone elsewhere.
      const arid = lm.biome === Biome.Arid;
      const light = arid ? '#c9743f' : STONE;
      const dark = arid ? '#9a4f2c' : STONE_DARK;
      const legH = 16;
      parts.push(at(paint(new THREE.CylinderGeometry(4.5, 6, legH, 9), light), -13, legH / 2, 0));
      parts.push(at(paint(new THREE.CylinderGeometry(4.5, 6, legH, 9), dark), 13, legH / 2, 0));
      const torus = new THREE.TorusGeometry(13, 4.2, 8, 18, Math.PI);
      parts.push(at(paint(torus, light), 0, legH, 0, 0, 0, 0));
      parts.push(at(paint(new THREE.CylinderGeometry(22, 26, 2.5, 14), dark), 0, 0.6, 0));
      break;
    }
    case 'ruins': {
      parts.push(at(paint(new THREE.BoxGeometry(30, 2.5, 22), STONE_DARK), 0, 0.8, 0, lm.heading));
      for (let i = 0; i < 9; i++) {
        const a = lm.heading;
        const cx = ((i % 3) - 1) * 10, cz = (Math.floor(i / 3) - 1) * 8;
        const hgt = 3 + rng.next() * 8;
        const rx = Math.cos(a) * cx - Math.sin(a) * cz, rz = Math.sin(a) * cx + Math.cos(a) * cz;
        parts.push(at(paint(new THREE.CylinderGeometry(1.1, 1.3, hgt, 8), i % 2 ? STONE : '#a09a8a'), rx, 2 + hgt / 2, rz));
      }
      parts.push(at(paint(new THREE.BoxGeometry(2, 7, 18), STONE), -14, 5, 0, lm.heading));
      parts.push(at(paint(new THREE.BoxGeometry(14, 5, 2), STONE), 4, 4, -10, lm.heading));
      break;
    }
    case 'giant-tree': {
      parts.push(at(paint(new THREE.CylinderGeometry(3.2, 5.5, 30, 12), '#5a3d26'), 0, 14, 0));
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.4;
        parts.push(at(paint(new THREE.CylinderGeometry(1.2, 2.0, 16, 7), '#5a3d26'), Math.cos(a) * 7, 30, Math.sin(a) * 7, 0, Math.sin(a) * 0.7, -Math.cos(a) * 0.7));
      }
      const crowns: [number, number, number, number, string][] = [
        [0, 40, 0, 15, '#3d7a2f'], [11, 36, 4, 10, '#4a8a36'], [-10, 37, -5, 10, '#356e2a'], [3, 34, -12, 9, '#4d8f3c'], [-4, 35, 11, 9, '#3f7d30'], [0, 49, 0, 8, '#57a044'],
      ];
      for (const [x, y, z, r, c] of crowns) parts.push(at(paint(new THREE.IcosahedronGeometry(r, 1), c), x, y, z, rng.next() * 3));
      break;
    }
    case 'shrine': {
      parts.push(at(paint(new THREE.CylinderGeometry(12, 13, 2, 10), STONE_DARK), 0, 1, 0));
      parts.push(at(paint(new THREE.CylinderGeometry(9, 10, 1.5, 10), STONE), 0, 2.7, 0));
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        parts.push(at(paint(new THREE.CylinderGeometry(0.6, 0.7, 7, 8), '#a33a2a'), Math.cos(a) * 5, 6.5, Math.sin(a) * 5));
      }
      parts.push(at(paint(new THREE.ConeGeometry(9, 4, 4), '#2f3540'), 0, 12, 0, Math.PI / 4));
      parts.push(at(paint(new THREE.ConeGeometry(5, 3, 4), '#2f3540'), 0, 15, 0, Math.PI / 4));
      parts.push(at(paint(new THREE.CylinderGeometry(0.4, 0.4, 5, 6), '#a33a2a'), 0, 5.5, 0));
      // Torii gate at the approach
      parts.push(at(paint(new THREE.CylinderGeometry(0.5, 0.6, 8, 8), '#a33a2a'), -3, 6, 16));
      parts.push(at(paint(new THREE.CylinderGeometry(0.5, 0.6, 8, 8), '#a33a2a'), 3, 6, 16));
      parts.push(at(paint(new THREE.BoxGeometry(9, 0.7, 0.9), '#a33a2a'), 0, 10, 16));
      break;
    }
    case 'bridge': {
      const dir = { x: Math.sin(lm.heading), z: -Math.cos(lm.heading) };
      const rimA = gen.heightAt(lm.x + dir.x * 75, lm.z + dir.z * 75);
      const rimB = gen.heightAt(lm.x - dir.x * 75, lm.z - dir.z * 75);
      const deck = Math.max(rimA, rimB) + 4 - lm.y;
      parts.push(at(paint(new THREE.BoxGeometry(8, 3, 164), WOOD), 0, deck, 0, lm.heading));
      for (const side of [-1, 1]) {
        parts.push(at(paint(new THREE.BoxGeometry(0.6, 2.6, 164), '#5a3d26'), side * 3.9, deck + 2.4, 0, lm.heading));
        // Suspension-style posts along the deck.
        for (let k = -3; k <= 3; k++) {
          parts.push(at(paint(new THREE.BoxGeometry(0.8, 9, 0.8), '#5a3d26'), side * 3.9 + dir.x * k * 22, deck + 5.5, dir.z * k * 22, lm.heading));
        }
      }
      for (let k = -3; k <= 3; k++) {
        const px = dir.x * k * 22, pz = dir.z * k * 22;
        const ground = gen.heightAt(lm.x + px, lm.z + pz) - lm.y;
        const hgt = deck - ground + 1;
        if (hgt > 2) parts.push(at(paint(new THREE.CylinderGeometry(2.0, 3.0, hgt, 8), STONE_DARK), px, ground + hgt / 2, pz));
      }
      for (const e of [-1, 1]) {
        parts.push(at(paint(new THREE.BoxGeometry(12, 14, 7), STONE), dir.x * e * 84, deck + 5, dir.z * e * 84, lm.heading));
      }
      break;
    }
    case 'stones': {
      const n = 9;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const hgt = 5 + rng.next() * 3;
        parts.push(at(paint(new THREE.BoxGeometry(2.2, hgt, 1.2), i % 2 ? STONE : STONE_DARK), Math.cos(a) * 12, hgt / 2 - 0.4, Math.sin(a) * 12, -a + rng.next() * 0.2));
      }
      parts.push(at(paint(new THREE.BoxGeometry(3, 1.6, 3), STONE_DARK), 0, 0.6, 0, 0.6));
      break;
    }
    case 'tower': {
      parts.push(at(paint(new THREE.CylinderGeometry(4.2, 5.2, 20, 12), STONE), 0, 10, 0));
      parts.push(at(paint(new THREE.CylinderGeometry(5.2, 4.6, 2, 12), STONE_DARK), 0, 21, 0));
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        parts.push(at(paint(new THREE.BoxGeometry(1.6, 1.8, 1.0), STONE_DARK), Math.cos(a) * 4.6, 22.8, Math.sin(a) * 4.6, -a));
      }
      parts.push(at(paint(new THREE.CylinderGeometry(0.12, 0.12, 6, 5), WOOD), 0, 25, 0));
      parts.push(at(paint(new THREE.BoxGeometry(2.6, 1.4, 0.06), '#d8452e'), 1.3, 27.2, 0));
      parts.push(at(paint(new THREE.BoxGeometry(4, 3.5, 1), WOOD), 0, 1.7, 5));
      break;
    }
  }
  return mergeAll(parts);
}

/**
 * Manages landmark meshes near the player and discovery events.
 */
export class LandmarkManager {
  readonly landmarks: Landmark[];
  private meshes = new Map<string, THREE.Mesh>();
  private root: THREE.Group;
  private gen: WorldGen;
  private material: THREE.MeshLambertMaterial;
  private lastCheck = -1;
  private byId = new Map<string, Landmark>();

  constructor(root: THREE.Group, gen: WorldGen) {
    this.root = root;
    this.gen = gen;
    this.landmarks = placeLandmarks(gen);
    for (const l of this.landmarks) this.byId.set(l.id, l);
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });
  }

  get(id: string): Landmark | undefined {
    return this.byId.get(id);
  }

  setShadows(on: boolean): void {
    for (const m of this.meshes.values()) {
      m.castShadow = on;
      m.receiveShadow = on;
    }
  }

  /** Build/dispose meshes based on distance; call ~ every 0.5 s. */
  update(gx: number, gz: number, now: number, shadows: boolean): void {
    if (now - this.lastCheck < 0.5) return;
    this.lastCheck = now;
    for (const lm of this.landmarks) {
      const d = Math.hypot(lm.x - gx, lm.z - gz);
      const has = this.meshes.has(lm.id);
      if (d < 4200 && !has) {
        const rng = new Rng(hash2(7, 3, this.gen.seed) ^ hash2(Math.round(lm.x), Math.round(lm.z), 5));
        const g = buildLandmarkGeometry(lm, this.gen, rng);
        const mesh = new THREE.Mesh(g, this.material);
        mesh.position.set(lm.x, lm.y, lm.z);
        mesh.castShadow = shadows;
        mesh.receiveShadow = shadows;
        this.root.add(mesh);
        this.meshes.set(lm.id, mesh);
      } else if (d > 5200 && has) {
        const mesh = this.meshes.get(lm.id)!;
        this.root.remove(mesh);
        mesh.geometry.dispose();
        this.meshes.delete(lm.id);
      }
    }
  }

  /** Debug: currently instantiated landmark meshes. */
  meshInfo(): { id: string; type: LandmarkType; x: number; y: number; z: number; radius: number; vertices: number; visible: boolean }[] {
    const out: { id: string; type: LandmarkType; x: number; y: number; z: number; radius: number; vertices: number; visible: boolean }[] = [];
    for (const [id, m] of this.meshes) {
      const lm = this.byId.get(id)!;
      out.push({
        id, type: lm.type, x: m.position.x, y: m.position.y, z: m.position.z,
        radius: m.geometry.boundingSphere?.radius ?? -1, vertices: m.geometry.attributes.position?.count ?? 0, visible: m.visible,
      });
    }
    return out;
  }

  /** Landmarks whose discovery radius contains the point. */
  within(gx: number, gz: number): Landmark[] {
    return this.landmarks.filter((l) => Math.hypot(l.x - gx, l.z - gz) < l.discoveryRadius);
  }

  /** Visit landmark colliders near a point (global coordinates). */
  forEachColliderNear(gx: number, gz: number, radius: number, cb: (x: number, z: number, r: number, bottom: number, top: number) => boolean | void): void {
    for (const lm of this.landmarks) {
      if (Math.abs(lm.x - gx) > 260 + radius || Math.abs(lm.z - gz) > 260 + radius) continue;
      for (const c of lm.colliders) {
        const cx = lm.x + c.dx, cz = lm.z + c.dz;
        const rr = radius + c.radius;
        if ((cx - gx) ** 2 + (cz - gz) ** 2 > rr * rr) continue;
        if (cb(cx, cz, c.radius, c.bottom, c.top) === true) return;
      }
    }
  }

  dispose(): void {
    for (const m of this.meshes.values()) {
      this.root.remove(m);
      m.geometry.dispose();
    }
    this.meshes.clear();
    this.material.dispose();
  }
}
