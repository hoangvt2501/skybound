import { describe, expect, it } from 'vitest';
import { LANDING, PerchFinder, canCapture, landingFlare, landingProgress, landmarkPerch, treePerch, type TreeLike } from '../src/flight/Perches';
import { placeLandmarks, type Landmark } from '../src/world/Landmarks';
import { Species, SPECIES_COLLIDER } from '../src/world/biomes';
import { WorldGen } from '../src/world/WorldGen';

const gen = new WorldGen(1207);
const landmarks = placeLandmarks(gen);
const heightAt = (x: number, z: number) => gen.heightAt(x, z);

describe('perches', () => {
  it('gives every landmark a perch point above its base, on the structure', () => {
    const byType = new Map<string, Landmark>();
    for (const lm of landmarks) if (!byType.has(lm.type)) byType.set(lm.type, lm);
    expect(byType.size).toBeGreaterThanOrEqual(6);
    for (const [type, lm] of byType) {
      const p = landmarkPerch(lm, gen.seed, heightAt)!;
      expect(p, type).not.toBeNull();
      expect(p.y - lm.y, type).toBeGreaterThan(5);
      expect(p.y - lm.y, type).toBeLessThan(type === 'bridge' ? 260 : 70); // a bridge deck sits at the canyon rims, far above its floor origin
      expect(Math.hypot(p.x - lm.x, p.z - lm.z), type).toBeLessThan(20);
      expect(p.landmarkId).toBe(lm.id);
    }
    // Standing stones: the perch sits on the first stone, whose height comes from the geometry RNG (5..8 m).
    const stones = byType.get('stones');
    if (stones) { const p = landmarkPerch(stones, gen.seed, heightAt)!; expect(p.y - stones.y).toBeGreaterThan(4.5); expect(p.y - stones.y).toBeLessThan(8); }
  });
  it('turns only big oaks, pines, willows, birches (a hashed share) and big boulders into perches', () => {
    const tree = (species: number, scale: number, x = 100, z = 200): TreeLike => ({ x, y: 10, z, radius: SPECIES_COLLIDER[species].radius * scale, top: 10 + SPECIES_COLLIDER[species].height * scale, species });
    expect(treePerch(tree(Species.Cactus, 2))).toBeNull();
    expect(treePerch(tree(Species.Shrub, 2))).toBeNull();
    expect(treePerch(tree(Species.Oak, 0.9))).toBeNull(); // too small
    let picked = 0;
    for (let i = 0; i < 400; i++) if (treePerch(tree(Species.Oak, 1.3, i * 37, i * 53))) picked++;
    expect(picked).toBeGreaterThan(400 * LANDING.treeShare * 0.5);
    expect(picked).toBeLessThan(400 * LANDING.treeShare * 1.6);
    const rock = treePerch(tree(Species.Rock, 1.5))!;
    expect(rock).not.toBeNull();
    expect(rock.kind).toBe('rock');
    expect(rock.y).toBeCloseTo(10 + SPECIES_COLLIDER[Species.Rock].height * 1.5 - 0.1, 5);
    expect(treePerch(tree(Species.Rock, 1.0))).toBeNull();
  });
  it('captures only a slow, level or descending pass within reach, from above', () => {
    const p = { id: 'x', kind: 'rock' as const, x: 0, y: 20, z: 0, name: 'a boulder' };
    const base = { x: 3, y: 22, z: 2, speed: 20, vy: -3, boosting: false };
    expect(canCapture(base, p)).toBe(true);
    expect(canCapture({ ...base, speed: 30 }, p)).toBe(false);
    expect(canCapture({ ...base, vy: -20 }, p)).toBe(false);
    expect(canCapture({ ...base, boosting: true }, p)).toBe(false);
    expect(canCapture({ ...base, x: 9 }, p)).toBe(false);
    expect(canCapture({ ...base, y: 17 }, p)).toBe(false); // from below
    expect(canCapture({ ...base, y: 27 }, p)).toBe(false); // too high above
  });
  it('lands with an ease-out glide and a flare that settles as the feet touch', () => {
    expect(landingProgress(0)).toBe(0);
    expect(landingProgress(1)).toBe(1);
    expect(landingProgress(0.5)).toBeGreaterThan(0.8);
    expect(landingFlare(0)).toBeCloseTo(0, 6);
    expect(landingFlare(0.45)).toBeGreaterThan(0.95);
    expect(landingFlare(1)).toBeCloseTo(0, 6);
  });
  it('offers the nearest perch roughly ahead, preferring landmarks, and lists tree perches from the terrain', () => {
    const lm = landmarks[0], lp = landmarkPerch(lm, gen.seed, heightAt)!;
    const trees: TreeLike[] = [
      { x: lp.x + 40, y: lp.y - 20, z: lp.z, radius: SPECIES_COLLIDER[Species.Oak].radius * 1.4, top: lp.y - 8, species: Species.Oak },
      { x: lp.x - 200, y: lp.y - 20, z: lp.z, radius: SPECIES_COLLIDER[Species.Rock].radius * 1.6, top: lp.y - 15, species: Species.Rock },
    ];
    const finder = new PerchFinder(landmarks, gen.seed, { heightAt, forEachTreeNear: (x, z, r, cb) => { for (const t of trees) if (Math.hypot(t.x - x, t.z - z) <= r) if (cb(t) === true) return; } });
    expect(finder.landmarkPoints.length).toBe(landmarks.length);
    const near = finder.near(lp.x, lp.z, 260);
    expect(near.some((p) => p.id === lp.id)).toBe(true);
    expect(near.some((p) => p.kind === 'rock')).toBe(true);
    // Flying toward +x from 120 m west of the landmark perch: the landmark ahead wins over the boulder behind.
    const best = finder.best(lp.x - 120, lp.y + 10, lp.z, 1, 0)!;
    expect(best.id).toBe(lp.id);
    // Flying away from everything: nothing ahead.
    expect(finder.best(lp.x + 300, lp.y, lp.z, 1, 0)).toBeNull();
  });
});
