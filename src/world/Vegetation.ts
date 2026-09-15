/**
 * Procedural vegetation library.
 *
 *  - Full trees (near/mid field): trunk with taper and lean, visible main
 *    branches, layered asymmetric crowns built from noise-displaced leaf
 *    clusters (or jittered, drooping tiers for conifers). Several
 *    deterministic geometry variants for the main species; on top of that a
 *    per-instance random drives crown displacement and wind in the shader so
 *    no two trees read identical.
 *  - Impostors (far field): two crossed alpha-tested quads sampling a
 *    procedural canvas atlas, one tile per species.
 *  - Ground cover (near field): alpha-tested grass tufts that fade with
 *    distance.
 * All geometry is shared; instancing and bounded streaming are preserved.
 */
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rng, Simplex2, hash2 } from './noise';
import { SPECIES_COUNT, Species } from './biomes';

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

const DISSOLVE_FRAG = /* glsl */ `
  varying float vLifeFade;
`;
const DISSOLVE_TEST = /* glsl */ `
  if (vLifeFade < 0.999) {
    // Screen-door dissolve: instances appear and vanish as a grain that fills in over 0.7 s
    // instead of popping whole.
    float grain = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453);
    if (grain > vLifeFade) discard;
  }
`;

const VEG_VERTEX_HEAD = /* glsl */ `
  attribute vec2 aLife;     // x: birth time, y: death time (1e9 = alive)
  varying float vLifeFade;
  uniform float uLifeTime;

  attribute vec2 aVeg;      // x: sway weight (0 base .. 1 crown top), y: crown mask
  attribute float aRand;    // per-instance random 0..1
  uniform float uTime;
  uniform vec2 uWind;
  uniform float uWindStrength;
  float vHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vNoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = vHash(i), b = vHash(i + vec2(1.0, 0.0)), c = vHash(i + vec2(0.0, 1.0)), d = vHash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
`;

const VEG_VERTEX_BODY = /* glsl */ `
  {
    #ifdef USE_INSTANCING
      float lifeIn = clamp((uLifeTime - aLife.x) / 0.7, 0.0, 1.0);
      float lifeOut = aLife.y > uLifeTime ? 1.0 : clamp(1.0 - (uLifeTime - aLife.y) / 0.7, 0.0, 1.0);
      vLifeFade = lifeIn * lifeOut;
    #else
      vLifeFade = 1.0;
    #endif

    float crown = aVeg.y;
    float sway = aVeg.x;
    // Per-instance crown irregularity along the (smooth) normal.
    float bump = vNoise(transformed.xz * 0.55 + transformed.y * 0.4 + aRand * 41.0) - 0.5;
    transformed += objectNormal * bump * 0.2 * crown;
    // Slight per-instance crown stretch.
    transformed.xz *= 1.0 + (aRand - 0.5) * 0.18 * crown;
    transformed.y *= 1.0 + (fract(aRand * 7.31) - 0.5) * 0.14 * crown;
    // Wind: coherent world direction rotated into object space; anchored trunk.
    #ifdef USE_INSTANCING
      vec2 r = normalize(instanceMatrix[0].xz);
      vec2 ow = vec2(r.x * uWind.x + r.y * uWind.y, -r.y * uWind.x + r.x * uWind.y);
      float phase = dot(instanceMatrix[3].xz, vec2(0.031, 0.047)) + aRand * 6.28;
    #else
      vec2 ow = uWind;
      float phase = aRand * 6.28;
    #endif
    float gust = sin(uTime * 1.15 + phase) * 0.6 + sin(uTime * 2.7 + phase * 1.9) * 0.3 + sin(uTime * 0.37 + phase * 0.5) * 0.5;
    float amp = uWindStrength * sway * sway * (0.35 + 0.65 * crown);
    transformed.xz += ow * gust * amp;
    transformed.y -= abs(gust) * amp * 0.15;
  }
`;

export interface VegUniforms {
  uTime: { value: number };
  uLifeTime: { value: number };
  uWind: { value: THREE.Vector2 };
  uWindStrength: { value: number };
}

export class VegetationMaterial extends THREE.MeshLambertMaterial {
  readonly vegUniforms: VegUniforms;
  /**
   * `dissolve` compiles in the screen-door test (a fragment discard, which costs early depth
   * rejection); the settled twin leaves it out. Twins share one uniform set.
   */
  constructor(readonly dissolve = false, uniforms?: VegUniforms) {
    super({ vertexColors: true });
    this.vegUniforms = uniforms ?? { uTime: { value: 0 }, uLifeTime: { value: 0 }, uWind: { value: new THREE.Vector2(0.8, 0.6) }, uWindStrength: { value: 0.45 } };
    this.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.vegUniforms.uTime;
      shader.uniforms.uLifeTime = this.vegUniforms.uLifeTime;
      shader.uniforms.uWind = this.vegUniforms.uWind;
      shader.uniforms.uWindStrength = this.vegUniforms.uWindStrength;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VEG_VERTEX_HEAD}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VEG_VERTEX_BODY}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>${DISSOLVE_FRAG}`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>${this.dissolve ? DISSOLVE_TEST : ''}`);
    };
    this.customProgramCacheKey = () => `skybound-veg-v3-${this.dissolve ? 'd' : 's'}`;
  }
}

