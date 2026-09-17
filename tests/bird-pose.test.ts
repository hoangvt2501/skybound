import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BirdModel } from '../src/flight/Bird';

/** World position (bird space) of the outermost primary on each wing. */
function tips(bird: BirdModel): { left: THREE.Vector3; right: THREE.Vector3 } {
  bird.group.updateMatrixWorld(true);
  const prim = (bird as any).primaries as { g: THREE.Object3D }[];
  const v = prim.map((p) => p.g.getWorldPosition(new THREE.Vector3()));
  const left = v.filter((p) => p.x < 0).reduce((a, b) => (Math.abs(b.x) > Math.abs(a.x) ? b : a));
  const right = v.filter((p) => p.x > 0).reduce((a, b) => (b.x > a.x ? b : a));
  return { left, right };
}

const glide = { flap: 0, beatRate: 1, pitchInput: 0, turnInput: 0, speed: 30, brake: 0 };

describe('bird poses', () => {
  it('spreads the wings in flight and folds them back along the flanks on a perch', () => {
    const bird = new BirdModel('eagle');
    for (let i = 0; i < 120; i++) bird.update(1 / 60, glide);
    const open = tips(bird);
    expect(open.right.x).toBeGreaterThan(bird.wingspan * 0.4);
    expect(open.left.x).toBeLessThan(-bird.wingspan * 0.4);
    expect(Math.abs(open.right.z)).toBeLessThan(0.35);
    for (let i = 0; i < 240; i++) bird.update(1 / 60, { ...glide, speed: 0, perch: 1 });
    const folded = tips(bird);
    // Tips sit close to the body, behind the shoulders, and mirror each other.
    expect(Math.abs(folded.right.x)).toBeLessThan(0.3);
    expect(Math.abs(folded.left.x)).toBeLessThan(0.3);
    expect(folded.right.z).toBeGreaterThan(0.4);
    expect(folded.left.z).toBeCloseTo(folded.right.z, 3);
    expect(folded.left.y).toBeCloseTo(folded.right.y, 3);
    expect(folded.left.x).toBeCloseTo(-folded.right.x, 3);
    // Back in the air the wings open again.
    for (let i = 0; i < 240; i++) bird.update(1 / 60, glide);
    expect(tips(bird).right.x).toBeGreaterThan(bird.wingspan * 0.4);
  });
  it('reaches the legs down for the landing flare and on the perch, tucks them in flight', () => {
    const bird = new BirdModel('gull');
    const legs = (bird as any).legs as THREE.Group[];
    for (let i = 0; i < 60; i++) bird.update(1 / 60, glide);
    expect(legs[0].rotation.x).toBeGreaterThan(1);
    for (let i = 0; i < 120; i++) bird.update(1 / 60, { ...glide, flare: 1 });
    expect(legs[0].rotation.x).toBeLessThan(0.2);
    for (let i = 0; i < 120; i++) bird.update(1 / 60, { ...glide, perch: 1 });
    expect(legs[0].rotation.x).toBeLessThan(0.05);
    expect(legs[1].rotation.x).toBeCloseTo(legs[0].rotation.x, 6);
  });
});
