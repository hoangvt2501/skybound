/**
 * Camera rig: chase camera behind the bird, and a free-look spherical orbit
 * around a bird-centered pivot driven by mouse/touch drags.
 *
 *  - Chase: follows behind and slightly above the bird with look-ahead.
 *  - Free-look: the viewing azimuth/elevation are kept in WORLD space, so the
 *    camera keeps following the bird's position while the bird may turn
 *    underneath it. The view is kept on release unless auto-center is on.
 *  - Distance is stable and changed only by the wheel/pinch; terrain, water
 *    and large obstacles shorten it smoothly instead of teleporting through.
 *
 * All smoothing is done in global coordinates and converted to render space
 * at the end, so floating-origin rebasing never disturbs the view.
 */
import * as THREE from 'three';
import { CAMERA } from '../core/config';
import { dirToHeading, headingToDir, wrapAngle } from '../world/coords';
import type { FlightState, Obstacle } from './FlightController';
import type { CameraInput } from './Input';

export type CameraMode = 'chase' | 'cinematic';

export interface CameraQuery {
  /** Surface height (terrain or water) at a global position. */
  surfaceAt(gx: number, gz: number): number;
  /** Visit large obstacles near a point. */
  forEachObstacleNear(gx: number, gz: number, radius: number, cb: (o: Obstacle) => boolean | void): void;
}

const _up = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qRoll = new THREE.Quaternion();
const _zAxis = new THREE.Vector3(0, 0, 1);
const _pos = new THREE.Vector3();
const _look = new THREE.Vector3();

