/**
 * Rising air: thermals over sun-warmed open ground and ridge lift on slopes
 * that face the prevailing wind. Deterministic per seed (thermals live on a
 * 700 m cell lattice), cheap enough to evaluate every simulation step, and
 * exposed for the visual hints (dust motes, circling flocks) and the HUD.
 */
import { SEA_LEVEL } from '../core/config';
import { Biome } from '../world/biomes';
import { hash2, Rng } from '../world/noise';
import { createTerrainSample, type WorldGen } from '../world/WorldGen';

export interface Thermal {
  x: number;
  z: number;
  /** Column radius (m). */
  radius: number;
  /** Ground height at the core and the height where the lift dies out. */
  base: number;
  top: number;
  /** Peak vertical speed at midday (m/s). */
  strength: number;
}

export interface LiftSample { total: number; thermal: number; ridge: number; nearest: Thermal | null }

const CELL = 700;
/** Prevailing wind, the same direction the trees and clouds use. */
export const WIND_DIR = { x: 0.829, z: 0.559 };
export const WIND_SPEED = 9;

export class Airflow {
  private cache = new Map<string, Thermal | null>();
  private sample = createTerrainSample();

  constructor(private gen: WorldGen) {}

  /** Thermals only work while the sun heats the ground. */
  static daylightFactor(timeOfDay: number): number {
    const t = timeOfDay;
    const up = Math.min(1, Math.max(0, (t - 0.27) / 0.13)), down = 1 - Math.min(1, Math.max(0, (t - 0.66) / 0.14));
    return up * down;
  }

  thermalForCell(cx: number, cz: number): Thermal | null {
    const key = `${cx},${cz}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    if (this.cache.size > 600) this.cache.clear();
    const rng = new Rng(hash2(cx, cz, this.gen.seed ^ 0x7e4a));
    let thermal: Thermal | null = null;
    if (rng.next() < 0.42) {
      const x = (cx + 0.2 + rng.next() * 0.6) * CELL, z = (cz + 0.2 + rng.next() * 0.6) * CELL;
      const s = this.gen.sample(x, z, this.sample);
      const slope = this.gen.slopeAt(x, z);
      const open = s.biome === Biome.Temperate || s.biome === Biome.Upland || s.biome === Biome.Arid || s.biome === Biome.Wetland;
      if (s.height > SEA_LEVEL + 3 && slope < 0.3 && open) {
        const radius = 85 + rng.next() * 65;
        thermal = { x, z, radius, base: s.height, top: s.height + 550 + rng.next() * 400, strength: 3.2 + rng.next() * 1.8 * (s.biome === Biome.Arid ? 1.25 : 1) };
      }
    }
    this.cache.set(key, thermal);
    return thermal;
  }

  /** Thermals whose columns come within `radius` of a point. */
  thermalsNear(x: number, z: number, radius: number, out: Thermal[] = []): Thermal[] {
    out.length = 0;
    const c0x = Math.floor((x - radius) / CELL), c1x = Math.floor((x + radius) / CELL);
    const c0z = Math.floor((z - radius) / CELL), c1z = Math.floor((z + radius) / CELL);
    for (let cz = c0z; cz <= c1z; cz++) for (let cx = c0x; cx <= c1x; cx++) {
      const t = this.thermalForCell(cx, cz);
      if (t && Math.hypot(t.x - x, t.z - z) < radius + t.radius) out.push(t);
    }
    return out;
  }

  /** Vertical air speed (m/s) at a point, split by source. */
  lift(x: number, y: number, z: number, timeOfDay: number, out: LiftSample = { total: 0, thermal: 0, ridge: 0, nearest: null }): LiftSample {
    out.thermal = 0; out.ridge = 0; out.nearest = null;
    const daylight = Airflow.daylightFactor(timeOfDay);
    if (daylight > 0.01) {
      let best = Infinity;
      const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const t = this.thermalForCell(cx + dx, cz + dz);
        if (!t) continue;
        const d = Math.hypot(t.x - x, t.z - z);
        if (d < best) { best = d; out.nearest = t; }
        const r = d / t.radius;
        if (r >= 1) continue;
        const radial = (1 - r * r) * (1 - r * r);
        const h = y - t.base;
        const profile = smooth(h / 60) * (1 - smooth((h - (t.top - 150)) / 150));
        out.thermal += t.strength * radial * profile * daylight;
      }
    }
    // Ridge lift: the wind is deflected upward on slopes that face it.
    const ground = this.gen.heightAt(x, z);
    const h = y - ground;
    if (h < 160 && ground > SEA_LEVEL) {
      const e = 8;
      const gx = (this.gen.heightAt(x + e, z) - this.gen.heightAt(x - e, z)) / (2 * e);
      const gz = (this.gen.heightAt(x, z + e) - this.gen.heightAt(x, z - e)) / (2 * e);
      const upwind = gx * WIND_DIR.x + gz * WIND_DIR.z; // > 0 where the ground rises along the wind
      if (upwind > 0.12) {
        const band = smooth(h / 15) * (1 - smooth((h - 60) / 90));
        out.ridge = Math.min(6, WIND_SPEED * (upwind - 0.08)) * band;
      }
    }
    out.total = out.thermal + out.ridge;
    return out;
  }
}

function smooth(t: number): number { const c = Math.min(1, Math.max(0, t)); return c * c * (3 - 2 * c); }
