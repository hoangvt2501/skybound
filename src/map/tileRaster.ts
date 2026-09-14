/**
 * Map tile rasterization from WorldGen. Pure: returns RGBA pixels so it can
 * run in a worker and be unit-tested.
 */
import { SEA_LEVEL } from '../core/config';
import { createTerrainSample, WorldGen } from '../world/WorldGen';
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
  const sample = createTerrainSample();
  const rgb = new Float32Array(3);
  const out = new Uint8ClampedArray(px * px * 4);
  // Height pass with a ring for hillshade.
  for (let j = 0; j < n; j++) {
    const z = oz + (j - 0.5) * mpp;
    for (let i = 0; i < n; i++) {
      const x = ox + (i - 0.5) * mpp;
      heights[j * n + i] = gen.sample(x, z, sample).height;
    }
  }
  const lx = -0.6, lz = -0.55, ly = 0.58; // light from north-west, above
  for (let j = 0; j < px; j++) {
    const z = oz + (j + 0.5) * mpp;
    for (let i = 0; i < px; i++) {
      const x = ox + (i + 0.5) * mpp;
      const gi = (j + 1) * n + (i + 1);
      const h = heights[gi];
      const dx = (heights[gi + 1] - heights[gi - 1]) / (2 * mpp);
      const dz = (heights[gi + n] - heights[gi - n]) / (2 * mpp);
      const slope = Math.hypot(dx, dz);
      let r: number, g: number, b: number;
      if (h < SEA_LEVEL) {
        const d = smoothstep(0, 40, -h);
        r = lerp(0.40, 0.13, d); g = lerp(0.66, 0.30, d); b = lerp(0.78, 0.52, d);
      } else {
        gen.sample(x, z, sample);
        gen.colorAt(sample, slope, x, z, rgb, 0);
        // Hillshade
        let nx = -dx, ny = 1, nz = -dz;
        const il = 1 / Math.hypot(nx, ny, nz);
        nx *= il; ny *= il; nz *= il;
        const shade = clamp(0.62 + 0.55 * (nx * lx + ny * ly + nz * lz), 0.35, 1.15);
        r = rgb[0] * shade; g = rgb[1] * shade; b = rgb[2] * shade;
        // Elevation tint: higher ground slightly lighter.
        const e = smoothstep(0, 1400, h) * 0.12;
        r = lerp(r, 1, e); g = lerp(g, 1, e); b = lerp(b, 1, e);
        // Contour lines every 100 m (subtle).
        const c = Math.abs(((h / 100) % 1 + 1) % 1 - 0.5);
        if (c > 0.5 - Math.min(0.06, 0.6 / (mpp + 4)) && zoom >= 2) {
          r *= 0.88; g *= 0.88; b *= 0.88;
        }
        // Shoreline
        if (h < 1.2) {
          r = lerp(r, 0.95, 0.35); g = lerp(g, 0.92, 0.35); b = lerp(b, 0.75, 0.35);
        }
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
