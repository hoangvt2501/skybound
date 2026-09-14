/**
 * Automatic flight. Produces FlightInput for the same controller the player
 * uses, so it obeys the same movement and collision rules. Without a waypoint
 * it wanders; with one it steers toward it and circles on arrival. Terrain and
 * obstacle look-ahead along the projected arc keeps it above ground.
 */
import { AUTOPILOT, FLIGHT, SEA_LEVEL } from '../core/config';
import { bearingTo, headingToDir, wrapAngle } from '../world/coords';
import type { FlightInput, FlightState, TerrainQuery } from './FlightController';

export type AutopilotStatus = 'exploring' | 'enroute' | 'climbing' | 'arrived' | 'loitering' | 'blocked';

export interface AutopilotTarget {
  x: number;
  z: number;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export class Autopilot {
  enabled = false;
  status: AutopilotStatus = 'exploring';
  target: AutopilotTarget | null = null;
  private terrain: TerrainQuery;
  private wanderHeading = 0;
  private wanderTimer = 0;
  private loiterDir = 1;
  private lastAvoidTurn = 0;
  private blockedTimer = 0;
  private seedPhase: number;

  constructor(terrain: TerrainQuery, seedPhase = 0) {
    this.terrain = terrain;
    this.seedPhase = seedPhase;
  }

  setTerrain(t: TerrainQuery): void {
    this.terrain = t;
  }

  /** Highest terrain/obstacle top along the projected arc for `dist` meters. */
  private terrainAhead(s: FlightState, dist: number, turnRate: number, step: number): number {
    let px = s.x, pz = s.z, h = -1e9;
    let heading = s.heading;
    const speed = Math.max(s.speed, 20);
    for (let d = 0; d <= dist; d += step) {
      if (d > 0) {
        heading += (turnRate * step) / speed;
        const dir = headingToDir(heading);
        px += dir.x * step;
        pz += dir.z * step;
      }
      let g = Math.max(this.terrain.heightAt(px, pz), SEA_LEVEL);
      this.terrain.forEachObstacleNear(px, pz, 24, (o) => {
        if (o.top > g) g = o.top;
      });
      if (g > h) h = g;
    }
    return h;
  }

  /** Altitude needed now to clear terrain further out at a conservative climb rate. */
  private climbAhead(s: FlightState, dist: number, turnRate: number): number {
    let px = s.x, pz = s.z, need = -1e9;
    let heading = s.heading;
    const speed = Math.max(s.speed, 20);
    const climbRate = Math.sin(FLIGHT.maxPitch * 0.7) * FLIGHT.cruiseSpeed * 0.75;
    const step = 80;
    for (let d = step; d <= dist; d += step) {
      heading += (turnRate * step) / speed;
      const dir = headingToDir(heading);
      px += dir.x * step;
      pz += dir.z * step;
      const g = Math.max(this.terrain.heightAt(px, pz), SEA_LEVEL);
      need = Math.max(need, g + AUTOPILOT.minAboveGround + 15 - (d / speed) * climbRate);
    }
    return need;
  }

  /** Terrain height ahead along a fixed bearing (for choosing a way around). */
  private probe(s: FlightState, bearing: number, dist: number): number {
    const dir = headingToDir(bearing);
    let h = -1e9;
    for (let d = 60; d <= dist; d += 60) {
      const g = Math.max(this.terrain.heightAt(s.x + dir.x * d, s.z + dir.z * d), SEA_LEVEL);
      if (g > h) h = g;
    }
    return h;
  }

  update(dt: number, s: FlightState, out: FlightInput): AutopilotStatus {
    // Desired heading.
    let desiredHeading: number;
    let distToTarget = Infinity;
    if (this.target) {
      distToTarget = Math.hypot(this.target.x - s.x, this.target.z - s.z);
      const bearing = bearingTo(s.x, s.z, this.target.x, this.target.z);
      if (distToTarget < AUTOPILOT.arriveRadius) {
        this.status = 'arrived';
      }
      if (this.status === 'arrived' || this.status === 'loitering') {
        // Circle around the target at loiter radius.
        const tangent = bearing + (this.loiterDir * Math.PI) / 2;
        const radial = distToTarget - AUTOPILOT.loiterRadius;
        desiredHeading = wrapAngle(tangent + clamp(radial / AUTOPILOT.loiterRadius, -0.8, 0.8) * this.loiterDir * -1);
        if (distToTarget > AUTOPILOT.loiterRadius * 2.5) this.status = 'enroute';
        else if (this.status === 'arrived' && distToTarget > AUTOPILOT.arriveRadius) this.status = 'loitering';
      } else {
        this.status = 'enroute';
        desiredHeading = bearing;
      }
    } else {
      // Wander: slow drifting heading with periodic new goals.
      this.wanderTimer -= dt;
      if (this.wanderTimer <= 0) {
        this.wanderTimer = AUTOPILOT.wanderPeriod * (0.6 + 0.8 * Math.abs(Math.sin(s.time * 0.37 + this.seedPhase)));
        this.wanderHeading = wrapAngle(s.heading + (Math.sin(s.time * 1.7 + this.seedPhase) * 1.2));
      }
      desiredHeading = this.wanderHeading + 0.25 * Math.sin(s.time * 0.11 + this.seedPhase);
      this.status = 'exploring';
    }

    // Terrain handling. Near clearance is an emergency: turn toward the lower
    // side. A far wall that cannot be out-climbed on the direct path is met by
    // spiralling upward until the climb envelope allows the crossing.
    const ahead = this.terrainAhead(s, AUTOPILOT.lookAheadNear, 0, 30);
    const wall = this.climbAhead(s, AUTOPILOT.lookAheadFar, 0);
    const clearance = s.y - ahead;
    let climbing = false;
    if (clearance < AUTOPILOT.minAboveGround * 1.5) {
      const left = this.probe(s, s.heading - 0.7, 700);
      const right = this.probe(s, s.heading + 0.7, 700);
      const avoid = left < right ? -1 : 1;
      this.lastAvoidTurn += (avoid - this.lastAvoidTurn) * Math.min(1, dt * 2);
      desiredHeading = wrapAngle(s.heading + this.lastAvoidTurn * 0.9);
      this.blockedTimer = Math.max(0, this.blockedTimer - dt);
    } else if (wall > s.y + 100) {
      climbing = true;
      desiredHeading = wrapAngle(s.heading + 0.8 * this.loiterDir);
      // Only count as blocked when we are already near the ceiling.
      if (s.y > FLIGHT.maxAltitude - 250) this.blockedTimer += dt;
      else this.blockedTimer = Math.max(0, this.blockedTimer - dt);
    } else {
      this.lastAvoidTurn *= Math.exp(-dt * 1.5);
      this.blockedTimer = Math.max(0, this.blockedTimer - dt * 0.5);
    }
    if (this.blockedTimer > 4) {
      this.status = 'blocked';
      desiredHeading = wrapAngle(s.heading + 0.9 * this.loiterDir);
    } else if (climbing && this.target && this.status === 'enroute') {
      this.status = 'climbing';
    }

    // Turn input toward the desired heading.
    const dh = wrapAngle(desiredHeading - s.heading);
    out.turn = clamp(dh * AUTOPILOT.turnGain, -AUTOPILOT.maxTurnInput, AUTOPILOT.maxTurnInput);

    // Altitude: cruise above ground ahead along the current arc, and never
    // below what the far wall needs; cap only above that so plains flights
    // do not drift into the stratosphere.
    const turnRate = out.turn * FLIGHT.maxTurnRate;
    const aheadArc = this.terrainAhead(s, AUTOPILOT.lookAheadNear, turnRate, 40);
    const wallArc = Math.max(wall, this.climbAhead(s, AUTOPILOT.lookAheadFar, turnRate));
    let targetAlt = Math.max(aheadArc + AUTOPILOT.cruiseAboveGround, SEA_LEVEL + 45, wallArc + (climbing ? 60 : 10));
    targetAlt = Math.min(targetAlt, Math.max(aheadArc + 260, wallArc + 60, 140), FLIGHT.maxAltitude - 120);
    const dAlt = targetAlt - s.y;
    out.pitch = clamp(dAlt / 60, -0.55, 0.85);
    // Flap when a climb is needed, boost when far below the wall.
    out.flap = dAlt > 25 || s.speed < FLIGHT.cruiseSpeed * 0.8;
    out.boost = dAlt > 120 && s.boost > 40;
    out.brake = 0;
    return this.status;
  }
}
