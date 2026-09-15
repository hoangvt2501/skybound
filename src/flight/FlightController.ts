/**
 * Arcade flight model with inertia, banked turns, flap, boost and swept
 * terrain/obstacle collision. Pure math (no Three.js) so it runs identically
 * in tests and in the browser. All positions are global coordinates.
 */
import { FLIGHT, SEA_LEVEL, SIM_STEP } from '../core/config';
import { headingToDir, wrapAngle } from '../world/coords';

export interface FlightInput {
  /** -1..1, positive = nose up. */
  pitch: number;
  /** -1..1, positive = turn right. */
  turn: number;
  flap: boolean;
  boost: boolean;
  /** Air brake (spread wings), 0..1. */
  brake: number;
}

export function emptyInput(): FlightInput {
  return { pitch: 0, turn: 0, flap: false, boost: false, brake: 0 };
}

export interface Obstacle {
  x: number;
  z: number;
  radius: number;
  /** Bottom and top of the collider (global y). */
  bottom: number;
  top: number;
}

/** Terrain and obstacle queries the controller needs. */
export interface TerrainQuery {
  /** Terrain height (m). */
  heightAt(x: number, z: number): number;
  /** Visit obstacles near a point; return true from the callback to stop. */
  forEachObstacleNear(x: number, z: number, radius: number, cb: (o: Obstacle) => boolean | void): void;
}

export interface FlightState {
  x: number;
  y: number;
  z: number;
  heading: number;
  pitch: number;
  roll: number;
  speed: number;
  /** Extra vertical velocity from flaps/impacts (m/s), decays. */
  vy: number;
  boost: number;
  boostCooldown: number;
  impactCooldown: number;
  /** Smoothed control values for animation. */
  turnSmooth: number;
  pitchSmooth: number;
  flapping: boolean;
  boosting: boolean;
  time: number;
  /** Set on the step an impact happened (for effects), cleared next step. */
  impacted: boolean;
  /** 1 while touching water, then decays (dripping); 0 when dry. */
  wet: number;
  /** Vertical air speed at the bird (m/s): thermals and ridge lift. */
  lift: number;
  /** True on steps where the bird is in contact with the water surface. */
  onWater: boolean;
  /** Distance travelled (m). */
  odometer: number;
}

export function createFlightState(): FlightState {
  return {
    x: 0, y: 200, z: 0,
    heading: 0, pitch: 0, roll: 0,
    speed: FLIGHT.cruiseSpeed, vy: 0,
    boost: FLIGHT.boostCapacity, boostCooldown: 0, impactCooldown: 0,
    turnSmooth: 0, pitchSmooth: 0, flapping: false, boosting: false, time: 0, impacted: false, odometer: 0, wet: 0, onWater: false, lift: 0,
  };
}

