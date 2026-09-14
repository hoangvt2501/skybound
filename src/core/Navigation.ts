/**
 * Navigation state: the single active waypoint, discovered landmarks and
 * explored cells. Pure data with change notifications.
 */
import { EXPLORE_CELL_SIZE } from './config';
import { bearingTo, horizontalDistance } from '../world/coords';

export interface Waypoint {
  x: number;
  z: number;
  landmarkId: string | null;
}

export class Navigation {
  waypoint: Waypoint | null = null;
  readonly discovered = new Set<string>();
  readonly explored = new Set<string>();
  private listeners = new Set<() => void>();

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  setWaypoint(x: number, z: number, landmarkId: string | null = null): void {
    this.waypoint = { x, z, landmarkId };
    this.emit();
  }

  clearWaypoint(): void {
    if (!this.waypoint) return;
    this.waypoint = null;
    this.emit();
  }

  /** Returns true if newly discovered. */
  discover(id: string): boolean {
    if (this.discovered.has(id)) return false;
    this.discovered.add(id);
    this.emit();
    return true;
  }

  isDiscovered(id: string): boolean {
    return this.discovered.has(id);
  }

  static cellKey(x: number, z: number): string {
    return `${Math.floor(x / EXPLORE_CELL_SIZE)},${Math.floor(z / EXPLORE_CELL_SIZE)}`;
  }

  /** Mark the cell containing (x,z) explored; true if it was new. */
  markExplored(x: number, z: number): boolean {
    const k = Navigation.cellKey(x, z);
    if (this.explored.has(k)) return false;
    this.explored.add(k);
    return true;
  }

  isExploredCell(cx: number, cz: number): boolean {
    return this.explored.has(`${cx},${cz}`);
  }

  /** Bearing (radians) and horizontal distance (m) to the waypoint from a point. */
  toWaypoint(x: number, z: number): { bearing: number; distance: number } | null {
    if (!this.waypoint) return null;
    return {
      bearing: bearingTo(x, z, this.waypoint.x, this.waypoint.z),
      distance: horizontalDistance(x, z, this.waypoint.x, this.waypoint.z),
    };
  }

  load(discovered: string[], explored: string[], waypoint: Waypoint | null): void {
    this.discovered.clear();
    for (const d of discovered) this.discovered.add(d);
    this.explored.clear();
    for (const e of explored) this.explored.add(e);
    this.waypoint = waypoint ? { ...waypoint } : null;
    this.emit();
  }

  reset(): void {
    this.discovered.clear();
    this.explored.clear();
    this.waypoint = null;
    this.emit();
  }
}
