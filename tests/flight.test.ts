import { describe, expect, it } from 'vitest';
import { FixedStepClock } from '../src/core/Clock';
import { FLIGHT, SEA_LEVEL, SIM_STEP } from '../src/core/config';
import { FlightController, createFlightState, emptyInput, findSafeAirborne, type FlightInput, type TerrainQuery } from '../src/flight/FlightController';
import { Autopilot } from '../src/flight/Autopilot';
import { WorldGen } from '../src/world/WorldGen';

function flatTerrain(height = 0): TerrainQuery {
  return { heightAt: () => height, forEachObstacleNear: () => {} };
}

/** Run the sim with a given sequence of frame deltas; returns final state. */
function runSchedule(frameDts: number[], inputFor: (t: number) => FlightInput, terrain: TerrainQuery) {
  const clock = new FixedStepClock();
  const ctrl = new FlightController(terrain, createFlightState());
  ctrl.state.y = 300;
  let t = 0;
  for (const dt of frameDts) {
    const steps = clock.advance(dt);
    for (let i = 0; i < steps; i++) {
      ctrl.step(inputFor(t), clock.step);
      t += clock.step;
    }
  }
  return { state: ctrl.state, simTime: clock.time, dropped: clock.dropped };
}

describe('Flight model', () => {
  it('produces identical results under different render frame schedules', () => {
    const total = 12; // seconds
    const sched60 = Array(total * 60).fill(1 / 60);
    const sched30 = Array(total * 30).fill(1 / 30);
    const irregular: number[] = [];
    let acc = 0;
    let k = 0;
    while (acc < total) {
      const dt = [0.011, 0.02, 0.033, 0.005, 0.05, 0.016][k++ % 6];
      irregular.push(Math.min(dt, total - acc));
      acc += dt;
    }
    const inputFor = (t: number): FlightInput => ({
      pitch: t < 3 ? 1 : t < 6 ? -0.5 : 0,
      turn: t > 2 && t < 8 ? 1 : 0,
      flap: t > 1 && t < 4,
      boost: t > 7 && t < 9,
      brake: 0,
    });
    const a = runSchedule(sched60, inputFor, flatTerrain());
    const b = runSchedule(sched30, inputFor, flatTerrain());
    const c = runSchedule(irregular, inputFor, flatTerrain());
    // Same number of fixed steps => identical state (bitwise for the 60/30 case).
    expect(a.simTime).toBeCloseTo(b.simTime, 6);
    expect(a.state.x).toBeCloseTo(b.state.x, 6);
    expect(a.state.y).toBeCloseTo(b.state.y, 6);
    expect(a.state.heading).toBeCloseTo(b.state.heading, 6);
    expect(a.state.speed).toBeCloseTo(b.state.speed, 6);
    // Irregular schedule may differ by at most one fixed step of motion.
    const stepDist = FLIGHT.boostMaxSpeed * SIM_STEP * 2;
    expect(Math.hypot(a.state.x - c.state.x, a.state.z - c.state.z)).toBeLessThan(stepDist);
    expect(Math.abs(a.state.y - c.state.y)).toBeLessThan(stepDist);
    expect(a.dropped).toBe(0);
  });

  it('caps catch-up after a long pause (tab resume)', () => {
    const clock = new FixedStepClock();
    const steps = clock.advance(30); // 30 seconds away
    expect(steps).toBeLessThanOrEqual(6);
    expect(clock.dropped).toBeGreaterThan(1000);
  });

  it('turns change heading, banking follows the turn, and no input glides with slow descent', () => {
    const ctrl = new FlightController(flatTerrain(), createFlightState());
    ctrl.state.y = 300;
    const input = emptyInput();
    const h0 = ctrl.state.heading;
    input.turn = 1;
    for (let i = 0; i < 120; i++) ctrl.step(input, SIM_STEP);
    expect(ctrl.state.heading).toBeGreaterThan(h0 + 0.5);
    expect(ctrl.state.roll).toBeLessThan(-0.4); // right wing down
    input.turn = 0;
    const y0 = ctrl.state.y;
    for (let i = 0; i < 300; i++) ctrl.step(input, SIM_STEP);
    expect(Math.abs(ctrl.state.roll)).toBeLessThan(0.05);
    expect(ctrl.state.y).toBeLessThan(y0); // gradual altitude loss
    expect(ctrl.state.y).toBeGreaterThan(y0 - 40);
  });

  it('climbing trades speed, diving gains speed, flap adds lift and boost drains then recovers', () => {
    const ctrl = new FlightController(flatTerrain(), createFlightState());
    ctrl.state.y = 500;
    const input = emptyInput();
    input.pitch = 1;
    for (let i = 0; i < 120; i++) ctrl.step(input, SIM_STEP);
    expect(ctrl.state.speed).toBeLessThan(FLIGHT.cruiseSpeed);
    const yTop = ctrl.state.y;
    input.pitch = -1;
    for (let i = 0; i < 120; i++) ctrl.step(input, SIM_STEP);
    expect(ctrl.state.speed).toBeGreaterThan(FLIGHT.cruiseSpeed);
    expect(ctrl.state.y).toBeLessThan(yTop);
    input.pitch = 0;
    input.flap = true;
    const yBefore = ctrl.state.y;
    for (let i = 0; i < 180; i++) ctrl.step(input, SIM_STEP);
    expect(ctrl.state.y).toBeGreaterThan(yBefore);
    input.flap = false;
    input.boost = true;
    for (let i = 0; i < 120; i++) ctrl.step(input, SIM_STEP);
    expect(ctrl.state.boost).toBeLessThan(FLIGHT.boostCapacity - 30);
    expect(ctrl.state.speed).toBeGreaterThan(FLIGHT.maxSpeed);
    input.boost = false;
    for (let i = 0; i < 600; i++) ctrl.step(input, SIM_STEP);
    expect(ctrl.state.boost).toBeGreaterThan(90);
  });

  it('never tunnels through terrain at boost speed and recovers gently', () => {
    // A vertical wall at x >= 200: height 1000 beyond it.
    const terrain: TerrainQuery = { heightAt: (x) => (x >= 200 ? 1000 : 0), forEachObstacleNear: () => {} };
    const ctrl = new FlightController(terrain, createFlightState());
    ctrl.state.heading = Math.PI / 2; // east
    ctrl.state.y = 50;
    ctrl.state.speed = FLIGHT.boostMaxSpeed;
    let impacts = 0;
    ctrl.onImpact = () => impacts++;
    const input = emptyInput();
    input.boost = true;
    for (let i = 0; i < 600; i++) {
      ctrl.step(input, SIM_STEP);
      const ground = Math.max(terrain.heightAt(ctrl.state.x, ctrl.state.z), SEA_LEVEL);
      expect(ctrl.state.y).toBeGreaterThanOrEqual(ground + FLIGHT.groundClearance - 1e-6);
    }
    expect(impacts).toBeGreaterThan(0);
    expect(impacts).toBeLessThan(60); // cooldown prevents machine-gun impacts
  });

  it('obstacle colliders push the bird out without teleporting', () => {
    const terrain: TerrainQuery = {
      heightAt: () => 0,
      forEachObstacleNear: (x, z, r, cb) => {
        if (Math.hypot(x - 100, z) < r + 10) cb({ x: 100, z: 0, radius: 10, bottom: 0, top: 200 });
      },
    };
    const ctrl = new FlightController(terrain, createFlightState());
    ctrl.state.heading = Math.PI / 2;
    ctrl.state.y = 50;
    let prev = { x: ctrl.state.x, y: ctrl.state.y, z: ctrl.state.z };
    const input = emptyInput();
    for (let i = 0; i < 300; i++) {
      ctrl.step(input, SIM_STEP);
      const jump = Math.hypot(ctrl.state.x - prev.x, ctrl.state.y - prev.y, ctrl.state.z - prev.z);
      expect(jump).toBeLessThan(FLIGHT.boostMaxSpeed * SIM_STEP + 12);
      prev = { x: ctrl.state.x, y: ctrl.state.y, z: ctrl.state.z };
      // never inside the cylinder
      expect(Math.hypot(ctrl.state.x - 100, ctrl.state.z)).toBeGreaterThan(9.5);
    }
  });

  it('recover finds a safe airborne position above terrain and obstacles', () => {
    const gen = new WorldGen(1207);
    const terrain: TerrainQuery = {
      heightAt: (x, z) => gen.heightAt(x, z),
      forEachObstacleNear: (x, z, r, cb) => {
        if (Math.hypot(x, z) < r + 5) cb({ x: 0, z: 0, radius: 5, bottom: 0, top: 500 });
      },
    };
    const p = findSafeAirborne(terrain, 0, 0, 0);
    let maxH = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) maxH = Math.max(maxH, gen.heightAt(p.x + dx * 40, p.z + dz * 40));
    expect(p.y).toBeGreaterThan(maxH + 50);
    if (Math.hypot(p.x, p.z) < 35) expect(p.y).toBeGreaterThan(500);
  });
});

