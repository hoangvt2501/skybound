/**
 * Tileable value-noise texture for the per-pixel terrain and water detail.
 * The shaders used to evaluate value noise procedurally (four sine hashes and
 * a smooth blend per lookup, five lookups per terrain pixel and nine per
 * water pixel); on integrated GPUs that ALU work was a third of the frame.
 * The same noise is baked once, with the smooth blend applied at four samples
 * per lattice cell so hardware bilinear filtering reproduces it without
 * lattice artifacts, and mipmaps take over where the procedural version used
 * to shimmer in the distance.
 *
 * Channels: R = value, G/B = d/dx and d/dz of the value in lattice units
 * (encoded (g / 3 + 0.5)), so ripple normals come from the texture instead
 * of three finite-difference lookups.
 *
 * In a shader, `texture2D(uNoise, p / NOISE_CELLS)`: the lattice repeats
 * every NOISE_CELLS units of the input, which for the scales used
 * (0.012-0.6 per metre) is 200 m to 10 km of terrain.
 */
import * as THREE from 'three';

export const NOISE_CELLS = 128;
const TEXELS_PER_CELL = 4;

function hash(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

let shared: THREE.DataTexture | null = null;

export function noiseTexture(): THREE.DataTexture {
  if (shared) return shared;
  const size = NOISE_CELLS * TEXELS_PER_CELL;
  const data = new Uint8Array(size * size * 4);
  // Lattice values, periodic so the texture tiles.
  const lattice = new Float32Array(NOISE_CELLS * NOISE_CELLS);
  for (let j = 0; j < NOISE_CELLS; j++) for (let i = 0; i < NOISE_CELLS; i++) lattice[j * NOISE_CELLS + i] = hash(i, j);
  const at = (i: number, j: number) => lattice[((j % NOISE_CELLS) + NOISE_CELLS) % NOISE_CELLS * NOISE_CELLS + ((i % NOISE_CELLS) + NOISE_CELLS) % NOISE_CELLS];
  for (let y = 0; y < size; y++) {
    const fy = y / TEXELS_PER_CELL, j = Math.floor(fy);
    const ry = fy - j, ty = ry * ry * (3 - 2 * ry), dty = 6 * ry * (1 - ry);
    for (let x = 0; x < size; x++) {
      const fx = x / TEXELS_PER_CELL, i = Math.floor(fx);
      const rx = fx - i, tx = rx * rx * (3 - 2 * rx), dtx = 6 * rx * (1 - rx);
      const a = at(i, j), b = at(i + 1, j), c = at(i, j + 1), d = at(i + 1, j + 1);
      const top = a + (b - a) * tx, bottom = c + (d - c) * tx;
      const v = top * (1 - ty) + bottom * ty;
      const gx = ((b - a) * (1 - ty) + (d - c) * ty) * dtx;
      const gz = (bottom - top) * dty;
      const o = (y * size + x) * 4;
      data[o] = Math.round(v * 255);
      data[o + 1] = Math.round(Math.min(1, Math.max(0, gx / 3 + 0.5)) * 255);
      data[o + 2] = Math.round(Math.min(1, Math.max(0, gz / 3 + 0.5)) * 255);
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 1; // anisotropic taps at grazing angles over water and plains cost more than they show
  tex.needsUpdate = true;
  shared = tex;
  return tex;
}