const ELEVATION_MIN = -0.28;
const ELEVATION_MAX = 1.25;
const approach = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'chase';
  reducedMotion = false;
  /** When true the camera eases back behind the bird after an idle delay. */
  autoCenter = false;
  /** True while the user-chosen orbit is active. */
  freeLook = false;
  private distance: number = CAMERA.chase.distance;
  private effectiveDistance: number = CAMERA.chase.distance;
  /** World-space orbit angles (azimuth = compass direction from bird to camera). */
  private azimuth = Math.PI;
  private elevation = 0.24;
  private idle = 0;
  private returning = false;
  private lookAheadBlend = 1;
  private smoothed = new THREE.Vector3();
  private smoothedLook = new THREE.Vector3();
  private initialized = false;
  private fovCurrent = CAMERA.chase.fov;
  /** Fixed field of view (degrees) while photo mode holds the lens; null = automatic. */
  fovOverride: number | null = null;
  private shake = 0;
  private query: CameraQuery;
  private originX = 0;
  private originZ = 0;
  private rollSmooth = 0;

  constructor(camera: THREE.PerspectiveCamera, query: CameraQuery) {
    this.camera = camera;
    this.query = query;
  }

  setOrigin(ox: number, oz: number): void {
    this.originX = ox;
    this.originZ = oz;
  }

  cycleMode(): CameraMode {
    this.mode = this.mode === 'chase' ? 'cinematic' : 'chase';
    return this.mode;
  }

  setMode(mode: CameraMode): void {
    this.mode = mode;
  }

  /** Reset smoothing so the next update snaps (used after teleports). */
  snap(): void {
    this.initialized = false;
  }

  /** Smoothly return behind the bird and re-enter chase behaviour. */
  resetView(): void {
    this.returning = true;
    this.idle = 0;
  }

  /** Leave free-look immediately (used when a flight begins after the attract camera). */
  exitFreeLook(): void {
    this.freeLook = false;
    this.returning = false;
    this.idle = 0;
  }

  addShake(amount: number): void {
    if (!this.reducedMotion) this.shake = Math.min(1, this.shake + amount);
  }

  get currentDistance(): number {
    return this.distance;
  }

  /** Debug/testing: current orbit state. */
  state() {
    return { azimuth: this.azimuth, elevation: this.elevation, distance: this.distance, effectiveDistance: this.effectiveDistance, freeLook: this.freeLook, returning: this.returning };
  }

  /** Apply an explicit orbit (tests / captures). */
  setOrbit(azimuth: number, elevation: number, distance?: number): void {
    this.azimuth = wrapAngle(azimuth);
    this.elevation = THREE.MathUtils.clamp(elevation, ELEVATION_MIN, ELEVATION_MAX);
    if (distance !== undefined) this.distance = THREE.MathUtils.clamp(distance, CAMERA.minDistance, CAMERA.maxDistance);
    this.freeLook = true;
    this.returning = false;
    this.idle = 0;
  }

  /**
   * Update the camera. `bird` is the interpolated flight state in global
   * coordinates; camera deltas come from the input manager.
   */
  update(dt: number, bird: FlightState, input: CameraInput): void {
    const preset = this.mode === 'chase' ? CAMERA.chase : CAMERA.cinematic;
    const presetDistance = preset.distance;
    const presetElevation = Math.atan2(preset.height, preset.distance);

    // Zoom (wheel / pinch): smooth, bounded.
    if (input.zoom !== 0) {
      this.distance = THREE.MathUtils.clamp(this.distance + input.zoom * (this.distance / 14), CAMERA.minDistance, CAMERA.maxDistance);
    }

    // Orbit deltas are consumed whenever present, even if the pointer was
    // released between frames.
    if (input.orbitYaw !== 0 || input.orbitPitch !== 0) {
      if (!this.freeLook) {
        // Enter free-look from where the camera actually is, not from the chase target: after a
        // turn the chase camera lags behind, sits off to the banked side and lower with the pitch,
        // and the first drag frame used to snap all of that away toward the bird's heading.
        const dx = this.smoothed.x - bird.x, dz = this.smoothed.z - bird.z, dy = this.smoothed.y - (bird.y + 0.6);
        const horizontal = Math.hypot(dx, dz);
        if (this.initialized && horizontal > 0.5) {
          this.azimuth = dirToHeading(dx, dz);
          this.elevation = THREE.MathUtils.clamp(Math.atan2(dy, horizontal), ELEVATION_MIN, ELEVATION_MAX);
        } else {
          this.azimuth = wrapAngle(bird.heading + Math.PI);
          this.elevation = presetElevation;
        }
      }
      this.freeLook = true;
      this.returning = false;
      this.azimuth = wrapAngle(this.azimuth - input.orbitYaw);
      this.elevation = THREE.MathUtils.clamp(this.elevation + input.orbitPitch, ELEVATION_MIN, ELEVATION_MAX);
      this.idle = 0;
    } else if (!input.dragging) {
      this.idle += dt;
    }

    // Auto-center (optional) after an idle delay.
    if (this.freeLook && this.autoCenter && !input.dragging && this.idle > CAMERA.orbitReturnDelay) this.returning = true;

    // Target orbit: behind the bird in chase, user angles in free-look.
    let targetAz = wrapAngle(bird.heading + Math.PI);
    let targetEl = presetElevation;
    if (this.freeLook && !this.returning) {
      targetAz = this.azimuth;
      targetEl = this.elevation;
    } else if (this.returning) {
      const k = approach(CAMERA.orbitReturnRate, dt);
      this.azimuth = wrapAngle(this.azimuth + wrapAngle(targetAz - this.azimuth) * k);
      this.elevation += (targetEl - this.elevation) * k;
      targetAz = this.azimuth;
      targetEl = this.elevation;
      if (Math.abs(wrapAngle(this.azimuth - (bird.heading + Math.PI))) < 0.02 && Math.abs(this.elevation - presetElevation) < 0.01) {
        this.returning = false;
        this.freeLook = false;
      }
    } else {
      // Chase: keep the stored angles in sync so a later drag starts from here.
      this.azimuth = targetAz;
      this.elevation = targetEl;
    }
    // Look-ahead follows how far the orbit has been dragged from behind the bird, so the view changes
    // in step with the hand: a time-based fade made the first second of a drag feel stuck and then
    // swung the view by itself. Behind the bird (chase, or a drag that stays near it) it is full.
    const deviation = Math.abs(wrapAngle(targetAz - (bird.heading + Math.PI)));
    const lookAheadTarget = this.freeLook ? 1 - THREE.MathUtils.smoothstep(deviation, 0.12, 0.75) : 1;
    this.lookAheadBlend += (lookAheadTarget - this.lookAheadBlend) * approach(12, dt);

    // Desired camera position in global space (spherical around the pivot).
    const dist = this.mode === 'chase' ? this.distance : this.distance * (CAMERA.cinematic.distance / CAMERA.chase.distance);
    const pivotY = bird.y + 0.6;
    const dir = headingToDir(targetAz);
    const ce = Math.cos(targetEl), se = Math.sin(targetEl);
    // Chase adds a slight lateral offset into the turn so banking reads well.
    let lateralX = 0, lateralZ = 0;
    if (!this.freeLook) {
      const fwd = headingToDir(bird.heading);
      const lateral = -bird.roll * 0.12 * dist;
      lateralX = -fwd.z * lateral;
      lateralZ = fwd.x * lateral;
    }
    const desiredX = bird.x + dir.x * ce * dist + lateralX;
    const desiredY = pivotY + se * dist - (this.freeLook ? 0 : Math.sin(bird.pitch) * dist * 0.35);
    const desiredZ = bird.z + dir.z * ce * dist + lateralZ;

    // Occlusion: shorten the boom when terrain, water or a large obstacle
    // sits between the pivot and the camera. Fast in, slow out.
    const allowed = this.occlusionDistance(bird.x, pivotY, bird.z, desiredX, desiredY, desiredZ, dist);
    const kIn = approach(14, dt), kOut = approach(2.5, dt);
    if (allowed < this.effectiveDistance) this.effectiveDistance += (allowed - this.effectiveDistance) * kIn;
    else this.effectiveDistance += (allowed - this.effectiveDistance) * kOut;
    const t = this.effectiveDistance / dist;
    const camX = bird.x + (desiredX - bird.x) * t;
    const camY = pivotY + (desiredY - pivotY) * t;
    const camZ = bird.z + (desiredZ - bird.z) * t;

    // Look target: bird with look-ahead in chase.
    const fwd = headingToDir(bird.heading);
    const la = preset.lookAhead * this.lookAheadBlend;
    const lookX = bird.x + fwd.x * la;
    const lookY = pivotY + Math.sin(bird.pitch) * la * 0.6;
    const lookZ = bird.z + fwd.z * la;

    if (!this.initialized) {
      this.smoothed.set(camX, camY, camZ);
      this.smoothedLook.set(lookX, lookY, lookZ);
      this.effectiveDistance = allowed;
      this.initialized = true;
    } else {
      // Position follows almost rigidly in free-look (the orbit is the user's, and any lag behind the
      // bird turns a long frame into a visible catch-up jerk) and with a little lag in chase; the look
      // target is smoothed, less so in free-look.
      const kp = approach(this.freeLook ? 40 : CAMERA.positionSmoothing, dt);
      const kl = approach(this.freeLook ? 16 : CAMERA.lookSmoothing, dt);
      _pos.set(camX, camY, camZ);
      _look.set(lookX, lookY, lookZ);
      this.smoothed.lerp(_pos, kp);
      this.smoothedLook.lerp(_look, kl);
    }

    // Never below the surface, whatever the smoothing did.
    const floor = this.query.surfaceAt(this.smoothed.x, this.smoothed.z) + CAMERA.minClearance;
    if (this.smoothed.y < floor) this.smoothed.y = floor;

    // Shake decays; only applied when not reduced motion.
    let sx = 0, sy = 0;
    if (this.shake > 0) {
      const tt = bird.time * 40;
      sx = Math.sin(tt * 1.3) * this.shake * 0.35;
      sy = Math.cos(tt * 1.7) * this.shake * 0.25;
      this.shake = Math.max(0, this.shake - dt * 2.2);
    }

    // Render space.
    this.camera.position.set(this.smoothed.x - this.originX + sx, this.smoothed.y + sy, this.smoothed.z - this.originZ);
    _look.set(this.smoothedLook.x - this.originX, this.smoothedLook.y, this.smoothedLook.z - this.originZ);
    _m.lookAt(this.camera.position, _look, _up);
    _q.setFromRotationMatrix(_m);
    // Follow a fraction of the bird's roll in chase only; a drag that starts mid-turn levels the
    // horizon gently instead of in a few frames.
    const rollTarget = this.freeLook ? 0 : bird.roll * (this.reducedMotion ? 0.1 : CAMERA.rollFollow);
    this.rollSmooth += (rollTarget - this.rollSmooth) * approach(this.freeLook ? 2 : 6, dt);
    _qRoll.setFromAxisAngle(_zAxis, this.rollSmooth);
    _q.multiply(_qRoll);
    this.camera.quaternion.copy(_q);

    // FOV: widen slightly with speed and boost unless reduced motion.
    const speedFov = this.reducedMotion ? 0 : THREE.MathUtils.clamp((bird.speed - 34) / 50, 0, 1) * 9 + (bird.boosting ? 3 : 0);
    const fovTarget = this.fovOverride ?? preset.fov + speedFov;
    this.fovCurrent += (fovTarget - this.fovCurrent) * approach(3, dt);
    if (Math.abs(this.camera.fov - this.fovCurrent) > 0.01) {
      this.camera.fov = this.fovCurrent;
      this.camera.updateProjectionMatrix();
    }
    void presetDistance;
  }

  /** Longest boom length (<= dist) that keeps the camera clear of surfaces and large obstacles. */
  private occlusionDistance(px: number, py: number, pz: number, cx: number, cy: number, cz: number, dist: number): number {
    const steps = 8;
    let allowed = dist;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = px + (cx - px) * t, y = py + (cy - py) * t, z = pz + (cz - pz) * t;
      const surface = this.query.surfaceAt(x, z) + CAMERA.minClearance;
      let blocked = y < surface;
      if (!blocked) {
        this.query.forEachObstacleNear(x, z, 1.5, (o) => {
          if (o.radius >= 4 && y > o.bottom && y < o.top) {
            const dx = x - o.x, dz = z - o.z;
            if (dx * dx + dz * dz < (o.radius + 1.5) ** 2) { blocked = true; return true; }
          }
        });
      }
      if (blocked) {
        allowed = Math.max(CAMERA.minDistance * 0.5, dist * ((i - 1) / steps) - 0.5);
        break;
      }
    }
    return allowed;
  }
}
