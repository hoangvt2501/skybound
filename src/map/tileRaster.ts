/**
 * Map tile rasterization from WorldGen. Pure: returns RGBA pixels so it can
 * run in a worker and be unit-tested.
 *
 * Map styling is deliberately separate from the 3D surface styling: a
 * restrained cartographic palette keyed by biome and elevation, subtle
 * hillshade, coastline strokes, and contours only at closer zooms.
 */
import { SEA_LEVEL } from '../core/config';
import { createTerrainSample, WorldGen } from '../world/WorldGen';
import { Biome } from '../world/biomes';
import { clamp, lerp, smoothstep } from '../world/noise';

export const TILE_PX = 256;

/** Meters per pixel for each zoom level (index = zoom). */
export const TILE_MPP = [128, 64, 32, 16, 8, 4, 2] as const;
export const MAX_ZOOM = TILE_MPP.length - 1;

export function tileKey(zoom: number, tx: number, tz: number): string {
  return `${zoom}/${tx}/${tz}`;
}

/** World extent (meters) of one tile at a zoom. */
export function tileSizeMeters(zoom: number): number {
  return TILE_MPP[zoom] * TILE_PX;
}

// Cartographic palette (sRGB 0..1).
const P = {
  oceanDeep: [0.16, 0.33, 0.52],
  oceanShallow: [0.36, 0.58, 0.76],
  lake: [0.30, 0.52, 0.72],
  coastline: [0.20, 0.30, 0.40],
  sand: [0.86, 0.80, 0.62],
  lowland: [0.66, 0.76, 0.52],
  forest: [0.50, 0.65, 0.40],
  upland: [0.72, 0.76, 0.54],
  flower: [0.78, 0.66, 0.66],
  wetland: [0.60, 0.70, 0.52],
  wetMud: [0.58, 0.60, 0.44],
  arid: [0.84, 0.66, 0.46],
  aridDark: [0.74, 0.52, 0.36],
  alpineGrass: [0.62, 0.68, 0.50],
  rock: [0.62, 0.59, 0.55],
  snow: [0.95, 0.96, 0.98],
} as const;

/**
 * Base map color for a land sample (before shading). Uses biome weights and
 * elevation only, so region-scale tiles stay calm.
 */
export function mapLandColor(s: ReturnType<typeof createTerrainSample>, out: number[] | Float32Array): void {
  const w = s.weights;
  const h = s.height;
  let r = 0, g = 0, b = 0;
  const add = (c: readonly number[], k: number) => { r += c[0] * k; g += c[1] * k; b += c[2] * k; };
  // Temperate: lowland meadow blending to forest where the hills field is high.
  const forestK = smoothstep(-0.2, 0.5, s.hills);
  add([lerp(P.lowland[0], P.forest[0], forestK), lerp(P.lowland[1], P.forest[1], forestK), lerp(P.lowland[2], P.forest[2], forestK)], w[Biome.Temperate]);
  add([lerp(P.upland[0], P.flower[0], 0.35), lerp(P.upland[1], P.flower[1], 0.35), lerp(P.upland[2], P.flower[2], 0.35)], w[Biome.Upland]);
  const mud = 1 - smoothstep(0.5, 3, h);
  add([lerp(P.wetland[0], P.wetMud[0], mud), lerp(P.wetland[1], P.wetMud[1], mud), lerp(P.wetland[2], P.wetMud[2], mud)], w[Biome.Wetland]);
  const band = ((s.band % 2) + 2) % 2;
  add(band === 0 ? P.arid : P.aridDark, w[Biome.Arid]);
  add(P.sand, w[Biome.Coast]);
  const rocky = smoothstep(400, 900, h);
  add([lerp(P.alpineGrass[0], P.rock[0], rocky), lerp(P.alpineGrass[1], P.rock[1], rocky), lerp(P.alpineGrass[2], P.rock[2], rocky)], w[Biome.Alpine]);
  // Elevation: higher ground drifts toward rock, then snow.
  const hi = smoothstep(500, 1100, h) * (1 - w[Biome.Arid]);
  r = lerp(r, P.rock[0], hi * 0.6); g = lerp(g, P.rock[1], hi * 0.6); b = lerp(b, P.rock[2], hi * 0.6);
  const snow = smoothstep(s.snowLine - 60, s.snowLine + 80, h);
  r = lerp(r, P.snow[0], snow); g = lerp(g, P.snow[1], snow); b = lerp(b, P.snow[2], snow);
  out[0] = r; out[1] = g; out[2] = b;
}

