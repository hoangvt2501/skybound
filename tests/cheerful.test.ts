import { describe, expect, it } from 'vitest';
const at = (x: number, y: number, z: number) => ({ x, y, z, vx: 0, vy: 0, vz: 0, boosting: false });
import { BIRD_SPECIES, type BirdSpecies } from '../src/flight/BirdSpecies';
import { DEFAULT_PROFILE, FlightController, createFlightState, emptyInput, tuneFlight } from '../src/flight/FlightController';
import { FLIGHT } from '../src/core/config';
import { MUSIC_STYLES, isMusicStyle } from '../src/atmosphere/Music';
import { defaultSettings, validateSettings } from '../src/persistence/Settings';
import { WorldGen, createTerrainSample } from '../src/world/WorldGen';
import { Species, SPECIES_COLLIDER, SPECIES_COUNT } from '../src/world/biomes';
import { buildGroundCover } from '../src/world/chunkMesh';
import { IMPOSTOR_SIZE, IMPOSTOR_TILES } from '../src/world/Vegetation';
import { Wildlife, wildlifeBudget } from '../src/world/Wildlife';

const flatTerrain = { heightAt: () => 0, forEachObstacleNear: () => {} };

describe('bird species profiles', () => {
  it('keeps every species within a modest band of the reference bird and lists 1-5 trait dots', () => {
    for (const id of Object.keys(BIRD_SPECIES) as BirdSpecies[]) {
      const b = BIRD_SPECIES[id];
      for (const v of Object.values(b.profile)) expect(v).toBeGreaterThanOrEqual(0.8), expect(v).toBeLessThanOrEqual(1.4);
      for (const v of Object.values(b.traits)) expect(Number.isInteger(v) && v >= 1 && v <= 5).toBe(true);
      expect(b.blurb).toHaveLength(2);
    }
    expect(tuneFlight(DEFAULT_PROFILE)).toEqual({ ...FLIGHT });
    const owl = tuneFlight(BIRD_SPECIES.owl.profile);
    expect(owl.cruiseSpeed).toBeCloseTo(FLIGHT.cruiseSpeed * 0.86, 6);
    expect(owl.maxTurnRate).toBeGreaterThan(FLIGHT.maxTurnRate);
  });
  it('makes the swallow turn faster and the eagle glide flatter than the reference bird', () => {
    const settle = (id: BirdSpecies) => {
      const c = new FlightController(flatTerrain, createFlightState());
      c.setProfile(BIRD_SPECIES[id].profile);
      const input = { ...emptyInput(), turn: 1 };
      let turned = 0, last = c.state.heading;
      for (let i = 0; i < 240; i++) { c.step(input); const d = c.state.heading - last; turned += i >= 180 ? Math.abs(((d + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI) : 0; last = c.state.heading; }
      const turnRate = turned; // radians over the last second
      const g = new FlightController(flatTerrain, createFlightState());
      g.setProfile(BIRD_SPECIES[id].profile);
      for (let i = 0; i < 300; i++) g.step(emptyInput());
      return { turnRate, glidePitch: g.state.pitch, speed: c.state.speed };
    };
    const eagle = settle('eagle'), swallow = settle('swallow'), gull = settle('gull');
    expect(swallow.turnRate).toBeGreaterThan(eagle.turnRate * 1.2);
    expect(Math.abs(eagle.glidePitch)).toBeLessThan(Math.abs(swallow.glidePitch));
    expect(gull.speed).toBeGreaterThan(eagle.speed);
  });
});

describe('music styles and settings', () => {
  it('exposes five styles, validates the setting and previews are opt-in by style change', () => {
    expect(MUSIC_STYLES.map(s => s.id)).toEqual(['sunny', 'waltz', 'island', 'calm', 'off']);
    expect(isMusicStyle('waltz')).toBe(true); expect(isMusicStyle('techno')).toBe(false);
    expect(defaultSettings().musicStyle).toBe('sunny');
    expect(validateSettings({ musicStyle: 'island', skyMoods: false })).toMatchObject({ musicStyle: 'island', skyMoods: false });
    expect(validateSettings({}).skyMoods).toBe(true);
  });
});

describe('scenery', () => {
  const gen = new WorldGen(1207);
  it('registers boulders as a ninth species with a collider and an impostor tile', () => {
    expect(SPECIES_COUNT).toBe(9); expect(Species.Rock).toBe(8);
    expect(SPECIES_COLLIDER).toHaveLength(9); expect(IMPOSTOR_SIZE).toHaveLength(IMPOSTOR_TILES); expect(IMPOSTOR_TILES).toBe(9);
    // A forested alpine slope below the spine (seed 1207) now yields boulders among the pines.
    const sample = createTerrainSample(), choice = { density: 0, species: Species.Oak };
    let rocks = 0, trees = 0;
    for (let k = 0; k < 400; k++) {
      const x = -4186 + (k % 20) * 30 - 300, z = 2679 + Math.floor(k / 20) * 30 - 300; // alpine slope west of the mist valley
      const s = gen.sample(x, z, sample);
      gen.vegetationAt(s, gen.slopeAt(x, z), (k * 0.618) % 1, choice, x, z);
      if (choice.density > 0.2) { if (choice.species === Species.Rock) rocks++; else trees++; }
    }
    expect(rocks).toBeGreaterThan(5); expect(trees).toBeGreaterThan(rocks);
  });
  it('carves the mist valley: a low meadow floor with a lake between high walls, opening toward the wetland', () => {
    const path = gen.valleyPath(10);
    const mouth = path[0], head = path[10], mid = path[5];
    expect(Math.hypot(head.x - mouth.x, head.z - mouth.z)).toBeGreaterThan(1500);
    // Floor: low near the mouth, rising toward the head; lake in the lower third.
    expect(gen.heightAt(path[1].x, path[1].z)).toBeLessThan(20);
    expect(gen.heightAt(path[3].x, path[3].z)).toBeLessThan(0); // the lake
    expect(gen.heightAt(path[8].x, path[8].z)).toBeGreaterThan(40);
    // Walls: 1 km either side of the mid point stands far above the floor.
    const ax = head.x - mouth.x, az = head.z - mouth.z, l = Math.hypot(ax, az), nx = -az / l, nz = ax / l;
    const floor = gen.heightAt(mid.x, mid.z);
    for (const side of [-1, 1]) expect(gen.heightAt(mid.x + nx * 1000 * side, mid.z + nz * 1000 * side)).toBeGreaterThan(floor + 250);
    expect(gen.valleyAt(mid.x, mid.z).mask).toBeGreaterThan(0.95);
    expect(gen.valleyAt(mid.x + nx * 1200, mid.z + nz * 1200).mask).toBe(0);
    // Deterministic per seed and part of the same layout: identical across instances.
    const other = new WorldGen(1207);
    expect(other.valleyPath(4)).toEqual(gen.valleyPath(4));
  });
  it('places wildflower kinds inside meadow patches only', () => {
    // A chunk over the meadow patch found near the opening position vs. a wetland chunk.
    const meadow = buildGroundCover(gen, Math.floor(-3750 / 512), Math.floor(6397 / 512), 1);
    const kinds = new Map<number, number>();
    for (let i = 5; i < meadow.length; i += 6) kinds.set(meadow[i], (kinds.get(meadow[i]) ?? 0) + 1);
    const flowers = (kinds.get(4) ?? 0) + (kinds.get(5) ?? 0) + (kinds.get(6) ?? 0);
    expect(flowers).toBeGreaterThan(50);
    expect(gen.flowerPatch(-3750, 6397)).toBeGreaterThan(0.85);
    for (let i = 5; i < meadow.length; i += 6) expect(meadow[i]).toBeLessThanOrEqual(6);
  });
  it('adds balloons over gentle land and sailboats on open water within the budget', () => {
    const budget = wildlifeBudget('lively', 'high');
    expect(budget).toMatchObject({ balloons: 3, boats: 5 });
    expect(wildlifeBudget('off', 'high')).toEqual({ birds: 0, deer: 0, ducks: 0, balloons: 0, boats: 0, fish: 0 });
    const world = new Wildlife(gen, (x, z) => Math.max(0, gen.heightAt(x, z)));
    for (let i = 0; i < 140; i++) world.update(i / 60, at(-4710, 200, 7117), 0, 0, 'lively', 'high');
    expect(world.counts().balloons).toBeGreaterThan(0);
    // Open sea north of the wetland coast.
    for (let i = 0; i < 140; i++) world.update(10 + i / 60, at(-6585, 60, 12523), 0, 0, 'lively', 'high');
    const sea = world.counts();
    expect(sea.boats).toBeGreaterThan(0); expect(sea.boats).toBeLessThanOrEqual(budget.boats);
    expect(sea.fish).toBeGreaterThan(0); expect(sea.fish).toBeLessThanOrEqual(budget.fish);
    world.dispose();
  });
});
