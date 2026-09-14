import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FixedStepClock } from '../src/core/Clock';
import { BirdModel } from '../src/flight/Bird';
import { BIRD_SPECIES, type BirdSpecies } from '../src/flight/BirdSpecies';
import { validateSettings } from '../src/persistence/Settings';
import { windLevel } from '../src/atmosphere/Audio';
import { habitatAt, wildlifeBudget, Wildlife } from '../src/world/Wildlife';
import { Biome } from '../src/world/biomes';
import { WorldGen, createTerrainSample } from '../src/world/WorldGen';
import { buildChunkMesh, sampleHeightGrid, WATER_SEGMENTS } from '../src/world/chunkMesh';
import { disposeInstanceGeometry } from '../src/world/ChunkManager';

describe('smooth render sampling', () => {
  for (const hz of [30, 60, 144]) it(`has continuous movement at ${hz} Hz, including zero-step and catch-up frames`, () => {
    const clock = new FixedStepClock();
    let current = 0, previous = 0, lastRender = 0, elapsed = 0;
    for (let i = 0; i < hz * 3; i++) {
      const dt = 1 / hz; elapsed += dt;
      clock.run(dt, () => { previous = current; }, () => { current += 12 * clock.step; });
      const rendered = previous + (current - previous) * clock.alpha;
      expect(rendered).toBeGreaterThanOrEqual(lastRender - 1e-8);
      if (elapsed >= clock.step * 2) expect(rendered).toBeCloseTo((elapsed - clock.step) * 12, 7);
      lastRender = rendered;
    }
  });
});

describe('water worker payload', () => {
  it('matches rendered triangle depth and world exposure at grid samples', () => {
    const gen = new WorldGen(1207), sample = createTerrainSample();
    const chunk = buildChunkMesh(gen, 40, 40, 3);
    expect(chunk.hasWater).toBe(true);
    expect(chunk.waterDepth.length).toBe((WATER_SEGMENTS + 1) ** 2);
    for (const i of [0, 7, 24, 48]) for (const j of [0, 19, 48]) {
      const x = i * 512 / WATER_SEGMENTS, z = j * 512 / WATER_SEGMENTS, k = j * (WATER_SEGMENTS + 1) + i;
      expect(chunk.waterDepth[k]).toBeCloseTo(sampleHeightGrid(chunk.heights, chunk.segments, chunk.spacing, x, z), 4);
      const land = gen.sample(40 * 512 + x, 40 * 512 + z, sample).land;
      expect(chunk.waterExposure[k]).toBeCloseTo(Math.max(0, Math.min(1, (0.75 - land) * 2.5)), 6);
    }
  });
  it('does not delete borrowed vertex buffers when one instanced chunk is evicted', () => {
    const shared = new THREE.BoxGeometry(), instance = new THREE.BufferGeometry();
    instance.setAttribute('position', shared.attributes.position); instance.setIndex(shared.index);
    const rand = new THREE.InstancedBufferAttribute(new Float32Array(3), 1);
    instance.setAttribute('aRand', rand);
    let seen = false;
    instance.addEventListener('dispose', () => {
      seen = true;
      expect(instance.attributes.position).toBeUndefined();
      expect(instance.index).toBeNull();
      expect(instance.attributes.aRand).toBe(rand);
    });
    disposeInstanceGeometry(instance);
    expect(seen).toBe(true); expect(shared.attributes.position.count).toBeGreaterThan(0); shared.dispose();
  });
});

describe('bird and sound preferences', () => {
  it('migrates missing options and validates untrusted saved preferences', () => {
    const settings = validateSettings({ quality: 'medium', volume: 0.4, birdSpecies: '__proto__', wildlife: 'unlimited', musicVolume: NaN, ambienceVolume: 12, effectsVolume: -5 });
    expect(settings.birdSpecies).toBe('eagle'); expect(settings.wildlife).toBe('subtle');
    expect(settings.musicVolume).toBe(0.35); expect(settings.ambienceVolume).toBe(1); expect(settings.effectsVolume).toBe(0); expect(settings.musicStyle).toBe('sunny');
    // Preferences saved before music existed keep the new default level; ones that know about music keep theirs.
    expect(validateSettings({ birdSpecies: 'swallow', wildlife: 'off', musicVolume: 0 }).musicVolume).toBe(0.35);
    expect(validateSettings({ musicStyle: 'waltz', musicVolume: 0 })).toMatchObject({ musicStyle: 'waltz', musicVolume: 0 });
    expect(validateSettings({ musicStyle: 'polka' }).musicStyle).toBe('sunny');
  });
  it('builds distinct silhouettes with finite animation transforms for every selectable species', () => {
    const spans = new Set<number>();
    for (const species of Object.keys(BIRD_SPECIES) as BirdSpecies[]) {
      const model = new BirdModel(species);
      spans.add(model.wingspan);
      model.update(0.1, { flap: 1, beatRate: 1, pitchInput: 1, turnInput: -1, speed: 70, brake: 0 });
      model.group.updateMatrixWorld(true);
      model.group.traverse(o => expect(o.matrixWorld.elements.every(Number.isFinite)).toBe(true));
      expect(model.species).toBe(species); model.dispose();
    }
    expect(spans.size).toBe(4);
  });
  it('caps even boosted wind rather than drowning out the ambient mix', () => {
    for (const speed of [0, 34, 58, 82, 1000]) expect(windLevel(speed, true)).toBeLessThanOrEqual(0.174);
    expect(windLevel(82, true)).toBeGreaterThan(windLevel(34, false));
  });
});

