import { describe, expect, it } from 'vitest';
import { Airflow, WIND_DIR } from '../src/flight/Airflow';
import { FlightController, createFlightState, emptyInput } from '../src/flight/FlightController';
import { WorldGen } from '../src/world/WorldGen';

const gen = new WorldGen(1207);
const air = new Airflow(gen);

describe('rising air', () => {
  it('has thermals over open ground near the opening position, only while the sun is up', () => {
    const list = air.thermalsNear(-4710, 7117, 2500);
    expect(list.length).toBeGreaterThan(3);
    for (const t of list) { expect(t.top - t.base).toBeGreaterThan(400); expect(t.radius).toBeGreaterThanOrEqual(60); expect(t.strength).toBeGreaterThan(2); }
    expect(Airflow.daylightFactor(0.5)).toBe(1);
    expect(Airflow.daylightFactor(0.1)).toBe(0);
    // Deterministic per seed.
    expect(new Airflow(new WorldGen(1207)).thermalsNear(-4710, 7117, 2500)).toEqual(list);
  });
  it('lifts inside a thermal core at midday, not at its edge, not at night, and never above its top', () => {
    const t = air.thermalsNear(-4710, 7117, 2500)[0];
    const mid = t.base + 200;
    expect(air.lift(t.x, mid, t.z, 0.5).thermal).toBeGreaterThan(t.strength * 0.9);
    expect(air.lift(t.x + t.radius * 0.99, mid, t.z, 0.5).thermal).toBeLessThan(0.01);
    expect(air.lift(t.x, mid, t.z, 0.05).thermal).toBe(0);
    expect(air.lift(t.x, t.top + 20, t.z, 0.5).thermal).toBeLessThan(0.01);
  });
  it('fades out at the top of a thermal that stands on high ground (top is absolute, the profile is relative)', () => {
    // Regression: the fade-out compared the height above the base with the absolute top altitude, so a
    // thermal with a high base kept lifting far above its top. Inject a column on 800 m ground.
    const high = new Airflow(gen);
    const cell = { x: 700 * 1000.5, z: 700 * 1000.5, radius: 100, base: 800, top: 1400, strength: 4 };
    (high as unknown as { cache: Map<string, typeof cell> }).cache.set('1000,1000', cell);
    expect(high.lift(cell.x, cell.base + 300, cell.z, 0.5).thermal).toBeGreaterThan(3.5);
    expect(high.lift(cell.x, cell.top - 250, cell.z, 0.5).thermal).toBeGreaterThan(3);
    expect(high.lift(cell.x, cell.top - 50, cell.z, 0.5).thermal).toBeLessThan(cell.strength * 0.5);
    expect(high.lift(cell.x, cell.top + 20, cell.z, 0.5).thermal).toBeLessThan(0.01);
    expect(high.lift(cell.x, cell.top + 500, cell.z, 0.5).thermal).toBe(0);
  });
  it('gives ridge lift low over a slope that faces the wind and none on the lee side', () => {
    // Search the range for a clear upwind slope and its mirror.
    let best: { x: number; z: number; up: number } | null = null;
    for (let z = 2000; z <= 6000; z += 60) for (let x = -5000; x <= -1000; x += 60) {
      const gx = (gen.heightAt(x + 8, z) - gen.heightAt(x - 8, z)) / 16, gz = (gen.heightAt(x, z + 8) - gen.heightAt(x, z - 8)) / 16;
      const up = gx * WIND_DIR.x + gz * WIND_DIR.z;
      if (gen.heightAt(x, z) > 50 && (!best || up > best.up)) best = { x, z, up };
    }
    expect(best!.up).toBeGreaterThan(0.3);
    const ground = gen.heightAt(best!.x, best!.z);
    expect(air.lift(best!.x, ground + 30, best!.z, 0.5).ridge).toBeGreaterThan(1);
    expect(air.lift(best!.x, ground + 400, best!.z, 0.5).ridge).toBe(0);
  });
  it('carries the bird: a glide in constant lift ends higher than the same glide in still air', () => {
    const glide = (lift: number) => {
      const c = new FlightController({ heightAt: () => 0, forEachObstacleNear: () => {} }, createFlightState());
      c.state.y = 300;
      c.airflow = () => lift;
      for (let i = 0; i < 600; i++) c.step(emptyInput());
      return c.state.y;
    };
    const still = glide(0), rising = glide(3);
    expect(rising - still).toBeGreaterThan(25); // 10 s at 3 m/s
    expect(still).toBeLessThan(300); // still air: gentle sink
  });
});