/** Alpha-tested billboard material for impostors and ground cover with distance fade. */
export interface BillboardUniforms {
  uTime: { value: number };
  uLifeTime: { value: number };
  uWind: { value: THREE.Vector2 };
  uTiles: { value: number };
  uFadeStart: { value: number };
  uFadeEnd: { value: number };
  uSway: { value: number };
}

class BillboardMaterial extends THREE.MeshLambertMaterial {
  readonly bbUniforms: BillboardUniforms;
  constructor(map: THREE.Texture, tiles: number, fadeStart: number, fadeEnd: number, sway: number, readonly dissolve = false, uniforms?: BillboardUniforms) {
    super({ map, alphaTest: 0.45, side: THREE.DoubleSide, transparent: false });
    this.bbUniforms = uniforms ?? { uTime: { value: 0 }, uLifeTime: { value: 0 }, uWind: { value: new THREE.Vector2(0.8, 0.6) }, uTiles: { value: 8 }, uFadeStart: { value: 100000 }, uFadeEnd: { value: 100001 }, uSway: { value: 0 } };
    this.bbUniforms.uTiles.value = tiles;
    this.bbUniforms.uFadeStart.value = fadeStart;
    this.bbUniforms.uFadeEnd.value = fadeEnd;
    this.bbUniforms.uSway.value = sway;
    this.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.bbUniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute float aTile;
          attribute float aRand;
  attribute vec2 aLife;     // x: birth time, y: death time (1e9 = alive)
  varying float vLifeFade;
          uniform float uLifeTime;

          uniform float uTiles;
          uniform float uFadeStart;
          uniform float uFadeEnd;
          uniform float uTime;
          uniform vec2 uWind;
          uniform float uSway;`,
        )
        .replace(
          '#include <uv_vertex>',
          `#include <uv_vertex>
          vMapUv = vec2((uv.x + aTile) / uTiles, uv.y);`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          {
            #ifdef USE_INSTANCING
              vec3 ip = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
              float d = length((modelViewMatrix * vec4(ip, 1.0)).xyz);
            #else
              float d = 0.0;
            #endif
            float fade = 1.0 - smoothstep(uFadeStart, uFadeEnd, d);
            transformed *= fade;
    #ifdef USE_INSTANCING
      float lifeIn = clamp((uLifeTime - aLife.x) / 0.7, 0.0, 1.0);
      float lifeOut = aLife.y > uLifeTime ? 1.0 : clamp(1.0 - (uLifeTime - aLife.y) / 0.7, 0.0, 1.0);
      vLifeFade = lifeIn * lifeOut;
    #else
      vLifeFade = 1.0;
    #endif

            float phase = aRand * 6.28 + ip.x * 0.05 + ip.z * 0.07;
            float g = sin(uTime * 1.3 + phase) * 0.7 + sin(uTime * 3.1 + phase * 1.7) * 0.3;
            transformed.xz += uWind * g * uSway * position.y * position.y;
          }`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>${DISSOLVE_FRAG}`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>${this.dissolve ? DISSOLVE_TEST : ''}`);
      // Billboards are lit as if facing up, on both sides (no back-face darkening).
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
        normal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
        nonPerturbedNormal = normal;`,
      );
    };
    this.customProgramCacheKey = () => `skybound-bb3-${tiles}-${sway}-${this.dissolve ? 'd' : 's'}`;
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const _c = new THREE.Color();

/** Two-tone paint by normal.y (lit top, shaded underside) with per-vertex variation. */
function paintCrown(g: THREE.BufferGeometry, top: string, under: string, rng: Rng, vary = 0.08): THREE.BufferGeometry {
  const ct = new THREE.Color(top), cu = new THREE.Color(under);
  if (!g.attributes.normal) g.computeVertexNormals();
  const pos = g.attributes.position;
  const nrm = g.attributes.normal;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = THREE.MathUtils.clamp(nrm.getY(i) * 0.6 + 0.5, 0, 1);
    _c.copy(cu).lerp(ct, t);
    const v = 1 + (rng.next() - 0.5) * vary;
    colors[i * 3] = _c.r * v;
    colors[i * 3 + 1] = _c.g * v;
    colors[i * 3 + 2] = _c.b * v;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

function paintFlat(g: THREE.BufferGeometry, color: string, rng: Rng, vary = 0.05): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = 1 + (rng.next() - 0.5) * vary;
    colors[i * 3] = c.r * v; colors[i * 3 + 1] = c.g * v; colors[i * 3 + 2] = c.b * v;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/** Tag geometry with the sway/crown attribute. */
function tag(g: THREE.BufferGeometry, crown: number, height: number, baseY = 0): THREE.BufferGeometry {
  const pos = g.attributes.position;
  const veg = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const s = THREE.MathUtils.clamp((y - baseY - 1.2) / Math.max(1, height - 1.2), 0, 1);
    veg[i * 2] = s;
    veg[i * 2 + 1] = crown;
  }
  g.setAttribute('aVeg', new THREE.BufferAttribute(veg, 2));
  return g;
}

function place(g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, s: THREE.Vector3 | number = 1): THREE.BufferGeometry {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz));
  const sc = typeof s === 'number' ? new THREE.Vector3(s, s, s) : s;
  m.compose(new THREE.Vector3(x, y, z), q, sc);
  g.applyMatrix4(m);
  return g;
}

/** Leaf cluster: icosphere with deterministic vertex displacement, squashed. */
function leafCluster(radius: number, top: string, under: string, rng: Rng, squash = 0.8, rough = 0.16): THREE.BufferGeometry {
  // Merge the icosphere's duplicated vertices (by position only, so seams and
  // per-face normals do not block merging) so displaced normals stay smooth;
  // displacement is smooth noise (lumps), not per-vertex white noise.
  const raw = new THREE.IcosahedronGeometry(radius, 1);
  raw.deleteAttribute('uv');
  raw.deleteAttribute('normal');
  const g = mergeVertices(raw);
  const pos = g.attributes.position;
  const noise = new Simplex2(rng.int(1e9));
  const ox = rng.next() * 10, oz = rng.next() * 10;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const n = noise.noise(x * 0.9 + ox + y * 0.35, z * 0.9 + oz - y * 0.25) + 0.45 * noise.noise(x * 2.2 - oz, z * 2.2 + y * 1.1 + ox);
    const k = 1 + n * rough;
    pos.setXYZ(i, x * k, y * k * squash, z * k);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return paintCrown(g, top, under, rng);
}

/** Irregular conifer tier: cone with jittered rim and a slight droop. */
function tier(radius: number, height: number, color: string, rng: Rng): THREE.BufferGeometry {
  const raw = new THREE.ConeGeometry(radius, height, 9, 2, true);
  raw.deleteAttribute('uv');
  raw.deleteAttribute('normal');
  const g = mergeVertices(raw);
  const pos = g.attributes.position;
  const seed = rng.int(1e9);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const r = Math.hypot(x, z);
    if (r > 0.01) {
      const n = hash2(Math.round(x * 10), Math.round(z * 10), seed) / 4294967296 - 0.5;
      const k = 1 + n * 0.28;
      pos.setXYZ(i, x * k, y - r * 0.18 * (1 + n), z * k);
    }
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return paintCrown(g, color, '#1f3f27', rng, 0.12);
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const list = parts.map((p) => {
    const q = p.index ? p.toNonIndexed() : p;
    q.deleteAttribute('uv');
    return q;
  });
  const merged = mergeGeometries(list, false)!;
  merged.computeBoundingSphere();
  for (const p of parts) p.dispose();
  return merged;
}

const BARK = '#5e4330';
const BARK_LIGHT = '#7d6247';

function trunk(height: number, rBase: number, rTop: number, lean: number, color: string, rng: Rng, segments = 5): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  let x = 0, y = 0;
  const seg = height / segments;
  let angle = 0;
  const leanDir = rng.next() * Math.PI * 2;
  for (let i = 0; i < segments; i++) {
    const t0 = i / segments, t1 = (i + 1) / segments;
    const r0 = THREE.MathUtils.lerp(rBase, rTop, t0), r1 = THREE.MathUtils.lerp(rBase, rTop, t1);
    const g = paintFlat(new THREE.CylinderGeometry(r1, r0, seg * 1.04, 7), color, rng, 0.1);
    tag(g, 0, height);
    place(g, x, y + seg / 2, 0, Math.sin(leanDir) * angle, 0, -Math.cos(leanDir) * angle);
    parts.push(g);
    angle += lean;
    x += Math.cos(leanDir) * Math.sin(angle) * seg;
    y += Math.cos(angle) * seg;
  }
  return parts;
}

/** Main branch: cylinder from (x,y,z) leaning `tilt` from vertical toward azimuth `yaw`. */
function branch(x: number, y: number, z: number, len: number, r: number, yaw: number, tilt: number, color: string, rng: Rng, height: number): THREE.BufferGeometry {
  const g = paintFlat(new THREE.CylinderGeometry(r * 0.45, r, len, 6), color, rng, 0.1);
  g.translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, -tilt, 'YXZ'));
  g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 1, 1)));
  tag(g, 0, height);
  return g;
}

// ---------------------------------------------------------------------------
// Species builders (variant seeds give deterministic shape variants)
// ---------------------------------------------------------------------------

function oak(seed: number): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const height = 10.5 + rng.next() * 2.5;
  const parts = trunk(4.8 + rng.next(), 0.5, 0.3, 0.02 + rng.next() * 0.03, BARK, rng);
  const top = 4.5 + rng.next() * 0.8;
  const nBranches = 3 + rng.int(2);
  for (let i = 0; i < nBranches; i++) {
    const yaw = (i / nBranches) * Math.PI * 2 + rng.next() * 0.8;
    const tilt = 0.55 + rng.next() * 0.45;
    parts.push(branch(0, top - 1.2 + rng.next(), 0, 2.4 + rng.next() * 1.4, 0.2, yaw, tilt, BARK, rng, height));
  }
  const tops = ['#3f7a2c', '#4a8a36', '#376f27', '#5b9a3d', '#457f31'];
  const unders = ['#2a5220', '#2f5a24'];
  const nClusters = 5 + rng.int(2);
  const cy = top + 1.6;
  for (let i = 0; i < nClusters; i++) {
    const a = (i / nClusters) * Math.PI * 2 + rng.next() * 0.9;
    const rad = 1.0 + rng.next() * 1.9;
    const r = 1.7 + rng.next() * 1.1;
    const g = leafCluster(r, tops[rng.int(tops.length)], unders[rng.int(unders.length)], rng, 0.7 + rng.next() * 0.25);
    tag(g, 1, height);
    place(g, Math.cos(a) * rad, cy + (rng.next() - 0.3) * 1.6 + r * 0.3, Math.sin(a) * rad, 0, rng.next() * 3, 0);
    parts.push(g);
  }
  const crownTop = leafCluster(2.2 + rng.next() * 0.6, tops[1], unders[0], rng, 0.75);
  tag(crownTop, 1, height);
  place(crownTop, (rng.next() - 0.5) * 1.2, cy + 2.6, (rng.next() - 0.5) * 1.2);
  parts.push(crownTop);
  return merge(parts);
}

function pine(seed: number): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const height = 13 + rng.next() * 4;
  const parts = trunk(height * 0.5, 0.36, 0.14, 0.01, BARK, rng, 4);
  const tiers = 5 + rng.int(2);
  const colors = ['#2f6a3a', '#356f3e', '#3b7a44', '#2b6136'];
  let y = 3.2 + rng.next() * 0.8;
  let r = 2.6 + rng.next() * 0.9;
  const step = (height - y) / tiers;
  for (let i = 0; i < tiers; i++) {
    const h = step * 1.5 + rng.next() * 0.6;
    const g = tier(r * (0.9 + rng.next() * 0.2), h, colors[rng.int(colors.length)], rng);
    tag(g, 1, height);
    place(g, (rng.next() - 0.5) * 0.35, y + h * 0.35, (rng.next() - 0.5) * 0.35, (rng.next() - 0.5) * 0.12, rng.next() * 6, (rng.next() - 0.5) * 0.12);
    parts.push(g);
    y += step;
    r *= 0.78 + rng.next() * 0.06;
  }
  const tipRaw = new THREE.ConeGeometry(0.5, 2.2, 6, 1, true);
  tipRaw.deleteAttribute('uv');
  tipRaw.deleteAttribute('normal');
  const tip = paintCrown(mergeVertices(tipRaw), '#3f8248', '#1f3f27', rng);
  tag(tip, 1, height);
  place(tip, 0, y + 0.6, 0);
  parts.push(tip);
  return merge(parts);
}

function birch(seed: number): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const height = 11 + rng.next() * 2;
  const parts = trunk(7.5, 0.24, 0.12, 0.02 + rng.next() * 0.02, '#e2ddd0', rng, 6);
  // Dark bark marks as thin bands.
  for (let i = 0; i < 4; i++) {
    const band = paintFlat(new THREE.CylinderGeometry(0.2, 0.21, 0.18, 6), '#4a4640', rng);
    tag(band, 0, height);
    place(band, 0, 1.2 + i * 1.5 + rng.next(), 0);
    parts.push(band);
  }
  for (let i = 0; i < 3; i++) {
    const yaw = (i / 3) * Math.PI * 2 + rng.next();
    parts.push(branch(0, 5.5 + rng.next() * 1.5, 0, 1.8 + rng.next(), 0.1, yaw, 0.5 + rng.next() * 0.4, '#d8d2c4', rng, height));
  }
  const tops = ['#8fbf4a', '#a3cc55', '#7fb043'];
  const n = 5 + rng.int(3);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.next();
    const rad = 0.6 + rng.next() * 1.2;
    const r = 1.1 + rng.next() * 0.8;
    const g = leafCluster(r, tops[rng.int(tops.length)], '#5d8a35', rng, 1.1 + rng.next() * 0.4, 0.2);
    tag(g, 1, height);
    place(g, Math.cos(a) * rad, 7.2 + rng.next() * 2.4, Math.sin(a) * rad);
    parts.push(g);
  }
  return merge(parts);
}

function palm(seed: number): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const height = 10;
  const parts: THREE.BufferGeometry[] = [];
  let x = 0, y = 0, lean = 0;
  const dir = rng.next() * Math.PI * 2;
  for (let i = 0; i < 7; i++) {
    const seg = paintFlat(new THREE.CylinderGeometry(0.2 - i * 0.012, 0.26 - i * 0.012, 1.3, 6), BARK_LIGHT, rng, 0.12);
    tag(seg, 0, height);
    place(seg, x, y + 0.65, 0, 0, 0, -lean);
    parts.push(seg);
    lean += 0.05 + rng.next() * 0.02;
    x += Math.sin(lean) * 1.2;
    y += Math.cos(lean) * 1.2;
  }
  const n = 8 + rng.int(3);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.next() * 0.4;
    const droop = 0.9 + rng.next() * 0.7;
    const frond = paintCrown(new THREE.ConeGeometry(0.5, 3.8 + rng.next(), 4), i % 2 ? '#3f8a3c' : '#4e9a44', '#2b5d2a', rng);
    tag(frond, 1, height);
    place(frond, x + Math.cos(a) * 1.5, y + 0.6, Math.sin(a) * 1.5, Math.cos(a) * droop, 0, -Math.sin(a) * droop, new THREE.Vector3(1, 1, 0.3));
    parts.push(frond);
  }
  const top = paintFlat(new THREE.IcosahedronGeometry(0.55, 0), '#6a4a2a', rng);
  tag(top, 0, height);
  place(top, x, y + 0.4, 0);
  parts.push(top);
  void dir;
  return merge(parts);
}

function cactus(seed: number): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const h = 3.4 + rng.next();
  const body = paintCrown(new THREE.CylinderGeometry(0.42, 0.5, h, 9), '#5a9558', '#3f7a45', rng);
  tag(body, 0, h);
  place(body, 0, h / 2, 0);
  const cap = paintCrown(new THREE.SphereGeometry(0.42, 9, 6, 0, Math.PI * 2, 0, Math.PI / 2), '#5a9558', '#3f7a45', rng);
  tag(cap, 0, h);
  place(cap, 0, h, 0);
  const parts = [body, cap];
  const arms = 1 + rng.int(3);
  for (let i = 0; i < arms; i++) {
    const a = rng.next() * Math.PI * 2;
    const ay = 1.4 + rng.next() * 1.2;
    const elbow = paintCrown(new THREE.CylinderGeometry(0.24, 0.24, 0.9, 7), '#4f8a52', '#3a6f3f', rng);
    tag(elbow, 0, h);
    place(elbow, Math.cos(a) * 0.6, ay, Math.sin(a) * 0.6, 0, -a, Math.PI / 2);
    const arm = paintCrown(new THREE.CylinderGeometry(0.22, 0.25, 1.2 + rng.next(), 7), '#4f8a52', '#3a6f3f', rng);
    tag(arm, 0, h);
    place(arm, Math.cos(a) * 0.95, ay + 0.7, Math.sin(a) * 0.95);
    parts.push(elbow, arm);
  }
  return merge(parts);
}

function deadwood(seed: number): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const height = 6;
  const parts = trunk(5.5, 0.4, 0.14, 0.03 + rng.next() * 0.03, '#6f665c', rng, 4);
  const n = 3 + rng.int(3);
  for (let i = 0; i < n; i++) {
    parts.push(branch(0, 2.5 + rng.next() * 3, 0, 1.4 + rng.next() * 1.6, 0.12, rng.next() * 6.28, 0.6 + rng.next() * 0.6, '#6f665c', rng, height));
  }
  return merge(parts);
}

function shrub(seed: number): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const parts: THREE.BufferGeometry[] = [];
  const n = 3 + rng.int(3);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.next();
    const r = 0.7 + rng.next() * 0.7;
    const g = leafCluster(r, ['#5d7d34', '#6d8a3a', '#557530'][rng.int(3)], '#3f5a26', rng, 0.6 + rng.next() * 0.2, 0.22);
    tag(g, 1, 2.2, -0.5);
    place(g, Math.cos(a) * rng.next() * 0.9, r * 0.55, Math.sin(a) * rng.next() * 0.9);
    parts.push(g);
  }
  return merge(parts);
}

function willow(seed: number): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const height = 9;
  const parts = trunk(3.6, 0.5, 0.3, 0.05, BARK, rng, 4);
  // Broad dome with a second, lower dome and a few wide drooping clusters.
  const crown = leafCluster(3.2, '#5f8a3c', '#3f6a2c', rng, 0.72, 0.14);
  tag(crown, 1, height);
  place(crown, 0.2, 5.9, 0);
  parts.push(crown);
  const skirt = leafCluster(3.6, '#588238', '#3a612a', rng, 0.55, 0.16);
  tag(skirt, 1, height);
  place(skirt, -0.2, 4.6, 0.1);
  parts.push(skirt);
  const n = 4 + rng.int(2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.next() * 0.6;
    const rad = 2.4 + rng.next() * 0.9;
    const g = leafCluster(1.1 + rng.next() * 0.4, '#5a8438', '#3c6329', rng, 1.7 + rng.next() * 0.5, 0.16);
    tag(g, 1, height);
    place(g, Math.cos(a) * rad, 3.3 + rng.next() * 0.6, Math.sin(a) * rad);
    parts.push(g);
  }
  return merge(parts);
}

/** Boulder: a couple of displaced icospheres, flattened, grey with a lichen tint and a lighter sun-side top. */
function boulder(seed: number): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const parts: THREE.BufferGeometry[] = [];
  const n = 1 + rng.int(3);
  const greys = ['#8a8680', '#7d7a74', '#948f86', '#86827a'];
  for (let i = 0; i < n; i++) {
    const r = (i === 0 ? 1.6 : 0.9) + rng.next() * 1.1;
    const g = new THREE.IcosahedronGeometry(r, 1);
    const pos = g.attributes.position;
    for (let k = 0; k < pos.count; k++) {
      const x = pos.getX(k), y = pos.getY(k), z = pos.getZ(k);
      const bump = 1 + (rng.next() - 0.5) * 0.28;
      pos.setXYZ(k, x * bump * 1.15, Math.max(y * bump * 0.72, -r * 0.35), z * bump);
    }
    pos.needsUpdate = true;
    g.deleteAttribute('uv'); g.deleteAttribute('normal');
    const merged = mergeVertices(g); merged.computeVertexNormals();
    const base = greys[rng.int(greys.length)];
    paintCrown(merged, base, '#5f5d58', rng, 0.05);
    // Lichen and a lighter top.
    const col = merged.attributes.color, nrm = merged.attributes.normal, c = new THREE.Color(), lichen = new THREE.Color('#9aa46a');
    for (let k = 0; k < col.count; k++) {
      c.setRGB(col.getX(k), col.getY(k), col.getZ(k));
      const up = Math.max(0, nrm.getY(k));
      c.lerp(new THREE.Color('#b0aca4'), up * 0.25);
      if (rng.next() < 0.18) c.lerp(lichen, 0.35);
      col.setXYZ(k, c.r, c.g, c.b);
    }
    tag(merged, 0, 0.1);
    const a = rng.next() * Math.PI * 2, d = i === 0 ? 0 : 1.2 + rng.next() * 1.2;
    place(merged, Math.cos(a) * d, r * 0.55 - 0.2, Math.sin(a) * d, 0, rng.next() * Math.PI * 2, 0);
    parts.push(merged);
  }
  return merge(parts);
}

const BUILDERS: ((seed: number) => THREE.BufferGeometry)[] = [oak, pine, birch, palm, cactus, deadwood, shrub, willow, boulder];

/** Build one species geometry (pure; no DOM). Exported for tests and tools. */
// ---------------------------------------------------------------------------
// Impostor atlas & ground cover textures (procedural canvas)
// ---------------------------------------------------------------------------

export const IMPOSTOR_TILES = 9;
const TILE_W = 128, TILE_H = 192;

/** Visual size (m) of a unit-scale impostor per species: [width, height]. */
export const IMPOSTOR_SIZE: [number, number][] = [
  [9, 12], [6.5, 15], [5.5, 11], [7, 10], [2.2, 4.5], [4, 6], [3, 2.2], [7.5, 8], [5.5, 3.6],
];

function paintImpostorAtlas(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = TILE_W * IMPOSTOR_TILES;
  canvas.height = TILE_H;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const rng = new Rng(0x5eed);
  const blob = (cx: number, cy: number, r: number, color: string, n = 9) => {
    ctx.fillStyle = color;
    for (let i = 0; i < n; i++) {
      const a = rng.next() * Math.PI * 2, d = rng.next() * r * 0.55;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, r * (0.45 + rng.next() * 0.35), 0, Math.PI * 2);
      ctx.fill();
    }
  };
  const trunkRect = (x0: number, w: number, y0: number, y1: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(x0 - w / 2, y0, w, y1 - y0);
  };
  for (let s = 0; s < IMPOSTOR_TILES; s++) {
    ctx.save();
    ctx.translate(s * TILE_W, 0);
    const cx = TILE_W / 2;
    switch (s as Species) {
      case Species.Oak:
        trunkRect(cx, 12, 110, 192, '#5a4030');
        blob(cx, 78, 44, '#356b27'); blob(cx - 18, 92, 30, '#3f7a2c'); blob(cx + 20, 88, 30, '#4a8a36'); blob(cx, 60, 30, '#5b9a3d', 6);
        break;
      case Species.Pine:
        trunkRect(cx, 8, 150, 192, '#5a4030');
        ctx.fillStyle = '#2f6a3a';
        for (let t = 0; t < 5; t++) {
          const y = 40 + t * 28, w = 22 + t * 14;
          ctx.beginPath(); ctx.moveTo(cx, y - 26); ctx.lineTo(cx + w, y + 14); ctx.lineTo(cx - w, y + 14); ctx.closePath(); ctx.fill();
          ctx.fillStyle = t % 2 ? '#356f3e' : '#2b6136';
        }
        break;
      case Species.Birch:
        trunkRect(cx, 7, 100, 192, '#ddd8cb');
        blob(cx, 70, 30, '#8fbf4a'); blob(cx - 14, 92, 22, '#a3cc55'); blob(cx + 16, 84, 22, '#7fb043');
        break;
      case Species.Palm:
        trunkRect(cx, 8, 70, 192, '#7d6247');
        ctx.strokeStyle = '#3f8a3c'; ctx.lineWidth = 9; ctx.lineCap = 'round';
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          ctx.beginPath(); ctx.moveTo(cx, 66); ctx.quadraticCurveTo(cx + Math.cos(a) * 40, 66 + Math.sin(a) * 16 - 20, cx + Math.cos(a) * 52, 66 + Math.abs(Math.sin(a)) * 28 + 10); ctx.stroke();
        }
        break;
      case Species.Cactus:
        trunkRect(cx, 24, 60, 192, '#4f8a52');
        trunkRect(cx - 24, 14, 100, 130, '#4f8a52'); trunkRect(cx - 24, 14, 80, 100, '#4f8a52');
        trunkRect(cx + 22, 14, 115, 140, '#4f8a52'); trunkRect(cx + 22, 14, 95, 115, '#4f8a52');
        break;
      case Species.Deadwood:
        trunkRect(cx, 10, 60, 192, '#6f665c');
        ctx.strokeStyle = '#6f665c'; ctx.lineWidth = 6; ctx.lineCap = 'round';
        for (const [dx, dy] of [[-38, -40], [34, -50], [22, -20], [-26, -12]]) { ctx.beginPath(); ctx.moveTo(cx, 110); ctx.lineTo(cx + dx, 110 + dy); ctx.stroke(); }
        break;
      case Species.Shrub:
        blob(cx, 150, 34, '#5d7d34', 10); blob(cx - 20, 160, 22, '#6d8a3a'); blob(cx + 20, 158, 22, '#557530');
        break;
      case Species.Rock:
        blob(cx, 150, 40, '#87837c', 7); blob(cx - 26, 166, 20, '#7a766f', 5); blob(cx + 30, 170, 16, '#94908a', 5); blob(cx - 4, 132, 22, '#a3a09a', 4);
        break;
      case Species.Willow:
        trunkRect(cx, 12, 120, 192, '#5a4030');
        blob(cx, 88, 40, '#86ad52'); ctx.strokeStyle = '#7fa64d'; ctx.lineWidth = 5;
        for (let i = 0; i < 10; i++) { const x = cx - 44 + i * 10; ctx.beginPath(); ctx.moveTo(x, 90); ctx.lineTo(x + (rng.next() - 0.5) * 8, 150 + rng.next() * 20); ctx.stroke(); }
        break;
    }
    ctx.restore();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 4;
  return tex;
}

export const COVER_TILES = 7;

function paintGrassAtlas(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  const tiles = COVER_TILES;
  canvas.width = 64 * tiles;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const rng = new Rng(0x9a55);
  const palettes = [['#6f9a3a', '#88b048'], ['#7ea24a', '#a7c25a'], ['#8f9a4a', '#b3ad5c'], ['#5f8a3a', '#7aa346'], ['#5f8f3a', '#7aa346'], ['#6a9440', '#86ad4c'], ['#5c8a3c', '#78a548']];
  // Flower tiles: stalks first, then blossoms on top.
  const flowers: (null | { petals: string; center: string; count: number; spike?: boolean })[] = [null, null, null, null,
    { petals: '#e6452f', center: '#2a1a12', count: 9 }, { petals: '#f7f3e6', center: '#f2c230', count: 10 }, { petals: '#7d5fc4', center: '#5b3fa8', count: 8, spike: true }];
  for (let t = 0; t < tiles; t++) {
    ctx.save();
    ctx.translate(t * 64, 0);
    ctx.lineCap = 'round';
    for (let i = 0; i < (flowers[t] ? 9 : 14); i++) {
      ctx.strokeStyle = palettes[t][i % 2];
      ctx.lineWidth = 2 + rng.next() * 2;
      const x0 = 12 + rng.next() * 40;
      const h = 22 + rng.next() * 36;
      ctx.beginPath();
      ctx.moveTo(x0, 64);
      ctx.quadraticCurveTo(x0 + (rng.next() - 0.5) * 16, 64 - h * 0.6, x0 + (rng.next() - 0.5) * 30, 64 - h);
      ctx.stroke();
    }
    const flower = flowers[t];
    if (flower) {
      for (let i = 0; i < flower.count; i++) {
        const x = 8 + rng.next() * 48, y = flower.spike ? 6 + rng.next() * 26 : 10 + rng.next() * 30, r = flower.spike ? 3 : 4.6 + rng.next() * 2.2;
        if (flower.spike) { // lupine: a column of small blossoms
          ctx.fillStyle = flower.petals;
          for (let k = 0; k < 5; k++) { ctx.beginPath(); ctx.arc(x + (k % 2 ? 2 : -2), y + k * 4.5, r, 0, Math.PI * 2); ctx.fill(); }
        } else {
          ctx.fillStyle = flower.petals;
          for (let k = 0; k < 5; k++) { const a = (k / 5) * Math.PI * 2; ctx.beginPath(); ctx.arc(x + Math.cos(a) * r * 0.9, y + Math.sin(a) * r * 0.9, r * 0.7, 0, Math.PI * 2); ctx.fill(); }
          ctx.fillStyle = flower.center; ctx.beginPath(); ctx.arc(x, y, r * 0.45, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
    ctx.restore();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

/** Two crossed quads, base at y=0, unit size, normals up (flat lighting). */
/**
 * Shadow caster stand-in per species: a trunk and a crown blob of 30-40
 * triangles in the same local metres as the tree geometry. Full trees do not
 * cast shadows themselves (a 700-triangle crown per tree made the caster pass
 * a fifth of the frame on integrated GPUs); these draw into the shadow map
 * instead, and write nothing in the colour pass.
 */
function shadowProxy(species: Species): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // Merge needs every part indexed the same way; the icosahedron is non-indexed, so drop the others' indices too.
  const add = (g: THREE.BufferGeometry) => { const flat = g.index ? g.toNonIndexed() : g; if (flat !== g) g.dispose(); parts.push(flat); };
  const trunk = (r: number, h: number) => { const g = new THREE.CylinderGeometry(r * 0.8, r, h, 5, 1); g.translate(0, h / 2, 0); add(g); };
  const blob = (r: number, y: number, sx = 1, sy = 1, sz = 1) => { const g = new THREE.IcosahedronGeometry(r, 0); g.scale(sx, sy, sz); g.translate(0, y, 0); add(g); };
  const cone = (r: number, h: number, y: number) => { const g = new THREE.ConeGeometry(r, h, 6, 1); g.translate(0, y + h / 2, 0); add(g); };
  switch (species) {
    case Species.Oak: trunk(0.35, 4.5); blob(4.2, 7.6, 1, 0.9, 1); break;
    case Species.Pine: trunk(0.3, 3); cone(3.2, 12, 3); break;
    case Species.Birch: trunk(0.25, 4); blob(2.6, 7.4, 1, 1.25, 1); break;
    case Species.Palm: trunk(0.3, 8); blob(3.3, 8.6, 1, 0.5, 1); break;
    case Species.Cactus: trunk(0.5, 4.5); break;
    case Species.Deadwood: trunk(0.3, 5); blob(1.6, 4.6); break;
    case Species.Shrub: blob(1.4, 1.1, 1, 0.8, 1); break;
    case Species.Willow: trunk(0.4, 3); blob(3.6, 5, 1, 0.85, 1); break;
    default: blob(1.9, 1.4, 1.4, 0.9, 1.2); break;
  }
  for (const p of parts) p.deleteAttribute('uv');
  const merged = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  return merged;
}

function crossQuads(): THREE.BufferGeometry {
  const a = new THREE.PlaneGeometry(1, 1, 1, 1).translate(0, 0.5, 0);
  const b = a.clone().rotateY(Math.PI / 2);
  const g = mergeGeometries([a, b], false)!;
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
  a.dispose();
  b.dispose();
  return g;
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

export class VegetationLibrary {
  readonly material: VegetationMaterial;
  readonly impostorMaterial: BillboardMaterial;
  readonly impostorGeometry: THREE.BufferGeometry;
  readonly coverMaterial: BillboardMaterial;
  readonly coverGeometry: THREE.BufferGeometry;
  /** Dissolving twins: used while instances are appearing or vanishing, then swapped for the settled material. */
  readonly materialFading: VegetationMaterial;
  readonly impostorMaterialFading: BillboardMaterial;
  readonly coverMaterialFading: BillboardMaterial;
  /** Colour-pass material of the shadow proxies: writes nothing; the shadow pass uses its own depth material. */
  readonly shadowMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  private proxies: THREE.BufferGeometry[] = [];
  private twins = new Map<THREE.Material, { fading: THREE.Material; settled: THREE.Material }>();
  private geometries: THREE.BufferGeometry[][] = [];
  private impostorTexture: THREE.Texture;
  private grassTexture: THREE.Texture;

  constructor() {
    this.material = new VegetationMaterial();
    const builders = BUILDERS;
    // Geometry variants per species (shader adds per-instance variation on top).
    const variantCounts = [2, 2, 1, 1, 1, 1, 1, 1, 2];
    for (let s = 0; s < SPECIES_COUNT; s++) {
      this.geometries[s] = [];
      for (let v = 0; v < variantCounts[s]; v++) this.geometries[s].push(builders[s](hash2(s, v, 0x7e9)));
    }
    this.impostorTexture = paintImpostorAtlas();
    this.impostorMaterial = new BillboardMaterial(this.impostorTexture, IMPOSTOR_TILES, 100000, 100001, 0);
    this.impostorGeometry = crossQuads();
    this.grassTexture = paintGrassAtlas();
    this.coverMaterial = new BillboardMaterial(this.grassTexture, COVER_TILES, 110, 170, 0.12);
    this.coverGeometry = crossQuads();
    this.materialFading = new VegetationMaterial(true, this.material.vegUniforms);
    this.impostorMaterialFading = new BillboardMaterial(this.impostorTexture, IMPOSTOR_TILES, 100000, 100001, 0, true, this.impostorMaterial.bbUniforms);
    this.coverMaterialFading = new BillboardMaterial(this.grassTexture, COVER_TILES, 110, 170, 0.12, true, this.coverMaterial.bbUniforms);
    for (const [settled, fading] of [[this.material, this.materialFading], [this.impostorMaterial, this.impostorMaterialFading], [this.coverMaterial, this.coverMaterialFading]] as const) {
      this.twins.set(settled, { fading, settled });
      this.twins.set(fading, { fading, settled });
    }
  }

  fadingTwin(m: THREE.Material): THREE.Material { return this.twins.get(m)?.fading ?? m; }
  settledTwin(m: THREE.Material): THREE.Material { return this.twins.get(m)?.settled ?? m; }

  /** Low-poly shadow caster geometry for a species (built on first use). */
  shadowProxy(species: Species): THREE.BufferGeometry {
    return (this.proxies[species] ??= shadowProxy(species));
  }

  variants(species: Species): number {
    return this.geometries[species].length;
  }

  geometry(species: Species, variant: number): THREE.BufferGeometry {
    const list = this.geometries[species];
    return list[variant % list.length];
  }

  /** Advance wind animation (simulation clock) and the dissolve clock (wall clock, so fades finish while paused). */
  update(time: number, windX: number, windZ: number, lifeTime: number): void {
    this.material.vegUniforms.uTime.value = time;
    this.material.vegUniforms.uLifeTime.value = lifeTime;
    this.material.vegUniforms.uWind.value.set(windX, windZ);
    this.coverMaterial.bbUniforms.uTime.value = time;
    this.coverMaterial.bbUniforms.uLifeTime.value = lifeTime;
    this.coverMaterial.bbUniforms.uWind.value.set(windX, windZ);
    this.impostorMaterial.bbUniforms.uLifeTime.value = lifeTime;
  }

  dispose(): void {
    for (const list of this.geometries) for (const g of list) g.dispose();
    for (const p of this.proxies) p?.dispose();
    this.shadowMaterial.dispose();
    this.material.dispose();
    this.materialFading.dispose();
    this.impostorMaterial.dispose();
    this.impostorMaterialFading.dispose();
    this.impostorGeometry.dispose();
    this.coverMaterial.dispose();
    this.coverMaterialFading.dispose();
    this.coverGeometry.dispose();
    this.impostorTexture.dispose();
    this.grassTexture.dispose();
  }
}