describe('Autopilot', () => {
  it('stays above terrain and reaches a waypoint over the showcase world', () => {
    const gen = new WorldGen(1207);
    const terrain: TerrainQuery = { heightAt: (x, z) => gen.heightAt(x, z), forEachObstacleNear: () => {} };
    const ctrl = new FlightController(terrain, createFlightState());
    const ap = new Autopilot(terrain);
    // Start in the temperate lowlands, target 3 km away.
    ctrl.state.x = -2000; ctrl.state.z = 4000;
    ctrl.state.y = Math.max(gen.heightAt(-2000, 4000), 0) + 120;
    ap.enabled = true;
    ap.target = { x: 500, z: 2500 };
    const input = emptyInput();
    let minClearance = Infinity;
    let arrived = false;
    for (let i = 0; i < 60 * 240; i++) {
      ap.update(SIM_STEP, ctrl.state, input);
      ctrl.step(input, SIM_STEP);
      const clearance = ctrl.state.y - Math.max(gen.heightAt(ctrl.state.x, ctrl.state.z), 0);
      if (i > 120) minClearance = Math.min(minClearance, clearance);
      if (ap.status === 'arrived' || ap.status === 'loitering') { arrived = true; break; }
    }
    expect(arrived).toBe(true);
    expect(minClearance).toBeGreaterThan(8);
  });
});