/**
 * Rasterize a map tile. Tile (tx,tz) at zoom covers world
 * [tx*size, (tx+1)*size) x [tz*size, (tz+1)*size). Pixel rows increase with
 * +Z (south), so north is up when drawn directly.
 */
export function rasterizeTile(gen: WorldGen, zoom: number, tx: number, tz: number, px = TILE_PX): Uint8ClampedArray {
  const mpp = TILE_MPP[zoom];
  const size = mpp * px;
  const ox = tx * size, oz = tz * size;
  const n = px + 2;
  const heights = new Float32Array(n * n);
  const land = new Float32Array(n * n);
  const sample = createTerrainSample();
  const rgb = new Float32Array(3);
  const out = new Uint8ClampedArray(px * px * 4);
  // Height/land pass with a one-pixel ring for shading and coastlines.
  for (let j = 0; j < n; j++) {
    const z = oz + (j - 0.5) * mpp;
    for (let i = 0; i < n; i++) {
      const x = ox + (i - 0.5) * mpp;
      gen.sample(x, z, sample);
      heights[j * n + i] = sample.height;
      land[j * n + i] = sample.land;
    }
  }
  const lx = -0.55, lz = -0.6, ly = 0.58; // light from north-west, above
  const contourStep = zoom >= 4 ? 50 : zoom >= 2 ? 100 : 0;
  for (let j = 0; j < px; j++) {
    const z = oz + (j + 0.5) * mpp;
    for (let i = 0; i < px; i++) {
      const x = ox + (i + 0.5) * mpp;
      const gi = (j + 1) * n + (i + 1);
      const h = heights[gi];
      let r: number, g: number, b: number;
      if (h < SEA_LEVEL) {
        const inland = land[gi] > 0.55;
        const d = smoothstep(0, 30, -h);
        if (inland) {
          r = lerp(P.lake[0] + 0.1, P.lake[0], d); g = lerp(P.lake[1] + 0.08, P.lake[1], d); b = lerp(P.lake[2] + 0.06, P.lake[2], d);
        } else {
          r = lerp(P.oceanShallow[0], P.oceanDeep[0], d); g = lerp(P.oceanShallow[1], P.oceanDeep[1], d); b = lerp(P.oceanShallow[2], P.oceanDeep[2], d);
        }
        // Coastline stroke on the water side of the boundary.
        const nb = heights[gi - 1] >= SEA_LEVEL || heights[gi + 1] >= SEA_LEVEL || heights[gi - n] >= SEA_LEVEL || heights[gi + n] >= SEA_LEVEL;
        if (nb) { r = lerp(r, P.coastline[0], 0.55); g = lerp(g, P.coastline[1], 0.55); b = lerp(b, P.coastline[2], 0.55); }
      } else {
        gen.sample(x, z, sample);
        mapLandColor(sample, rgb);
        const dx = (heights[gi + 1] - heights[gi - 1]) / (2 * mpp);
        const dz = (heights[gi + n] - heights[gi - n]) / (2 * mpp);
        let nx = -dx, ny = 1, nz = -dz;
        const il = 1 / Math.hypot(nx, ny, nz);
        nx *= il; ny *= il; nz *= il;
        const shade = clamp(0.72 + 0.42 * (nx * lx + ny * ly + nz * lz), 0.55, 1.12);
        r = rgb[0] * shade; g = rgb[1] * shade; b = rgb[2] * shade;
        // Contours (thin, faint), only at closer zooms: a fixed 1.5 m height
        // band per line so lines stay hairline on slopes and never turn into
        // dark stripes at high zoom.
        if (contourStep > 0) {
          const c = Math.abs((((h / contourStep) % 1) + 1) % 1 - 0.5);
          const width = 1.5 / contourStep;
          if (c > 0.5 - width) { r *= 0.9; g *= 0.9; b *= 0.9; }
        }
        // Shoreline: narrow pale band on the land side.
        if (h < 1.5) { r = lerp(r, P.sand[0], 0.5); g = lerp(g, P.sand[1], 0.5); b = lerp(b, P.sand[2], 0.5); }
      }
      const o = (j * px + i) * 4;
      out[o] = clamp(r, 0, 1) * 255;
      out[o + 1] = clamp(g, 0, 1) * 255;
      out[o + 2] = clamp(b, 0, 1) * 255;
      out[o + 3] = 255;
    }
  }
  return out;
}
