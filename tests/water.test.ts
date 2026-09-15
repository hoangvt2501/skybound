import { describe, expect, it } from 'vitest';
import { FlightController, createFlightState, emptyInput } from '../src/flight/FlightController';
import { FLIGHT, SEA_LEVEL } from '../src/core/config';

/** Flat sea everywhere: seabed 20 m below the surface. */
const sea = { heightAt: () => SEA_LEVEL - 20, forEachObstacleNear: () => {} };
const hardGround = { heightAt: () => 0, forEachObstacleNear: () => {} };

function dive(terrain: typeof sea, pitchInput: number, startY = 22) {
  const s = createFlightState(); s.y = startY; s.speed = FLIGHT.cruiseSpeed;
  const c = new FlightController(terrain, s);
  const events: string[] = []; let entrySpeed = 0, steepness = 0;
  c.onWater = (event, speed, steep) => { events.push(event); if (event === 'enter') { entrySpeed = speed; steepness = steep; } };
  c.onImpact = (_speed, kind) => events.push('impact:' + kind);
  let minY = Infinity, wetSteps = 0, exitSpeed = 0;
  for (let i = 0; i < 600; i++) {
    c.step({ ...emptyInput(), pitch: i < 240 ? pitchInput : 0.5 }); // dive for 4 s, then pull up
    minY = Math.min(minY, c.state.y);
    if (c.state.onWater) wetSteps++;
    if (events.at(-1) === 'exit' && !exitSpeed) exitSpeed = c.state.speed;
  }
  return { events, entrySpeed, steepness, minY, wetSteps, state: c.state, exitSpeed };
}

describe('water contact', () => {
  it('is not a wall: a shallow dive skims the surface, sheds speed gradually and climbs out', () => {
    const r = dive(sea, -0.35);
    expect(r.events[0]).toBe('enter');
    expect(r.events).toContain('exit');
    expect(r.events).not.toContain('impact:water');
    expect(r.minY).toBeGreaterThan(SEA_LEVEL - 2.2);
    expect(r.minY).toBeLessThan(SEA_LEVEL + FLIGHT.groundClearance); // it really touched the water
    expect(r.wetSteps).toBeGreaterThan(5);
    expect(r.exitSpeed).toBeGreaterThan(FLIGHT.minSpeed * 0.6);
    expect(r.state.y).toBeGreaterThan(SEA_LEVEL + 2); // airborne again after pulling up
    expect(r.state.wet).toBeLessThan(1); // dripping dries off
  });
  it('plunges deeper and loses more speed on a steep entry, but never below the seabed', () => {
    const shallow = dive(sea, -0.3), steep = dive(sea, -1);
    expect(steep.steepness).toBeGreaterThan(shallow.steepness);
    expect(steep.minY).toBeLessThan(shallow.minY);
    expect(steep.minY).toBeGreaterThan(SEA_LEVEL - 20 + FLIGHT.groundClearance - 1e-6);
    // Speed right after entry: the steep entry keeps less of it.
    const speedAfter = (pitch: number) => { const s = createFlightState(); s.y = 30; const c = new FlightController(sea, s); let entered = false, after = 0; c.onWater = (e) => { if (e === 'enter') entered = true; }; for (let i = 0; i < 300 && !after; i++) { c.step({ ...emptyInput(), pitch }); if (entered) after = c.state.speed; } return after; };
    expect(speedAfter(-1)).toBeLessThan(speedAfter(-0.3));
  });
  it('still treats ground as a hard impact', () => {
    const r = dive(hardGround, -1, 22);
    expect(r.events).toContain('impact:terrain');
    expect(r.events).not.toContain('enter');
  });
});
