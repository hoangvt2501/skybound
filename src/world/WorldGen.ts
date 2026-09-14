/**
 * WorldGen: the single authoritative source of terrain, water, climate, biome
 * and vegetation data for a seed. Rendered chunks, map tiles, collision,
 * navigation and landmark placement all sample through this class, so they
 * always agree.
 *
 * Pure TypeScript with no DOM dependencies: used in the main thread, workers
 * and tests.
 */
import { REGION_HALF_SIZE, SEA_LEVEL } from '../core/config';
import { Biome, BIOME_COUNT, Species } from './biomes';
import { Rng, Simplex2, clamp, lerp, smoothstep, hash2, hashString } from './noise';

export interface TerrainSample {
  height: number;
  /** 0..1 masks used by height and color. */
  mount: number;
  arid: number;
  wet: number;
  upland: number;
  land: number;
  temp: number;
  moist: number;
  snowLine: number;
  /** Terrace band index (arid) for striped rock colors. */
  band: number;
  /** Ridge value (alpine) used for rock/snow detail. */
  ridge: number;
  hills: number;
  detail: number;
  /** Normalized biome weights. */
  weights: Float32Array;
  /** Dominant biome. */
  biome: Biome;
}

export function createTerrainSample(): TerrainSample {
  return {
    height: 0,
    mount: 0,
    arid: 0,
    wet: 0,
    upland: 0,
    land: 0,
    temp: 0.5,
    moist: 0.5,
    snowLine: 800,
    band: 0,
    ridge: 0,
    hills: 0,
    detail: 0,
    weights: new Float32Array(BIOME_COUNT),
    biome: Biome.Temperate,
  };
}

export interface MacroLayout {
  angle: number;
  spine: [number, number][];
  spineWidth: number;
  arid: { x: number; y: number; r: number };
  wet: { x: number; y: number; r: number };
  upland: { x: number; y: number; r: number };
  landRadius: number;
}

const RH = REGION_HALF_SIZE;

function terrace(h: number, step: number): number {
  const q = h / step;
  const f = Math.floor(q);
  const t = q - f;
  const s = smoothstep(0.42, 0.62, t);
  return (f + s) * step;
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const l2 = vx * vx + vy * vy;
  let t = l2 > 0 ? (wx * vx + wy * vy) / l2 : 0;
  t = clamp(t, 0, 1);
  const dx = px - (ax + vx * t), dy = py - (ay + vy * t);
  return Math.sqrt(dx * dx + dy * dy);
}

export interface VegetationChoice {
  density: number;
  species: Species;
}

