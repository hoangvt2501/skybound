import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Origin, REBASE_DISTANCE } from '../src/world/Origin';
import { WorldGen } from '../src/world/WorldGen';
import { placeLandmarks } from '../src/world/Landmarks';
import { REGION_HALF_SIZE } from '../src/core/config';

describe('Floating origin', () => {
  it('keeps global locations stable across rebasing; only render positions shift', () => {
    const root = new THREE.Group();
    const origin = new Origin(root);
    const globalPos = new THREE.Vector3(12345.6, 100, -7890.1);
    const child = new THREE.Object3D();
    child.position.copy(globalPos);
    root.add(child);
    root.updateMatrixWorld(true);
    const before = new THREE.Vector3();
    child.getWorldPosition(before);
    expect(before.x).toBeCloseTo(globalPos.x);

    const rebased = origin.maybeRebase(globalPos.x, globalPos.z);
    expect(rebased).toBe(true);
    root.updateMatrixWorld(true);
    const after = new THREE.Vector3();
    child.getWorldPosition(after);
    // The child's global (local-to-root) position is unchanged...
    expect(child.position.x).toBeCloseTo(globalPos.x);
    expect(child.position.z).toBeCloseTo(globalPos.z);
    // ...while its render-space position is now small.
    expect(Math.abs(after.x)).toBeLessThan(1000);
    expect(Math.abs(after.z)).toBeLessThan(1000);
    const back = origin.toGlobal(after, new THREE.Vector3());
    expect(back.x).toBeCloseTo(globalPos.x, 6);
    expect(back.z).toBeCloseTo(globalPos.z, 6);
  });

  it('does not rebase for small moves and notifies listeners with the delta', () => {
    const origin = new Origin(new THREE.Group());
    let delta: [number, number] | null = null;
    origin.onRebase((dx, dz) => (delta = [dx, dz]));
    expect(origin.maybeRebase(REBASE_DISTANCE * 0.5, 0)).toBe(false);
    expect(delta).toBeNull();
    expect(origin.maybeRebase(REBASE_DISTANCE * 1.5, 0)).toBe(true);
    expect(delta).not.toBeNull();
    expect(delta![0]).toBeCloseTo(Math.round((REBASE_DISTANCE * 1.5) / 1000) * 1000);
  });
});

describe('Landmarks', () => {
  it('places at least 12 landmarks of at least 6 types deterministically inside the region, on land, with spacing', () => {
    const gen = new WorldGen(1207);
    const a = placeLandmarks(gen);
    const b = placeLandmarks(new WorldGen(1207));
    expect(a.map((l) => l.id)).toEqual(b.map((l) => l.id));
    expect(a.length).toBeGreaterThanOrEqual(12);
    expect(new Set(a.map((l) => l.type)).size).toBeGreaterThanOrEqual(6);
    for (const l of a) {
      expect(Math.abs(l.x)).toBeLessThan(REGION_HALF_SIZE);
      expect(Math.abs(l.z)).toBeLessThan(REGION_HALF_SIZE);
      expect(gen.heightAt(l.x, l.z)).toBeGreaterThan(0);
      expect(l.colliders.length).toBeGreaterThan(0);
      expect(l.name.length).toBeGreaterThan(3);
    }
    for (let i = 0; i < a.length; i++) {
      for (let j = i + 1; j < a.length; j++) {
        expect(Math.hypot(a[i].x - a[j].x, a[i].z - a[j].z)).toBeGreaterThan(1000);
      }
    }
    // eslint-disable-next-line no-console
    console.log('[landmarks]', a.map((l) => `${l.type}@(${Math.round(l.x)},${Math.round(l.z)})`).join(' '));
  });
});
