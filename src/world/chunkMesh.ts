/**
 * Deterministic chunk mesh construction. Pure functions over WorldGen so the
 * same output is produced in workers and in tests regardless of order.
 */
import { CHUNK_SIZE, LOD_SPACING, SEA_LEVEL, VEGETATION_MAX_LOD, FAR_TILE_SIZE, FAR_TILE_SEGMENTS, FAR_TILE_Y_OFFSET } from '../core/config';
import { hash2, Rng } from './noise';
import { createTerrainSample, WorldGen, type TerrainSample, type VegetationChoice } from './WorldGen';

/**
 * Per-vertex shader auxiliaries: snow altitude factor (before slope), rockiness
 * bias (alpine/arid), wetness near the water line, aridness (for red strata).
 */
function auxAt(s: TerrainSample, out: Float32Array, o: number): void {
  const line = s.snowLine + 40 * s.detail;
  const t = (s.height - (line - 90)) / 180;
  const snowAlt = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
  const w = s.weights;
  out[o] = snowAlt;
  out[o + 1] = Math.min(1, w[1] * 0.9 + w[3] * 0.5);
  const hw = s.height;
  out[o + 2] = hw < 0.2 ? 0.45 : hw > 1.6 ? 0 : 0.45 * (1 - (hw - 0.2) / 1.4);
  out[o + 3] = w[3];
}

/** Convert an sRGB-ish palette color in place to linear for vertex colors. */
function toLinear(c: Float32Array, o: number): void {
  c[o] = Math.pow(c[o], 2.2);
  c[o + 1] = Math.pow(c[o + 1], 2.2);
  c[o + 2] = Math.pow(c[o + 2], 2.2);
}

/** Packed per-vertex sample cache layout (used inside buildChunkMesh). */
const SAMPLE_STRIDE = 7 + 7;
function packSample(s: TerrainSample, out: Float32Array, o: number): void {
  out[o] = s.height; out[o + 1] = s.hills; out[o + 2] = s.detail; out[o + 3] = s.ridge;
  out[o + 4] = s.band; out[o + 5] = s.snowLine; out[o + 6] = s.biome;
  for (let i = 0; i < 7; i++) out[o + 7 + i] = s.weights[i];
}
function unpackSample(src: Float32Array, o: number, s: TerrainSample): void {
  s.height = src[o]; s.hills = src[o + 1]; s.detail = src[o + 2]; s.ridge = src[o + 3];
  s.band = src[o + 4]; s.snowLine = src[o + 5]; s.biome = src[o + 6];
  for (let i = 0; i < 7; i++) s.weights[i] = src[o + 7 + i];
}

export interface ChunkMeshData {
  cx: number;
  cz: number;
  lod: number;
  /** Vertex positions local to the chunk origin (cx*S, 0, cz*S). */
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /** Per-vertex shader data: [snow altitude factor, rockiness, wetness, aridness]. */
  aux: Float32Array;
  indices: Uint32Array;
  /** (segments+1)^2 heights for collision, row-major with x fastest. */
  heights: Float32Array;
  segments: number;
  spacing: number;
  minHeight: number;
  maxHeight: number;
  hasWater: boolean;
  waterDepth: Float32Array;
  waterExposure: Float32Array;
  /** Tree instances: [gx, gy, gz, species, scale, rotation] * n. */
  trees: Float32Array;
  /** Ground cover instances (LOD0 only): [gx, gy, gz, scale, rotation, kind] * n. */
  cover: Float32Array;
}

export const WATER_SEGMENTS = 48;
export const TREE_STRIDE = 6;
const SKIRT_DEPTH_FACTOR = 3;

export function chunkKey(cx: number, cz: number): string {
  return `${cx},${cz}`;
}

export function worldToChunk(x: number, z: number): { cx: number; cz: number } {
  return { cx: Math.floor(x / CHUNK_SIZE), cz: Math.floor(z / CHUNK_SIZE) };
}

