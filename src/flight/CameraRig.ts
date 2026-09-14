/**
 * Chase / cinematic camera with frame-rate independent smoothing, orbit
 * offsets from the mouse, terrain clearance and gentle roll follow.
 * Operates in render space (global minus origin) and reads global terrain
 * through the supplied height query.
 */
import * as THREE from 'three';
import { CAMERA } from '../core/config';
import { headingToDir } from '../world/coords';
import type { FlightState } from './FlightController';
import type { CameraInput } from './Input';

export type CameraMode = 'chase' | 'cinematic';

const _target = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qRoll = new THREE.Quaternion();
const _zAxis = new THREE.Vector3(0, 0, 1);

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'chase';
  reducedMotion = false;
  private distance: number = CAMERA.chase.distance;
  private orbitYaw = 0;
  private orbitPitch = 0;
  private orbitIdle = 0;
  private position = new THREE.Vector3();
  private lookAt = new THREE.Vector3();
  private initialized = false;
  private fovCurrent = CAMERA.chase.fov;
  private shake = 0;
  private heightAt: (gx: number, gz: number) => number;
  private originX = 0;
  private originZ = 0;

  constructor(camera: THREE.PerspectiveCamera, heightAt: (gx: number, gz: number) => number) {
    this.camera = camera;
    this.heightAt = heightAt;
  }

  setOrigin(ox: number, oz: number): void {
    // Keep the camera's global position unchanged when the origin shifts.
    const dx = ox - this.originX, dz = oz - this.originZ;
    this.position.x -= dx; this.position.z -= dz;
    this.lookAt.x -= dx; this.lookAt.z -= dz;
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

  addShake(amount: number): void {
    if (!this.reducedMotion) this.shake = Math.min(1, this.shake + amount);
  }

  get currentDistance(): number {
    return this.distance;
  }

  /**
   * Update the camera. `bird` is the interpolated flight state in global
   * coordinates; `renderX/Z` the same position in render space.
   */
  update(dt: number, bird: FlightState, input: CameraInput): void {
    const preset = this.mode === 'chase' ? CAMERA.chase : CAMERA.cinematic;
    // Zoom
    if (input.zoom !== 0) {
      this.distance = THREE.MathUtils.clamp(this.distance + input.zoom, CAMERA.minDistance, CAMERA.maxDistance);
    }
    // Orbit offsets persist while dragging; ease back after a short idle.
    if (input.dragging) {
      this.orbitYaw += input.orbitYaw;
      this.orbitPitch = THREE.MathUtils.clamp(this.orbitPitch + input.orbitPitch, -0.6, 0.9);
      this.orbitIdle = 0;
    } else {
      this.orbitIdle += dt;
      if (this.orbitIdle > CAMERA.orbitReturnDelay) {
        const k = 1 - Math.exp(-CAMERA.orbitReturnRate * dt);
        this.orbitYaw += (0 - this.orbitYaw) * k;
        this.orbitPitch += (0 - this.orbitPitch) * k;
      }
    }

    const rx = bird.x - this.originX, rz = bird.z - this.originZ;
    const dir = headingToDir(bird.heading);
    _fwd.set(dir.x, 0, dir.z);
    // Rotate the follow direction by the orbit yaw.
    const cy = Math.cos(this.orbitYaw), sy = Math.sin(this.orbitYaw);
    const fx = _fwd.x * cy - _fwd.z * sy;
    const fz = _fwd.x * sy + _fwd.z * cy;
    const dist = this.mode === 'chase' ? this.distance : this.distance * (CAMERA.cinematic.distance / CAMERA.chase.distance);
    const height = preset.height * (dist / preset.distance) + this.orbitPitch * dist * 0.9;
    // Slight lateral offset into the turn so banking reads well.
    _right.set(-_fwd.z, 0, _fwd.x);
    const lateral = -bird.roll * 0.12 * dist;
    _desired.set(
      rx - fx * dist + _right.x * lateral,
      bird.y + height - Math.sin(bird.pitch) * dist * 0.35,
      rz - fz * dist + _right.z * lateral,
    );
    _look.set(rx + _fwd.x * preset.lookAhead, bird.y + Math.sin(bird.pitch) * preset.lookAhead * 0.6 + 0.6, rz + _fwd.z * preset.lookAhead);

    if (!this.initialized) {
      this.position.copy(_desired);
      this.lookAt.copy(_look);
      this.initialized = true;
    } else {
      const kp = 1 - Math.exp(-CAMERA.positionSmoothing * dt);
      const kl = 1 - Math.exp(-CAMERA.lookSmoothing * dt);
      this.position.lerp(_desired, kp);
      this.lookAt.lerp(_look, kl);
    }

    // Keep the camera above terrain / water.
    const camGround = Math.max(this.heightAt(this.position.x + this.originX, this.position.z + this.originZ), 0) + CAMERA.minClearance;
    if (this.position.y < camGround) this.position.y = camGround;

    // Shake decays; only applied when not reduced motion.
    let sx = 0, sy2 = 0;
    if (this.shake > 0) {
      const t = bird.time * 40;
      sx = Math.sin(t * 1.3) * this.shake * 0.35;
      sy2 = Math.cos(t * 1.7) * this.shake * 0.25;
      this.shake = Math.max(0, this.shake - dt * 2.2);
    }

    this.camera.position.set(this.position.x + sx, this.position.y + sy2, this.position.z);
    _target.copy(this.lookAt);
    _m.lookAt(this.camera.position, _target, _up);
    _q.setFromRotationMatrix(_m);
    // Follow a fraction of the bird's roll so banking is felt without rolling the horizon much.
    const rollAmount = this.reducedMotion ? 0.1 : CAMERA.rollFollow;
    _qRoll.setFromAxisAngle(_zAxis, bird.roll * rollAmount);
    _q.multiply(_qRoll);
    this.camera.quaternion.copy(_q);

    // FOV: widen slightly with speed and boost unless reduced motion.
    const speedFov = this.reducedMotion ? 0 : THREE.MathUtils.clamp((bird.speed - 34) / 50, 0, 1) * 9 + (bird.boosting ? 3 : 0);
    const fovTarget = preset.fov + speedFov;
    this.fovCurrent += (fovTarget - this.fovCurrent) * (1 - Math.exp(-3 * dt));
    if (Math.abs(this.camera.fov - this.fovCurrent) > 0.01) {
      this.camera.fov = this.fovCurrent;
      this.camera.updateProjectionMatrix();
    }
  }
}