export function copyFlightState(src: FlightState, dst: FlightState): FlightState {
  Object.assign(dst, src);
  return dst;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
/** Frame-rate independent exponential approach factor. */
const approach = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

/**
 * Per-species multipliers on the shared flight constants. 1 everywhere is the
 * reference bird; the ranges stay modest so every bird flies the same route.
 */
export interface FlightProfile {
  /** Cruise, top and boost speeds. */
  speed: number;
  /** Turn rate and how quickly the bird answers the stick and banks. */
  agility: number;
  /** Thrust and lift from a wingbeat. */
  flapPower: number;
  /** Glide efficiency: shallower sink, cheaper climbs, less speed shed. */
  glide: number;
}
export const DEFAULT_PROFILE: FlightProfile = { speed: 1, agility: 1, flapPower: 1, glide: 1 };
/** Height above the surface at which the belly touches the water (m). */
const WATER_CONTACT = 0.35;

export type FlightConstants = { -readonly [K in keyof typeof FLIGHT]: number };

export function tuneFlight(p: FlightProfile): FlightConstants {
  return {
    ...FLIGHT,
    cruiseSpeed: FLIGHT.cruiseSpeed * p.speed,
    maxSpeed: FLIGHT.maxSpeed * p.speed,
    boostMaxSpeed: FLIGHT.boostMaxSpeed * p.speed,
    maxTurnRate: FLIGHT.maxTurnRate * p.agility,
    turnResponse: FLIGHT.turnResponse * p.agility,
    bankResponse: FLIGHT.bankResponse * p.agility,
    flapAccel: FLIGHT.flapAccel * p.flapPower,
    flapLift: FLIGHT.flapLift * p.flapPower,
    glidePitch: FLIGHT.glidePitch / p.glide,
    climbSpeedCost: FLIGHT.climbSpeedCost / p.glide,
    drag: FLIGHT.drag / p.glide,
  };
}

export class FlightController {
  readonly state: FlightState;
  private terrain: TerrainQuery;
  private tuned = tuneFlight(DEFAULT_PROFILE);
  private wasOnWater = false;
  /** Called on terrain/obstacle impact with the impact speed. */
  onImpact: ((speed: number, kind: 'terrain' | 'water' | 'obstacle') => void) | null = null;
  /** Vertical air speed (m/s) at a point; the bird is carried by it. */
  airflow: ((x: number, y: number, z: number) => number) | null = null;
  /** Water contact: 'enter' once per touchdown (steepness 0..1 = how vertical the entry was), 'exit' when airborne again. */
  onWater: ((event: 'enter' | 'exit', speed: number, steepness: number) => void) | null = null;

  constructor(terrain: TerrainQuery, state = createFlightState()) {
    this.terrain = terrain;
    this.state = state;
  }

  setTerrain(t: TerrainQuery): void {
    this.terrain = t;
  }

  /** Apply a species profile; takes effect from the next step. */
  setProfile(p: FlightProfile): void {
    this.tuned = tuneFlight(p);
  }
  get constants(): FlightConstants { return this.tuned; }

  /** Advance the model by one fixed step. */
  step(input: FlightInput, dt = SIM_STEP): void {
    const s = this.state;
    const F = this.tuned;
    s.impacted = false;
    s.time += dt;

    const turnIn = clamp(input.turn, -1, 1);
    const pitchIn = clamp(input.pitch, -1, 1);
    s.turnSmooth += (turnIn - s.turnSmooth) * approach(F.turnResponse, dt);
    s.pitchSmooth += (pitchIn - s.pitchSmooth) * approach(F.pitchRate * 2, dt);

    // Boost resource.
    let boosting = false;
    if (input.boost && s.boost > 0 && (s.boosting || s.boost > F.boostMinToStart)) {
      boosting = true;
      s.boost = Math.max(0, s.boost - F.boostDrain * dt);
      s.boostCooldown = F.boostRecoveryDelay;
    } else {
      if (s.boostCooldown > 0) s.boostCooldown -= dt;
      else s.boost = Math.min(F.boostCapacity, s.boost + F.boostRecovery * dt);
    }
    s.boosting = boosting;
    s.flapping = input.flap;

    // Pitch: input drives target; no input eases to a gentle glide descent.
    const flapPitch = input.flap ? F.flapPitchBoost : 0;
    let pitchTarget = pitchIn >= 0 ? pitchIn * F.maxPitch : pitchIn * -F.minPitch;
    pitchTarget += flapPitch * (1 - Math.max(0, pitchIn));
    if (pitchIn === 0 && !input.flap) pitchTarget = F.glidePitch;
    // Low speed pushes the nose down (soft stall) so the bird cannot hover.
    const stall = clamp((F.minSpeed + 4 - s.speed) / 10, 0, 1);
    pitchTarget = Math.min(pitchTarget, pitchTarget - stall * 0.6);
    const rate = pitchIn === 0 && !input.flap ? F.pitchReturnRate : F.pitchRate;
    s.pitch += (pitchTarget - s.pitch) * approach(rate, dt);
    s.pitch = clamp(s.pitch, F.minPitch, F.maxPitch);

    // Turning with speed-dependent rate and visible bank. Slow flight turns
    // tighter, but the clamp keeps it from spinning on the spot.
    const speedFactor = clamp(s.speed / F.cruiseSpeed, 0.75, 1.25);
    const turnRate = s.turnSmooth * F.maxTurnRate / speedFactor;
    s.heading = wrapAngle(s.heading + turnRate * dt);
    const bankTarget = -s.turnSmooth * F.maxBank * clamp(speedFactor, 0.6, 1);
    s.roll += (bankTarget - s.roll) * approach(F.bankResponse, dt);

    // Speed: gravity along the flight path, drag toward cruise, thrust.
    const maxSpeed = boosting ? F.boostMaxSpeed : F.maxSpeed;
    let accel = 0;
    accel += -Math.sin(s.pitch) * F.gravityGain; // diving gains, climbing loses
    if (s.pitch > 0) accel -= s.pitch * F.climbSpeedCost;
    if (s.speed < F.cruiseSpeed) accel += F.accelToCruise * (1 - s.speed / F.cruiseSpeed) * 1.5;
    else accel -= (s.speed - F.cruiseSpeed) * F.drag;
    if (input.flap) accel += F.flapAccel;
    if (boosting) accel += F.boostAccel;
    if (s.onWater) accel -= s.speed * 0.35; // water drag while skimming
    accel -= input.brake * 22;
    s.speed += accel * dt;
    s.speed = clamp(s.speed, F.minSpeed * 0.6, maxSpeed);

    // Flap lift as a decaying vertical velocity component.
    if (input.flap) s.vy += F.flapLift * dt * 2.2;
    s.vy *= Math.exp(-dt * 2.5);

    // Integrate along the flight path with a swept collision test.
    const dir = headingToDir(s.heading);
    const cp = Math.cos(s.pitch), sp = Math.sin(s.pitch);
    const vx = dir.x * cp * s.speed;
    const vz = dir.z * cp * s.speed;
    const vy = sp * s.speed + s.vy;
    const x0 = s.x, y0 = s.y, z0 = s.z;
    // Rising air (thermals, ridge lift) carries the bird with it.
    s.lift = this.airflow ? this.airflow(x0, y0, z0) : 0;
    const x1 = x0 + vx * dt, y1 = y0 + (vy + s.lift) * dt, z1 = z0 + vz * dt;
    this.wasOnWater = s.onWater;
    s.onWater = false;
    this.sweep(x0, y0, z0, x1, y1, z1);
    if (this.wasOnWater && !s.onWater) this.onWater?.('exit', s.speed, 0);
    this.wasOnWater = s.onWater;
    if (!s.onWater && s.wet > 0) s.wet = Math.max(0, s.wet - dt * 0.35);
    s.odometer += Math.hypot(s.x - x0, s.y - y0, s.z - z0);

    if (s.impactCooldown > 0) s.impactCooldown -= dt;
    if (s.y > F.maxAltitude) {
      s.y = F.maxAltitude;
      if (s.pitch > 0) s.pitch = 0;
    }
  }

  /** Swept motion from p0 to p1 with substeps no longer than FLIGHT.sweepStep. */
  private sweep(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const s = this.state;
    const F = FLIGHT;
    const len = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    const steps = Math.max(1, Math.ceil(len / F.sweepStep));
    let px = x0, py = y0, pz = z0;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const nx = x0 + (x1 - x0) * t;
      const ny = y0 + (y1 - y0) * t;
      const nz = z0 + (z1 - z0) * t;
      const ground = this.terrain.heightAt(nx, nz);
      if (ground < SEA_LEVEL - 0.4) {
        // Over water the surface is not a wall: below belly height the step continues under the
        // surface (down to the dip limit), drag slows the bird and buoyancy lifts it back out.
        if (ny < SEA_LEVEL + WATER_CONTACT) { this.touchWater(x1, y1, z1, ground); return; }
      } else if (ny < Math.max(ground, SEA_LEVEL) + F.groundClearance) {
        // Resolve against the terrain (or the shallow shoreline): place on the floor and bounce gently.
        this.resolveImpact(nx, Math.max(ground, SEA_LEVEL) + F.groundClearance, nz, ground < SEA_LEVEL ? 'water' : 'terrain');
        return;
      }
      // Obstacles (trees, structures): cylinders.
      let hit: Obstacle | null = null;
      this.terrain.forEachObstacleNear(nx, nz, 0.6, (o) => {
        if (ny >= o.bottom && ny <= o.top) {
          const dx = nx - o.x, dz = nz - o.z;
          if (dx * dx + dz * dz < (o.radius + 0.5) ** 2) {
            hit = o;
            return true;
          }
        }
      });
      if (hit) {
        const o = hit as Obstacle;
        // Push out horizontally to the collider surface, keep altitude.
        let dx = nx - o.x, dz = nz - o.z;
        let d = Math.hypot(dx, dz);
        if (d < 1e-3) {
          const dir = headingToDir(s.heading);
          dx = -dir.x; dz = -dir.z; d = 1;
        }
        const r = o.radius + 0.7;
        const ox = o.x + (dx / d) * r, oz = o.z + (dz / d) * r;
        const floor = Math.max(this.terrain.heightAt(ox, oz), SEA_LEVEL) + F.groundClearance;
        this.resolveImpact(ox, Math.max(ny, floor), oz, 'obstacle');
        return;
      }
      px = nx; py = ny; pz = nz;
    }
    s.x = px; s.y = py; s.z = pz;
  }

  /**
   * Water contact. A shallow entry skims: the bird rides just under the
   * surface, sheds speed to drag and spray, and climbs out on its own. A steep
   * entry plunges deeper, loses more speed and pops back up under buoyancy.
   * Both keep the bird above the seabed.
   */
  private touchWater(x: number, y: number, z: number, ground: number): void {
    const s = this.state;
    const F = FLIGHT;
    const steep = clamp(-Math.sin(s.pitch) + Math.max(0, -s.vy) / 40, 0, 1);
    if (!this.wasOnWater) { // first contact of this touchdown (the flag is cleared before every sweep)
      const entrySpeed = s.speed;
      // Belly-flop costs more than a skim; either way it is far gentler than terrain.
      s.speed = Math.max(F.minSpeed * 0.7, s.speed * (1 - 0.55 * steep));
      s.impacted = true;
      this.onWater?.('enter', entrySpeed, steep);
    }
    const maxDip = 0.35 + 1.6 * steep;
    s.x = x; s.z = z;
    s.y = Math.max(y, SEA_LEVEL - maxDip, ground + F.groundClearance);
    s.onWater = true; s.wet = 1;
    // Nose comes up and the roll levels while in the water.
    s.pitch = Math.max(s.pitch, Math.min(0.18, s.pitch + 0.012));
    s.roll *= 0.85;
    // Buoyancy: a spring toward slightly above the surface, capped so it reads as a lift, not a launch.
    s.vy = Math.max(s.vy, Math.min(4.5, (SEA_LEVEL + 0.5 - s.y) * 3.5 + 1.5));
  }

  private resolveImpact(x: number, y: number, z: number, kind: 'terrain' | 'water' | 'obstacle'): void {
    const s = this.state;
    const F = FLIGHT;
    const impactSpeed = s.speed;
    s.x = x; s.y = y; s.z = z;
    // Slow down, level out and nose up slightly so the bird lifts away.
    if (s.impactCooldown <= 0) {
      s.speed = Math.max(F.minSpeed * 0.8, s.speed * F.impactSpeedFactor);
      s.impactCooldown = F.impactCooldown;
      s.impacted = true;
      this.onImpact?.(impactSpeed, kind);
    }
    if (s.pitch < 0.12) s.pitch = 0.12;
    s.vy = Math.max(s.vy, 2.5);
    s.roll *= 0.5;
  }

  /**
   * Recover to a validated safe airborne position near the current one:
   * searches outward for a spot with clear air above terrain and obstacles.
   */
  recover(): void {
    const s = this.state;
    const best = findSafeAirborne(this.terrain, s.x, s.z, s.heading);
    s.x = best.x; s.y = best.y; s.z = best.z;
    s.pitch = 0;
    s.roll = 0;
    s.vy = 0;
    s.speed = FLIGHT.cruiseSpeed;
    s.impactCooldown = 0.5;
  }
}