/** Build the terrain mesh for chunk (cx,cz) at a LOD level. */
export function buildChunkMesh(gen: WorldGen, cx: number, cz: number, lod: number, coverDensity = 0): ChunkMeshData {
  const spacing = LOD_SPACING[lod];
  const segs = CHUNK_SIZE / spacing;
  const n = segs + 1;
  const ox = cx * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;

  // Sample grid with a one-vertex ring for normals: (n+2)^2. The full sample
  // is cached per vertex so the color pass does not re-evaluate the noise.
  const gn = n + 2;
  const grid = new Float32Array(gn * gn);
  const cache = new Float32Array(gn * gn * SAMPLE_STRIDE);
  const sample = createTerrainSample();
  for (let j = 0; j < gn; j++) {
    const z = oz + (j - 1) * spacing;
    for (let i = 0; i < gn; i++) {
      const x = ox + (i - 1) * spacing;
      gen.sample(x, z, sample);
      const gi = j * gn + i;
      grid[gi] = sample.height;
      packSample(sample, cache, gi * SAMPLE_STRIDE);
    }
  }

  const vertCount = n * n + 4 * n; // grid + skirt
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const colors = new Float32Array(vertCount * 3);
  const aux = new Float32Array(vertCount * 4);
  const heights = new Float32Array(n * n);
  let minH = Infinity, maxH = -Infinity;

  for (let j = 0; j < n; j++) {
    const z = oz + j * spacing;
    for (let i = 0; i < n; i++) {
      const x = ox + i * spacing;
      const gi = (j + 1) * gn + (i + 1);
      const h = grid[gi];
      const vi = j * n + i;
      heights[vi] = h;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
      positions[vi * 3] = i * spacing;
      positions[vi * 3 + 1] = h;
      positions[vi * 3 + 2] = j * spacing;
      const dx = (grid[gi + 1] - grid[gi - 1]) / (2 * spacing);
      const dz = (grid[gi + gn] - grid[gi - gn]) / (2 * spacing);
      let nx = -dx, ny = 1, nz = -dz;
      const il = 1 / Math.hypot(nx, ny, nz);
      nx *= il; ny *= il; nz *= il;
      normals[vi * 3] = nx;
      normals[vi * 3 + 1] = ny;
      normals[vi * 3 + 2] = nz;
      unpackSample(cache, gi * SAMPLE_STRIDE, sample);
      const slope = Math.hypot(dx, dz);
      gen.colorAt(sample, slope, x, z, colors, vi * 3, false);
      toLinear(colors, vi * 3);
      auxAt(sample, aux, vi * 4);
    }
  }

  // Skirt vertices: copies of edge vertices dropped down, same normal/color.
  const skirtDepth = spacing * SKIRT_DEPTH_FACTOR + 8;
  let sv = n * n;
  const skirtIndex = new Int32Array(4 * n);
  const addSkirt = (src: number, k: number) => {
    positions[sv * 3] = positions[src * 3];
    positions[sv * 3 + 1] = positions[src * 3 + 1] - skirtDepth;
    positions[sv * 3 + 2] = positions[src * 3 + 2];
    normals[sv * 3] = normals[src * 3];
    normals[sv * 3 + 1] = normals[src * 3 + 1];
    normals[sv * 3 + 2] = normals[src * 3 + 2];
    colors[sv * 3] = colors[src * 3];
    colors[sv * 3 + 1] = colors[src * 3 + 1];
    colors[sv * 3 + 2] = colors[src * 3 + 2];
    aux[sv * 4] = aux[src * 4];
    aux[sv * 4 + 1] = aux[src * 4 + 1];
    aux[sv * 4 + 2] = aux[src * 4 + 2];
    aux[sv * 4 + 3] = aux[src * 4 + 3];
    skirtIndex[k] = sv;
    sv++;
  };
  for (let i = 0; i < n; i++) addSkirt(i, i); // north edge (j=0)
  for (let i = 0; i < n; i++) addSkirt((n - 1) * n + i, n + i); // south edge (j=n-1)
  for (let j = 0; j < n; j++) addSkirt(j * n, 2 * n + j); // west edge (i=0)
  for (let j = 0; j < n; j++) addSkirt(j * n + (n - 1), 3 * n + j); // east edge

  const quadCount = segs * segs + 4 * segs;
  const indices = new Uint32Array(quadCount * 6);
  let ii = 0;
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < segs; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      indices[ii++] = a; indices[ii++] = c; indices[ii++] = d;
      indices[ii++] = a; indices[ii++] = d; indices[ii++] = b;
    }
  }
  // Skirt quads. Winding chosen so they face outward.
  for (let i = 0; i < segs; i++) {
    // north edge: top verts i, i+1 ; skirt k=i
    let t0 = i, t1 = i + 1, s0 = skirtIndex[i], s1 = skirtIndex[i + 1];
    indices[ii++] = t0; indices[ii++] = t1; indices[ii++] = s1;
    indices[ii++] = t0; indices[ii++] = s1; indices[ii++] = s0;
    // south edge
    t0 = (n - 1) * n + i; t1 = t0 + 1; s0 = skirtIndex[n + i]; s1 = skirtIndex[n + i + 1];
    indices[ii++] = t0; indices[ii++] = s1; indices[ii++] = t1;
    indices[ii++] = t0; indices[ii++] = s0; indices[ii++] = s1;
    // west edge
    t0 = i * n; t1 = t0 + n; s0 = skirtIndex[2 * n + i]; s1 = skirtIndex[2 * n + i + 1];
    indices[ii++] = t0; indices[ii++] = s1; indices[ii++] = t1;
    indices[ii++] = t0; indices[ii++] = s0; indices[ii++] = s1;
    // east edge
    t0 = i * n + (n - 1); t1 = t0 + n; s0 = skirtIndex[3 * n + i]; s1 = skirtIndex[3 * n + i + 1];
    indices[ii++] = t0; indices[ii++] = t1; indices[ii++] = s1;
    indices[ii++] = t0; indices[ii++] = s1; indices[ii++] = s0;
  }

  // Trees are placed at a fixed density regardless of preset (identical
  // colliders everywhere); ground cover is a preset-scaled near-field extra.
  const trees = lod <= VEGETATION_MAX_LOD ? buildVegetation(gen, cx, cz) : new Float32Array(0);
  const cover = lod === 0 && coverDensity > 0 ? buildGroundCover(gen, cx, cz, coverDensity) : new Float32Array(0);

  const hasWater = minH < SEA_LEVEL + 1.5;
  const waterDepth = new Float32Array(hasWater ? (WATER_SEGMENTS + 1) ** 2 : 0);
  const waterExposure = new Float32Array(waterDepth.length);
  if (hasWater) {
    for (let j = 0; j <= WATER_SEGMENTS; j++) {
      for (let i = 0; i <= WATER_SEGMENTS; i++) {
        const x = i * CHUNK_SIZE / WATER_SEGMENTS, z = j * CHUNK_SIZE / WATER_SEGMENTS;
        const index = j * (WATER_SEGMENTS + 1) + i;
        waterDepth[index] = sampleHeightGrid(heights, segs, spacing, x, z);
        const land = gen.sample(ox + x, oz + z, sample).land;
        waterExposure[index] = Math.max(0, Math.min(1, (0.75 - land) * 2.5));
      }
    }
  }

  return {
    cx, cz, lod,
    positions, normals, colors, aux, indices,
    heights, segments: segs, spacing,
    minHeight: minH, maxHeight: maxH,
    hasWater, waterDepth, waterExposure,
    trees,
    cover,
  };
}

