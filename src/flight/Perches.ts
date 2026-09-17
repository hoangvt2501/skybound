/**
 * Perches: places the bird can land, rest and take off from. Every landmark offers one fixed point on
 * its top (a gallery rim, a merlon, a wall, the crown of the giant tree...), and a deterministic subset of
 * the largest trees and boulders near the bird offer their tops. Landing is a short scripted glide onto
 * the point (the physics step pauses); take-off is a hop back into flight.
 */
import { Species, SPECIES_COLLIDER } from '../world/biomes';
import type { Landmark } from '../world/Landmarks';
import { hash2, Rng } from '../world/noise';

export type PerchKind = 'landmark' | 'tree' | 'rock';
export interface Perch { id: string; kind: PerchKind; x: number; y: number; z: number; name: string; landmarkId?: string; species?: number }
/**
 * A tree or boulder as the terrain reports it: `top` is the collision cylinder's top; `peak*` (when
 * known) is the highest point of the rendered model over the trunk axis, in world space, which is
 * where a bird can actually stand.
 */
export interface TreeLike { x: number; y: number; z: number; radius: number; top: number; species: number; peakX?: number; peakY?: number; peakZ?: number }
export interface PerchTerrain {
  forEachTreeNear(x: number, z: number, radius: number, cb: (t: TreeLike) => boolean | void): void;
  heightAt(x: number, z: number): number;
}

export const LANDING = {
  /** The bird must pass within this distance (m) of the perch point... */
  captureRadius: 7,
  /** ...no faster than this (m/s) and not diving harder than this (m/s vertical). */
  maxSpeed: 24,
  minVy: -14,
  /** Scripted glide onto the perch, and the hop off it. */
  seconds: 0.9,
  takeoffSeconds: 0.55,
  /** Speed the bird leaves a perch with. */
  takeoffSpeed: 16,
  /** Candidates are looked for this far out; the marker shows the best one ahead. */
  lookRadius: 180,
  /** Only the biggest trees and boulders are perches; a stable subset by position hash. */
  treeMinScale: 1.05,
  rockMinScale: 1.15,
  treeShare: 0.12,
  /** How far the bird sits above the perch point (body centre over the feet). */
  birdLift: 0.32,
} as const;

/** The perch point of a landmark in world space, or null for types without one. */
export function landmarkPerch(lm: Landmark, seed: number, heightAt: (x: number, z: number) => number): Perch | null {
  let ox = 0, oy = 0, oz = 0;
  switch (lm.type) {
    case 'lighthouse': ox = 3.1; oy = 27.25; break; // gallery rim below the lamp room
    case 'tower': ox = 4.6; oy = 23.7; break; // a merlon of the battlement
    case 'ruins': ox = -14; oy = 8.55; break; // top of the standing wall
    case 'arch': oy = 33.3; break; // crown of the arch
    case 'giant-tree': oy = 57.2; break; // top of the crown
    case 'shrine': oy = 16.6; break; // tip of the upper roof
    case 'stones': {
      // The first stone's height is the first draw of the landmark's own geometry RNG.
      const rng = new Rng(hash2(7, 3, seed) ^ hash2(Math.round(lm.x), Math.round(lm.z), 5));
      const hgt = 5 + rng.next() * 3;
      ox = 12; oy = hgt - 0.35; break;
    }
    case 'bridge': {
      const dir = { x: Math.sin(lm.heading), z: -Math.cos(lm.heading) };
      const rimA = heightAt(lm.x + dir.x * 75, lm.z + dir.z * 75), rimB = heightAt(lm.x - dir.x * 75, lm.z - dir.z * 75);
      const deck = Math.max(rimA, rimB) + 4 - lm.y;
      ox = 3.9; oy = deck + 10; break; // top of the middle post
    }
    default: return null;
  }
  return { id: `lm:${lm.id}`, kind: 'landmark', x: lm.x + ox, y: lm.y + oy, z: lm.z + oz, name: lm.name, landmarkId: lm.id };
}