export class WorldGen {
  readonly seed: number;
  readonly layout: MacroLayout;
  private nBase: Simplex2;
  private nHills: Simplex2;
  private nRidge: Simplex2;
  private nDetail: Simplex2;
  private nClimate: Simplex2;
  private nWarp: Simplex2;
  private nVeg: Simplex2;
  private cosA: number;
  private sinA: number;
  private scratch: TerrainSample;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    const s = this.seed;
    this.nBase = new Simplex2(hash2(1, 0, s));
    this.nHills = new Simplex2(hash2(2, 0, s));
    this.nRidge = new Simplex2(hash2(3, 0, s));
    this.nDetail = new Simplex2(hash2(4, 0, s));
    this.nClimate = new Simplex2(hash2(5, 0, s));
    this.nWarp = new Simplex2(hash2(6, 0, s));
    this.nVeg = new Simplex2(hash2(7, 0, s));
    this.layout = WorldGen.makeLayout(s);
    this.cosA = Math.cos(this.layout.angle);
    this.sinA = Math.sin(this.layout.angle);
    this.scratch = createTerrainSample();
  }

  /** Parse a seed from text: integers are used directly, other strings are hashed. */
  static parseSeed(text: string | null | undefined, fallback: number): number {
    if (text == null || text.trim() === '') return fallback;
    const t = text.trim();
    if (/^-?\d+$/.test(t)) return Number.parseInt(t, 10) >>> 0;
    return hashString(t);
  }

  static makeLayout(seed: number): MacroLayout {
    const rng = new Rng(hash2(11, 7, seed));
    const jit = (v: number, amt: number) => v + (rng.next() * 2 - 1) * amt;
    return {
      angle: rng.next() * Math.PI * 2,
      spine: [
        [jit(-0.62, 0.08), jit(-0.32, 0.08)],
        [jit(-0.12, 0.08), jit(0.12, 0.08)],
        [jit(0.5, 0.08), jit(0.52, 0.08)],
      ],
      spineWidth: jit(0.21, 0.03),
      arid: { x: jit(0.52, 0.08), y: jit(-0.48, 0.08), r: jit(0.46, 0.04) },
      wet: { x: jit(-0.5, 0.08), y: jit(0.52, 0.08), r: jit(0.42, 0.04) },
      upland: { x: jit(-0.08, 0.08), y: jit(-0.6, 0.06), r: jit(0.4, 0.04) },
      landRadius: jit(0.88, 0.04),
    };
  }

  /** Convert rotated, normalized region coordinates back to world x/z. */
  regionToWorld(ru: number, rv: number): { x: number; z: number } {
    const u = this.cosA * ru + this.sinA * rv;
    const v = -this.sinA * ru + this.cosA * rv;
    return { x: u * RH, z: v * RH };
  }

  /** Full terrain sample (height, masks, climate, biome weights). */
  sample(x: number, z: number, out: TerrainSample): TerrainSample {
    const L = this.layout;
    const u = x / RH, v = z / RH;
    const ru = this.cosA * u - this.sinA * v;
    const rv = this.sinA * u + this.cosA * v;

    // Macro landmass: rounded-square island continent, warped for bays.
    const au = Math.abs(ru), av = Math.abs(rv);
    const rr = Math.cbrt(au * au * au + av * av * av);
    const warpL = this.nWarp.fbm(x / 5200, z / 5200, 3);
    const landmass = 1 - smoothstep(L.landRadius - 0.16, L.landRadius + 0.16, rr + 0.14 * warpL);
    const outerLand = smoothstep(-0.02, 0.28, this.nBase.fbm(x / 9000 + 100, z / 9000 - 40, 3));
    const macroW = 1 - smoothstep(1.05, 1.45, rr);
    let land = lerp(outerLand, landmass, macroW);

    const hills = this.nHills.fbm(x / 640, z / 640, 3);
    const island = smoothstep(0.58, 0.82, this.nHills.fbm(x / 1500 + 77, z / 1500 - 33, 3)) * (1 - land);
    land = clamp(land + island * 0.95, 0, 1);

    // Regional masks with organic edges.
    const edge = 0.07 * this.nWarp.fbm(x / 2600 + 9, z / 2600 + 4, 2);
    let mount = 0;
    {
      const d0 = segDist(ru, rv, L.spine[0][0], L.spine[0][1], L.spine[1][0], L.spine[1][1]);
      const d1 = segDist(ru, rv, L.spine[1][0], L.spine[1][1], L.spine[2][0], L.spine[2][1]);
      const d = Math.min(d0, d1) + edge * 0.7;
      mount = 1 - smoothstep(L.spineWidth * 0.35, L.spineWidth, d);
    }
    const dA = Math.hypot(ru - L.arid.x, rv - L.arid.y) + edge;
    let arid = 1 - smoothstep(L.arid.r * 0.5, L.arid.r, dA);
    const dW = Math.hypot(ru - L.wet.x, rv - L.wet.y) + edge;
    let wet = 1 - smoothstep(L.wet.r * 0.5, L.wet.r, dW);
    const dU = Math.hypot(ru - L.upland.x, rv - L.upland.y) + edge;
    let upland = 1 - smoothstep(L.upland.r * 0.5, L.upland.r, dU);
    // Masks only apply inside the curated region; outside it terrain is generic.
    mount *= macroW;
    arid *= macroW;
    wet *= macroW;
    upland *= macroW;
    const sum = mount + arid + wet + upland;
    if (sum > 1) {
      mount /= sum;
      arid /= sum;
      wet /= sum;
      upland /= sum;
    }
    const temperate = Math.max(0, 1 - Math.min(1, sum));

    // Component heights (lazy: skip components with negligible weight).
    const wx = x + 420 * warpL, wz = z - 380 * warpL;
    const base = this.nBase.fbm(wx / 2600, wz / 2600, 4);
    const detail = this.nDetail.fbm(x / 110, z / 110, 2);
    const hTemp = 24 + 46 * (base * 0.5 + 0.5) + 22 * hills + 5 * detail;
    let h = temperate * hTemp;
    let ridge = 0;
    let band = 0;
    if (mount > 0.001) {
      ridge = this.nRidge.ridged(wx / 1900, wz / 1900, 5, 2, 0.46);
      // Round the crests so peaks read as massifs rather than needles.
      const rounded = ridge * ridge * (3 - 2 * ridge);
      // Fine rock detail so faces read as stone rather than clay.
      const rockDetail = this.nRidge.fbm(x / 230 + 7, z / 230 - 3, 2) * 34 + detail * 10;
      const hMount = 300 + 1100 * Math.pow(rounded, 1.35) + 70 * hills + rockDetail * (0.4 + 0.6 * rounded);
      h += mount * hMount;
    }
    if (upland > 0.001) {
      const roll = this.nRidge.fbm(x / 900 + 20, z / 900 + 20, 3);
      const hUp = 200 + 130 * base + 60 * hills + 40 * roll + 4 * detail;
      h += upland * hUp;
    }
    if (arid > 0.001) {
      // Mesas: terraced plateau with cliff steps, cut by steep-walled canyons.
      const plat = 170 + 80 * base + 30 * this.nHills.fbm(x / 1900 + 5, z / 1900 + 5, 2) + 26 * hills;
      const terr = terrace(plat, 30);
      band = Math.floor(plat / 30);
      const cn = this.nRidge.ridged(x / 1400 + 40, z / 1400 - 10, 3);
      const canyon = smoothstep(0.66, 0.78, cn) * 150;
      const hArid = terr - canyon + 3 * hills + 2 * detail;
      h += arid * hArid;
    }
    if (wet > 0.001) {
      const ponds = smoothstep(0.42, 0.68, this.nHills.fbm(x / 520 + 31, z / 520 + 7, 3));
      const lakes = smoothstep(0.48, 0.74, this.nBase.fbm(x / 1500 + 50, z / 1500 + 50, 2));
      const hWet = 3.6 + 1.5 * hills + 1.8 * detail - 9 * ponds - 8 * lakes;
      h += wet * hWet;
    }

    // Coast: fall away to the seafloor where land-ness drops.
    const seafloor = -36 + 12 * hills + 9 * base + island * (68 + 30 * hills);
    const landT = Math.pow(land, 0.75);
    h = lerp(seafloor, h, landT);
    if (h > 2400) h = 2400;

    // Climate.
    const tempBase = clamp(
      0.56 + 0.28 * this.nClimate.fbm(x / 7000, z / 7000, 2) - 0.22 * rv * macroW + 0.32 * arid - 0.12 * mount,
      0,
      1,
    );
    const temp = clamp(tempBase - 0.00042 * Math.max(0, h), 0, 1);
    const moist = clamp(
      0.5 + 0.3 * this.nClimate.fbm(x / 6000 + 200, z / 6000 + 200, 3) + 0.38 * wet - 0.42 * arid + 0.1 * (1 - land),
      0,
      1,
    );
    const snowLine = 760 + 640 * (tempBase - 0.5);

    out.height = h;
    out.mount = mount;
    out.arid = arid;
    out.wet = wet;
    out.upland = upland;
    out.land = land;
    out.temp = temp;
    out.moist = moist;
    out.snowLine = snowLine;
    out.band = band;
    out.ridge = ridge;
    out.hills = hills;
    out.detail = detail;

    // Biome weights.
    const w = out.weights;
    if (h < SEA_LEVEL) {
      w.fill(0);
      w[Biome.Ocean] = 1;
      out.biome = Biome.Ocean;
      return out;
    }
    const coast = clamp((1 - smoothstep(3, 15, h)) * (1 - wet) + island * 0.4, 0, 1);
    const wetland = wet * (1 - smoothstep(12, 30, h));
    const alpine = clamp(mount * smoothstep(320, 540, h) + smoothstep(720, 980, h) * (1 - arid), 0, 1);
    let wT = coast, wA = alpine, wAr = arid * (1 - alpine), wW = wetland, wU = upland * (1 - alpine);
    let tot = wT + wA + wAr + wW + wU;
    let wTemp = 0;
    if (tot < 1) wTemp = 1 - tot;
    else {
      wT /= tot; wA /= tot; wAr /= tot; wW /= tot; wU /= tot;
    }
    tot = wT + wA + wAr + wW + wU + wTemp;
    w[Biome.Temperate] = wTemp / tot;
    w[Biome.Alpine] = wA / tot;
    w[Biome.Coast] = wT / tot;
    w[Biome.Arid] = wAr / tot;
    w[Biome.Wetland] = wW / tot;
    w[Biome.Upland] = wU / tot;
    w[Biome.Ocean] = 0;
    let best = 0, bw = -1;
    for (let i = 0; i < BIOME_COUNT; i++) {
      if (w[i] > bw) { bw = w[i]; best = i; }
    }
    out.biome = best as Biome;
    return out;
  }

  /** Terrain height at a global position (meters, sea level 0). */
  heightAt(x: number, z: number): number {
    return this.sample(x, z, this.scratch).height;
  }

  /** Water surface level at a global position. Global sea level in this release. */
  waterLevelAt(_x: number, _z: number): number {
    return SEA_LEVEL;
  }

  isWaterAt(x: number, z: number): boolean {
    return this.heightAt(x, z) < SEA_LEVEL;
  }

  /** Gradient magnitude (rise over run) from central differences. */
  slopeAt(x: number, z: number, d = 6): number {
    const hx = this.heightAt(x + d, z) - this.heightAt(x - d, z);
    const hz = this.heightAt(x, z + d) - this.heightAt(x, z - d);
    return Math.hypot(hx, hz) / (2 * d);
  }

  /** Snow coverage 0..1 for a sample and slope. */
  snowAt(s: TerrainSample, slope: number): number {
    const line = s.snowLine + 40 * s.detail;
    let snow = smoothstep(line - 70, line + 60, s.height);
    // Only near-vertical faces shed their snow.
    snow *= 1 - smoothstep(1.4, 2.6, slope);
    return snow;
  }

  /**
   * Ground color for a sample (sRGB-ish values 0..1). Writes r,g,b into
   * `out` at `offset`.
   */
  colorAt(s: TerrainSample, slope: number, x: number, z: number, out: Float32Array | number[], offset = 0): void {
    const w = s.weights;
    const h = s.height;
    const n1 = s.hills * 0.5 + 0.5;
    const n2 = s.detail * 0.5 + 0.5;
    let r = 0, g = 0, b = 0;

    if (h < SEA_LEVEL) {
      // Seabed: sand fading to dark teal with depth.
      const dpt = smoothstep(0, 28, -h);
      r = lerp(0.66, 0.12, dpt);
      g = lerp(0.62, 0.26, dpt);
      b = lerp(0.46, 0.32, dpt);
      out[offset] = r; out[offset + 1] = g; out[offset + 2] = b;
      return;
    }

    if (w[Biome.Temperate] > 0) {
      const m = smoothstep(0.35, 0.75, n1);
      const tr = lerp(0.30, 0.52, m), tg = lerp(0.47, 0.58, m), tb = lerp(0.19, 0.24, m);
      r += w[Biome.Temperate] * tr; g += w[Biome.Temperate] * tg; b += w[Biome.Temperate] * tb;
    }
    if (w[Biome.Alpine] > 0) {
      const t = smoothstep(350, 800, h);
      const ar = lerp(0.36, 0.47, t), ag = lerp(0.46, 0.44, t), ab = lerp(0.27, 0.41, t);
      const rk = 0.15 * (s.ridge - 0.5);
      r += w[Biome.Alpine] * (ar + rk); g += w[Biome.Alpine] * (ag + rk); b += w[Biome.Alpine] * (ab + rk);
    }
    if (w[Biome.Coast] > 0) {
      const wetSand = 1 - smoothstep(0.5, 3.5, h);
      const cr = lerp(0.82, 0.68, wetSand), cg = lerp(0.76, 0.64, wetSand), cb = lerp(0.58, 0.50, wetSand);
      r += w[Biome.Coast] * cr; g += w[Biome.Coast] * cg; b += w[Biome.Coast] * cb;
    }
    if (w[Biome.Arid] > 0) {
      // Banded mesa rock: deep red, orange and tan strata; canyon floors sandy.
      const k = ((s.band % 3) + 3) % 3;
      let ar: number, ag: number, ab: number;
      if (k === 0) { ar = 0.66; ag = 0.32; ab = 0.20; }
      else if (k === 1) { ar = 0.82; ag = 0.50; ab = 0.28; }
      else { ar = 0.86; ag = 0.70; ab = 0.46; }
      const cliff = smoothstep(0.35, 0.9, slope);
      ar = lerp(ar, 0.70, cliff * 0.5); ag = lerp(ag, 0.36, cliff * 0.5); ab = lerp(ab, 0.22, cliff * 0.5);
      const scrub = smoothstep(0.6, 0.85, n2) * 0.22 * (1 - cliff);
      ar = lerp(ar, 0.52, scrub); ag = lerp(ag, 0.54, scrub); ab = lerp(ab, 0.3, scrub);
      r += w[Biome.Arid] * ar; g += w[Biome.Arid] * ag; b += w[Biome.Arid] * ab;
    }
    if (w[Biome.Wetland] > 0) {
      const mud = 1 - smoothstep(0.3, 2.5, h);
      const reed = smoothstep(0.55, 0.8, n2);
      let wr = lerp(0.38, 0.60, reed), wg = lerp(0.47, 0.57, reed), wb = lerp(0.24, 0.33, reed);
      wr = lerp(wr, 0.36, mud); wg = lerp(wg, 0.31, mud); wb = lerp(wb, 0.22, mud);
      r += w[Biome.Wetland] * wr; g += w[Biome.Wetland] * wg; b += w[Biome.Wetland] * wb;
    }
    if (w[Biome.Upland] > 0) {
      // Wildflower patches from a high-frequency field.
      const f = this.nVeg.noise(x / 38, z / 38);
      const f2 = this.nVeg.noise(x / 9 + 50, z / 9 + 50);
      let ur = 0.44, ug = 0.56, ub = 0.28;
      if (f > 0.25 && f2 > 0.1) {
        const pick = this.nVeg.noise(x / 160 + 300, z / 160 + 300);
        if (pick > 0.2) { ur = 0.86; ug = 0.48; ub = 0.62; }
        else if (pick < -0.2) { ur = 0.62; ug = 0.48; ub = 0.84; }
        else { ur = 0.9; ug = 0.82; ub = 0.36; }
        const k = smoothstep(0.25, 0.45, f);
        ur = lerp(0.44, ur, k); ug = lerp(0.56, ug, k); ub = lerp(0.28, ub, k);
      }
      r += w[Biome.Upland] * ur; g += w[Biome.Upland] * ug; b += w[Biome.Upland] * ub;
    }

    // Steep faces are rock.
    const rock = smoothstep(0.55, 1.1, slope) * (1 - w[Biome.Coast] * 0.5) * (1 - w[Biome.Arid] * 0.9);
    const rr = lerp(0.47, 0.60, n2), rg = lerp(0.43, 0.55, n2), rb = lerp(0.39, 0.50, n2);
    r = lerp(r, rr, rock); g = lerp(g, rg, rock); b = lerp(b, rb, rock);

    // Snow.
    const snow = this.snowAt(s, slope);
    r = lerp(r, 0.93, snow); g = lerp(g, 0.95, snow); b = lerp(b, 0.99, snow);

    // Subtle variation.
    const vv = 1 + 0.06 * (n2 - 0.5);
    out[offset] = clamp(r * vv, 0, 1);
    out[offset + 1] = clamp(g * vv, 0, 1);
    out[offset + 2] = clamp(b * vv, 0, 1);
  }

  /**
   * Vegetation density (expected instances per candidate cell, 0..1) and
   * species choice for a sample. `u` is a uniform random in [0,1).
   */
  vegetationAt(s: TerrainSample, slope: number, u: number, out: VegetationChoice): VegetationChoice {
    const w = s.weights;
    const h = s.height;
    out.density = 0;
    out.species = Species.Oak;
    if (h < 1.5 || slope > 0.75) return out;
    const snow = this.snowAt(s, slope);
    if (snow > 0.35) return out;
    const treeLine = 1 - smoothstep(s.snowLine - 260, s.snowLine - 60, h);
    const patch = 0.35 + 0.65 * smoothstep(-0.3, 0.5, s.hills);
    let density = 0;
    density += w[Biome.Temperate] * 0.85 * patch;
    density += w[Biome.Alpine] * 0.7 * patch;
    density += w[Biome.Coast] * 0.22;
    density += w[Biome.Arid] * 0.16;
    density += w[Biome.Wetland] * 0.3 * smoothstep(1.5, 4, h);
    density += w[Biome.Upland] * 0.28 * patch;
    density *= treeLine;
    let species = Species.Oak;
    switch (s.biome) {
      case Biome.Temperate:
        species = u < 0.58 ? Species.Oak : u < 0.85 ? Species.Pine : Species.Birch;
        break;
      case Biome.Alpine:
        species = u < 0.9 ? Species.Pine : Species.Birch;
        break;
      case Biome.Coast:
        species = u < 0.45 ? Species.Palm : Species.Shrub;
        break;
      case Biome.Arid:
        species = u < 0.35 ? Species.Cactus : u < 0.6 ? Species.Deadwood : Species.Shrub;
        break;
      case Biome.Wetland:
        species = u < 0.55 ? Species.Willow : Species.Shrub;
        break;
      case Biome.Upland:
        species = u < 0.45 ? Species.Birch : u < 0.75 ? Species.Shrub : Species.Oak;
        break;
      default:
        density = 0;
    }
    out.density = density;
    out.species = species;
    return out;
  }
}