/** Find a safe airborne position near (x,z): above ground and obstacles with margin. */
export function findSafeAirborne(terrain: TerrainQuery, x: number, z: number, heading: number, minAbove = 60): { x: number; y: number; z: number } {
  let bestX = x, bestZ = z, bestScore = Infinity;
  const dir = headingToDir(heading);
  const samples: [number, number][] = [[x, z]];
  for (let ring = 1; ring <= 3; ring++) {
    const r = ring * 90;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      samples.push([x + Math.cos(a) * r, z + Math.sin(a) * r]);
    }
    samples.push([x - dir.x * r, z - dir.z * r]);
  }
  for (const [sx, sz] of samples) {
    // Score: local terrain roughness around the sample (lower is safer).
    let maxH = -Infinity, minH = Infinity;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const h = Math.max(terrain.heightAt(sx + dx * 40, sz + dz * 40), SEA_LEVEL);
        if (h > maxH) maxH = h;
        if (h < minH) minH = h;
      }
    }
    let obstacleTop = -Infinity;
    terrain.forEachObstacleNear(sx, sz, 30, (o) => {
      obstacleTop = Math.max(obstacleTop, o.top);
    });
    const score = (maxH - minH) + Math.hypot(sx - x, sz - z) * 0.05;
    if (score < bestScore) {
      bestScore = score;
      bestX = sx;
      bestZ = sz;
    }
  }
  let maxH = -Infinity;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      maxH = Math.max(maxH, terrain.heightAt(bestX + dx * 40, bestZ + dz * 40), SEA_LEVEL);
    }
  }
  terrain.forEachObstacleNear(bestX, bestZ, 30, (o) => {
    maxH = Math.max(maxH, o.top);
  });
  return { x: bestX, y: maxH + minAbove, z: bestZ };
}