const VEG_CELL = 12.8; // m
const VEG_CELLS = Math.round(CHUNK_SIZE / VEG_CELL); // 40

/**
 * Deterministic vegetation placement for a chunk from its own random stream.
 * Density is fixed (not preset dependent) so obstacle placement is identical
 * on every graphics preset.
 */
export function buildVegetation(gen: WorldGen, cx: number, cz: number): Float32Array {
  const ox = cx * CHUNK_SIZE, oz = cz * CHUNK_SIZE;
  const sample = createTerrainSample();
  const choice: VegetationChoice = { density: 0, species: 0 };
  const out: number[] = [];
  const vegSeed = hash2(cx, cz, gen.seed ^ 0x5eed1234);
  const rng = new Rng(vegSeed);
  for (let j = 0; j < VEG_CELLS; j++) {
    for (let i = 0; i < VEG_CELLS; i++) {
      const jx = rng.next(), jz = rng.next(), u = rng.next(), roll = rng.next(), sc = rng.next(), rot = rng.next();
      const x = ox + (i + jx) * VEG_CELL;
      const z = oz + (j + jz) * VEG_CELL;
      gen.sample(x, z, sample);
      const h = sample.height;
      if (h < 1.5) continue;
      const d = 3;
      const hx = gen.heightAt(x + d, z) - gen.heightAt(x - d, z);
      const hz = gen.heightAt(x, z + d) - gen.heightAt(x, z - d);
      const slope = Math.hypot(hx, hz) / (2 * d);
      gen.vegetationAt(sample, slope, u, choice, x, z);
      const p = choice.density * 0.5;
      if (roll >= p) continue;
      out.push(x, h, z, choice.species, 0.8 + sc * 0.55, rot * Math.PI * 2);
    }
  }
  return Float32Array.from(out);
}

const COVER_CELL = 7.2; // m
const COVER_CELLS = Math.floor(CHUNK_SIZE / COVER_CELL);
export const COVER_STRIDE = 6;

/**
 * Near-field ground cover (grass tufts, dry tufts, reeds): purely visual,
 * never an obstacle. `density` is the preset multiplier.
 */