describe('bounded ambient wildlife', () => {
  it('rejects unsuitable land and water habitats', () => {
    expect(habitatAt(-5, 0.02, Biome.Ocean)).toBe('duck');
    expect(habitatAt(30, 0.1, Biome.Temperate)).toBe('deer');
    expect(habitatAt(30, 0.8, Biome.Temperate)).toBeNull();
    expect(habitatAt(-60, 0, Biome.Ocean)).toBeNull();
    expect(habitatAt(1100, 0, Biome.Alpine)).toBeNull();
  });
  it('shows ducks on the ponds near the showcase opening position', () => {
    // Regression: one random point per 180 m cell almost never landed on a pond,
    // so the opening wetland had no ducks within draw distance at all.
    const gen = new WorldGen(1207), world = new Wildlife(gen, (x, z) => Math.max(0, gen.heightAt(x, z)));
    const L = gen.layout, wet = gen.regionToWorld(L.wet.x, L.wet.y), spine = gen.regionToWorld(L.spine[1][0], L.spine[1][1]);
    const px = wet.x + (spine.x - wet.x) * 0.3, pz = wet.z + (spine.z - wet.z) * 0.3;
    for (let i = 0; i < 140; i++) world.update(i / 60, px, 60, pz, 0, 0, 'lively', 'high'); // one habitat per frame (49 ground + 9 flock + 25 balloon cells)
    const count = world.counts();
    expect(count.ducks).toBeGreaterThan(0); expect(count.deer).toBeGreaterThan(0); expect(count.birds).toBeGreaterThan(0);
    // Animals animate on the GPU: with the same nearby set, later frames upload no instance data at all.
    world.update(2, px, 60, pz, 0, 0, 'lively', 'high');
    const live = world.group.children.filter((o): o is THREE.InstancedMesh => o instanceof THREE.InstancedMesh && o.visible && o.count > 0);
    expect(live.length).toBeGreaterThanOrEqual(3); // birds, deer, ducks (balloons and boats depend on the spot)
    const versionsOf = (m: THREE.InstancedMesh) => [m.instanceMatrix.version, (m.geometry.attributes.aPhase as THREE.BufferAttribute).version, (m.geometry.attributes.aOrbit as THREE.BufferAttribute).version];
    const versions = live.map(versionsOf);
    for (let i = 1; i <= 30; i++) world.update(2 + i / 60, px, 60, pz, 0, 0, 'lively', 'high');
    expect(live.map(versionsOf)).toEqual(versions);
    expect(live.every(m => m.visible)).toBe(true);
    // Moving far enough selects again, into a different buffer of the ring.
    world.update(3, px + 150, 60, pz, 0, 0, 'lively', 'high');
    expect(world.group.children.filter(o => o instanceof THREE.InstancedMesh && o.visible).some(m => live.includes(m as THREE.InstancedMesh))).toBe(false);
    world.dispose();
  });
  it('keeps population bounded through travel, rebasing and the off switch', () => {
    const gen = new WorldGen(1207), world = new Wildlife(gen, (x, z) => Math.max(0, gen.heightAt(x, z)));
    for (let i = 0; i < 100; i++) {
      world.update(i / 30, i * 40, 160, i * -17, 0, 0, 'lively', 'low');
      const count = world.counts(), budget = wildlifeBudget('lively', 'low');
      expect(count.birds).toBeLessThanOrEqual(budget.birds); expect(count.deer).toBeLessThanOrEqual(budget.deer); expect(count.ducks).toBeLessThanOrEqual(budget.ducks);
    }
    world.update(4, 4000, 160, -1700, 4000, -2000, 'subtle', 'medium');
    world.group.traverse(o => { if (o instanceof THREE.InstancedMesh) expect(Array.from(o.instanceMatrix.array).every(Number.isFinite)).toBe(true); });
    world.update(4, 4000, 160, -1700, 4000, -2000, 'off', 'medium');
    expect(world.counts()).toEqual({ birds: 0, deer: 0, ducks: 0, balloons: 0, boats: 0 }); world.dispose();
  });
});
