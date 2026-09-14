/**
 * Floating origin. All world objects are children of `root`; `root.position`
 * is `-origin`, so an object whose global position is G renders at G - origin.
 * Global coordinates are never changed by a rebase; only the render offset is.
 */
import * as THREE from 'three';

export const REBASE_DISTANCE = 6000;

export class Origin {
  /** Global coordinates of the render-space origin. */
  readonly value = new THREE.Vector3(0, 0, 0);
  readonly root: THREE.Group;
  private listeners = new Set<(dx: number, dz: number) => void>();

  constructor(root: THREE.Group) {
    this.root = root;
  }

  /** Rebase the origin if the given global position is far from it. Returns true when rebased. */
  maybeRebase(gx: number, gz: number): boolean {
    const dx = gx - this.value.x;
    const dz = gz - this.value.z;
    if (dx * dx + dz * dz < REBASE_DISTANCE * REBASE_DISTANCE) return false;
    this.setOrigin(Math.round(gx / 1000) * 1000, Math.round(gz / 1000) * 1000);
    return true;
  }

  setOrigin(gx: number, gz: number): void {
    const dx = gx - this.value.x;
    const dz = gz - this.value.z;
    this.value.set(gx, 0, gz);
    this.root.position.set(-gx, 0, -gz);
    for (const l of this.listeners) l(dx, dz);
  }

  onRebase(listener: (dx: number, dz: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Global -> render space. */
  toRender(g: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.set(g.x - this.value.x, g.y, g.z - this.value.z);
  }

  /** Render -> global space. */
  toGlobal(r: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.set(r.x + this.value.x, r.y, r.z + this.value.z);
  }
}