export function buildGroundCover(gen: WorldGen, cx: number, cz: number, density: number): Float32Array {
  const ox = cx * CHUNK_SIZE, oz = cz * CHUNK_SIZE;
  const sample = createTerrainSample();
  const out: number[] = [];
  const rng = new Rng(hash2(cx, cz, gen.seed ^ 0x6ee2a5));
  for (let j = 0; j < COVER_CELLS; j++) {
    for (let i = 0; i < COVER_CELLS; i++) {
      const jx = rng.next(), jz = rng.next(), roll = rng.next(), sc = rng.next(), rot = rng.next();
      const x = ox + (i + jx) * COVER_CELL;
      const z = oz + (j + jz) * COVER_CELL;
      gen.sample(x, z, sample);
      const h = sample.height;
      if (h < 0.6) continue;
      const w = sample.weights;
      let p = w[0] * 0.9 + w[5] * 0.9 + w[4] * 0.85 + w[2] * 0.3 + w[3] * 0.18 + w[1] * 0.35;
      if (h > sample.snowLine - 120) p *= 0.2;
      p *= density * 0.55;
      if (roll >= p) continue;
      let kind = 0;
      if (w[5] > 0.5) kind = 1;
      else if (w[3] > 0.4 || w[2] > 0.5) kind = 2;
      else if (w[4] > 0.5) kind = 3;
      else kind = rng.next() < 0.5 ? 0 : 1;
      out.push(x, h, z, 0.8 + sc * 0.9, rot * Math.PI * 2, kind);
    }
  }
  return Float32Array.from(out);
}

export interface FarTileData {
  tx: number;
  tz: number;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  aux: Float32Array;
  indices: Uint32Array;
}

/** Coarse far-shell tile: simplified distant terrain, no skirt, no vegetation. */
export function buildFarTile(gen: WorldGen, tx: number, tz: number): FarTileData {
  const segs = FAR_TILE_SEGMENTS;
  const spacing = FAR_TILE_SIZE / segs;
  const n = segs + 1;
  const ox = tx * FAR_TILE_SIZE, oz = tz * FAR_TILE_SIZE;
  const gn = n + 2;
  const grid = new Float32Array(gn * gn);
  const sample = createTerrainSample();
  for (let j = 0; j < gn; j++) {
    for (let i = 0; i < gn; i++) {
      grid[j * gn + i] = gen.sample(ox + (i - 1) * spacing, oz + (j - 1) * spacing, sample).height;
    }
  }
  const positions = new Float32Array(n * n * 3);
  const normals = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 3);
  const aux = new Float32Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const gi = (j + 1) * gn + (i + 1);
      const vi = j * n + i;
      const x = ox + i * spacing, z = oz + j * spacing;
      let h = grid[gi];
      // Keep water surfaces flat & under the near water plane.
      if (h < SEA_LEVEL) h = Math.min(h, SEA_LEVEL - 4);
      positions[vi * 3] = i * spacing;
      positions[vi * 3 + 1] = h + FAR_TILE_Y_OFFSET;
      positions[vi * 3 + 2] = j * spacing;
      const dx = (grid[gi + 1] - grid[gi - 1]) / (2 * spacing);
      const dz = (grid[gi + gn] - grid[gi - gn]) / (2 * spacing);
      let nx = -dx, ny = 1, nz = -dz;
      const il = 1 / Math.hypot(nx, ny, nz);
      normals[vi * 3] = nx * il; normals[vi * 3 + 1] = ny * il; normals[vi * 3 + 2] = nz * il;
      gen.sample(x, z, sample);
      if (sample.height < SEA_LEVEL) {
        // deep water color for the far shell so it reads as sea
        colors[vi * 3] = 0.16; colors[vi * 3 + 1] = 0.34; colors[vi * 3 + 2] = 0.46;
      } else {
        gen.colorAt(sample, Math.hypot(dx, dz), x, z, colors, vi * 3, false);
      }
      toLinear(colors, vi * 3);
      auxAt(sample, aux, vi * 4);
    }
  }
  const indices = new Uint32Array(segs * segs * 6);
  let ii = 0;
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < segs; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      indices[ii++] = a; indices[ii++] = c; indices[ii++] = d;
      indices[ii++] = a; indices[ii++] = d; indices[ii++] = b;
    }
  }
  return { tx, tz, positions, normals, colors, aux, indices };
}

/**
 * Interpolate the exact rendered triangle of a chunk height grid at a local
 * position. Mirrors the index winding in buildChunkMesh.
 */
export function sampleHeightGrid(heights: Float32Array, segments: number, spacing: number, lx: number, lz: number): number {
  const n = segments + 1;
  let fx = lx / spacing, fz = lz / spacing;
  if (fx < 0) fx = 0; else if (fx > segments - 1e-6) fx = segments - 1e-6;
  if (fz < 0) fz = 0; else if (fz > segments - 1e-6) fz = segments - 1e-6;
  const i = Math.floor(fx), j = Math.floor(fz);
  const tx = fx - i, tz = fz - j;
  const a = heights[j * n + i];
  const b = heights[j * n + i + 1];
  const c = heights[(j + 1) * n + i];
  const d = heights[(j + 1) * n + i + 1];
  if (tx > tz) return a + (b - a) * tx + (d - b) * tz;
  return a + (c - a) * tz + (d - c) * tx;
}