/** A tree or boulder that is big enough and chosen by its position hash becomes a perch on its top. */
export function treePerch(t: TreeLike): Perch | null {
  const col = SPECIES_COLLIDER[t.species];
  if (!col) return null;
  const scale = t.radius / col.radius;
  const rock = t.species === Species.Rock;
  if (rock) { if (scale < LANDING.rockMinScale) return null; }
  else {
    if (t.species !== Species.Oak && t.species !== Species.Pine && t.species !== Species.Willow && t.species !== Species.Birch) return null;
    if (scale < LANDING.treeMinScale) return null;
    if (hash2(Math.round(t.x), Math.round(t.z), 91) / 4294967296 > LANDING.treeShare) return null;
  }
  const key = `${Math.round(t.x)}:${Math.round(t.z)}`;
  // Stand on the model's own highest point (the crown over the trunk, the tallest boulder of a cluster);
  // without it, fall back to the collider top.
  const hasPeak = t.peakY !== undefined && t.peakX !== undefined && t.peakZ !== undefined;
  const x = hasPeak ? t.peakX! : t.x, z = hasPeak ? t.peakZ! : t.z;
  const y = hasPeak ? t.peakY! + (rock ? 0 : 0.05) : t.top - (rock ? 0.1 : 0.6);
  return { id: `${rock ? 'rock' : 'tree'}:${key}`, kind: rock ? 'rock' : 'tree', x, y, z, name: rock ? 'a boulder' : 'a treetop', species: t.species };
}

/** Ease-out position progress of the landing glide: fast off the approach, gentle onto the perch. */
export function landingProgress(u: number): number { const c = Math.min(1, Math.max(0, u)); return 1 - (1 - c) * (1 - c) * (1 - c); }
/** Flare: wings spread and nose up, peaking two thirds of the way in, settling as the feet touch. */
export function landingFlare(u: number): number { const c = Math.min(1, Math.max(0, u)); return Math.sin(Math.PI * Math.min(1, c / 0.9)) * (c < 0.9 ? 1 : 1 - (c - 0.9) / 0.1); }

/** Does a flight state qualify to capture a perch (close, slow, not diving, not boosting)? */
export function canCapture(s: { x: number; y: number; z: number; speed: number; vy: number; boosting: boolean }, p: Perch): boolean {
  if (s.speed > LANDING.maxSpeed || s.vy < LANDING.minVy || s.boosting) return false;
  const dy = s.y - p.y;
  if (dy < -1.5 || dy > 6) return false; // from above or level, never from below
  return Math.hypot(s.x - p.x, s.z - p.z) <= LANDING.captureRadius;
}

export class PerchFinder {
  private landmarkPerches: Perch[] = [];
  private scratch: Perch[] = [];
  constructor(landmarks: Landmark[], seed: number, private terrain: PerchTerrain) {
    for (const lm of landmarks) { const p = landmarkPerch(lm, seed, (x, z) => terrain.heightAt(x, z)); if (p) this.landmarkPerches.push(p); }
  }

  /** Every landmark perch (tests, the map). */
  get landmarkPoints(): readonly Perch[] { return this.landmarkPerches; }

  /** Perches within `radius` of a point: landmark points plus qualifying trees and boulders (a fresh array). */
  near(x: number, z: number, radius: number): Perch[] {
    const out: Perch[] = [];
    for (const p of this.landmarkPerches) if (Math.hypot(p.x - x, p.z - z) <= radius) out.push(p);
    this.terrain.forEachTreeNear(x, z, radius, (t) => { const p = treePerch(t); if (p) out.push(p); });
    return out;
  }

  /**
   * The best perch to show the bird: within `radius`, roughly ahead (a landmark counts from further
   * behind the beam), nearest wins. Landmark perches are preferred over trees at equal distance.
   */
  best(x: number, y: number, z: number, headingX: number, headingZ: number, radius = LANDING.lookRadius): Perch | null {
    this.scratch = this.near(x, z, radius);
    let best: Perch | null = null, bestScore = Infinity;
    for (const p of this.scratch) {
      const dx = p.x - x, dz = p.z - z, d = Math.hypot(dx, dz, p.y - y);
      if (d < 1e-3) continue;
      const ahead = (dx * headingX + dz * headingZ) / Math.max(1e-3, Math.hypot(dx, dz));
      if (ahead < (p.kind === 'landmark' ? -0.2 : 0.35)) continue;
      const score = d * (p.kind === 'landmark' ? 0.7 : 1) * (1.4 - 0.4 * ahead);
      if (score < bestScore) { bestScore = score; best = p; }
    }
    return best;
  }
}
