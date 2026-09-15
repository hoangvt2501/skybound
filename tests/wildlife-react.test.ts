import { describe, expect, it } from 'vitest';
import { SEA_LEVEL } from '../src/core/config';
import { Wildlife } from '../src/world/Wildlife';
import { WorldGen } from '../src/world/WorldGen';

const gen = new WorldGen(1207);
const wildlife = new Wildlife(gen, (x, z) => Math.max(gen.heightAt(x, z), SEA_LEVEL));
type Encounter = Parameters<Wildlife['planReaction']>[0];

/** First point in a grid search satisfying a predicate. */
function find(pred: (x: number, z: number, h: number) => boolean): { x: number; z: number; h: number } {
  for (let z = 6000; z <= 9000; z += 40) for (let x = -6500; x <= -3000; x += 40) { const h = gen.heightAt(x, z); if (pred(x, z, h)) return { x, z, h }; }
  throw new Error('no spot');
}

describe('wildlife reactions', () => {
  it('sends deer away from the player over land close to their own height', () => {
    const spot = find((x, z, h) => h > 3 && h < 60 && gen.slopeAt(x, z) < 0.12 && [0, 0.7, -0.7, 1.4, -1.4, Math.PI].every((a) => gen.heightAt(x + Math.cos(a) * 22, z + Math.sin(a) * 22) > 1.5));
    const e: Encounter = { kind: 'deer', x: spot.x, z: spot.z, y: spot.h, phase: 0.3, count: 2, radius: 0 };
    const r = wildlife.planReaction(e, spot.x - 30, spot.z, 10)!;
    expect(r).not.toBeNull();
    expect(r.mode).toBe(2);
    expect(r.dist).toBe(22);
    // Roughly away from the player (positive x), and the end point is land near the start height.
    expect(r.dirX).toBeGreaterThan(0.5);
    const endH = gen.heightAt(e.x + r.dirX * r.dist, e.z + r.dirZ * r.dist);
    expect(endH).toBeGreaterThan(1.5);
    expect(Math.abs(endH - e.y)).toBeLessThan(4);
    expect(r.dh).toBeCloseTo(endH - e.y, 5);
    expect(r.until).toBe(10 + 3 + 6);
  });
  it('keeps ducks on the water and gives up on the shore', () => {
    const pond = find((x, z, h) => h < -2 && [0, 0.7, -0.7].every((a) => gen.heightAt(x + Math.cos(a) * 9, z + Math.sin(a) * 9) < -0.5));
    const duck: Encounter = { kind: 'duck', x: pond.x, z: pond.z, y: pond.h, phase: 1, count: 3, radius: 3 };
    const r = wildlife.planReaction(duck, pond.x - 20, pond.z, 5)!;
    expect(r.mode).toBe(3);
    expect(gen.heightAt(duck.x + r.dirX * r.dist, duck.z + r.dirZ * r.dist)).toBeLessThan(-0.5);
    // A duck placed on dry land has nowhere wet to go.
    const dry = find((x, z, h) => h > 8 && [0, 0.7, -0.7, 1.4, -1.4, Math.PI].every((a) => gen.heightAt(x + Math.cos(a) * 9, z + Math.sin(a) * 9) > 2));
    expect(wildlife.planReaction({ kind: 'duck', x: dry.x, z: dry.z, y: dry.h, phase: 0, count: 3, radius: 3 }, dry.x - 20, dry.z, 5)).toBeNull();
  });
  it('lets a flock scatter in place with no permanent displacement', () => {
    const r = wildlife.planReaction({ kind: 'bird', x: 0, z: 0, y: 200, phase: 0, count: 5, radius: 80 }, 10, 10, 2)!;
    expect(r.mode).toBe(1);
    expect(r.dist).toBe(0);
    expect(r.until).toBeCloseTo(5.2, 5);
  });
});
