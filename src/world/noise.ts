/**
 * Seeded procedural noise primitives.
 *
 * Everything in this module is deterministic given its seed and is pure
 * TypeScript with no DOM dependencies, so it runs identically on the main
 * thread, inside workers, and in unit tests.
 */

/** 32-bit integer hash of two lattice coordinates and a seed (Wang/xxhash-style mix). */
export function hash2(ix: number, iz: number, seed: number): number {
  let h = (ix | 0) * 0x27d4eb2d;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= (iz | 0) * 0x165667b1;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= (seed | 0) + 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x27d4eb2d);
  h ^= h >>> 15;
  return h >>> 0;
}

/** Hash three integers into a 32-bit value. */
export function hash3(ix: number, iy: number, iz: number, seed: number): number {
  return hash2(hash2(ix, iy, seed) | 0, iz, seed ^ 0x5bd1e995);
}

/** Hash to a float in [0, 1). */
export function hash01(ix: number, iz: number, seed: number): number {
  return hash2(ix, iz, seed) / 4294967296;
}

/** Hash a string to a 32-bit seed (FNV-1a). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Small fast seeded PRNG (mulberry32). Returns floats in [0, 1). */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
}

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const GRAD = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

/**
 * 2D simplex noise with a seeded permutation table. Output range is
 * approximately [-1, 1].
 */
export class Simplex2 {
  private perm = new Uint8Array(512);
  private permMod8 = new Uint8Array(512);

  constructor(seed: number) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    const rng = new Rng(seed);
    for (let i = 255; i > 0; i--) {
      const j = rng.int(i + 1);
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod8[i] = this.perm[i] & 7;
    }
  }

  noise(xin: number, yin: number): number {
    const perm = this.perm;
    const permMod8 = this.permMod8;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    let i1: number, j1: number;
    if (x0 > y0) {
      i1 = 1;
      j1 = 0;
    } else {
      i1 = 0;
      j1 = 1;
    }
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    let n0 = 0, n1 = 0, n2 = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = GRAD[permMod8[ii + perm[jj]]];
      t0 *= t0;
      n0 = t0 * t0 * (g[0] * x0 + g[1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = GRAD[permMod8[ii + i1 + perm[jj + j1]]];
      t1 *= t1;
      n1 = t1 * t1 * (g[0] * x1 + g[1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = GRAD[permMod8[ii + 1 + perm[jj + 1]]];
      t2 *= t2;
      n2 = t2 * t2 * (g[0] * x2 + g[1] * y2);
    }
    return 70 * (n0 + n1 + n2);
  }

  /** Fractal Brownian motion, output roughly in [-1, 1]. */
  fbm(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let amp = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise(x, y);
      norm += amp;
      amp *= gain;
      x *= lacunarity;
      y *= lacunarity;
      // small per-octave offset breaks lattice alignment between octaves
      x += 17.31;
      y -= 9.71;
    }
    return sum / norm;
  }

  /** Ridged multifractal, output in [0, 1]; sharp crests near 1. */
  ridged(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let amp = 1;
    let sum = 0;
    let norm = 0;
    let weight = 1;
    for (let o = 0; o < octaves; o++) {
      let n = 1 - Math.abs(this.noise(x, y));
      n *= n;
      n *= weight;
      weight = Math.min(1, Math.max(0, n * 2));
      sum += n * amp;
      norm += amp;
      amp *= gain;
      x *= lacunarity;
      y *= lacunarity;
      x += 5.19;
      y += 11.3;
    }
    return sum / norm;
  }
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const saturate = (v: number) => clamp(v, 0, 1);
