/**
 * Map projection: north-up orthographic mapping between global world
 * coordinates (x east, z south) and CSS-pixel map coordinates.
 */

export interface MapView {
  /** Global world coordinates at the center of the map. */
  centerX: number;
  centerZ: number;
  /** Meters per CSS pixel. */
  metersPerPixel: number;
  /** Map size in CSS pixels. */
  width: number;
  height: number;
}

export interface MapPoint {
  px: number;
  py: number;
}

export interface WorldPoint {
  x: number;
  z: number;
}

/** Global world (x, z) -> CSS pixel position on the map (north up). */
export function worldToMap(gx: number, gz: number, view: MapView, out: MapPoint = { px: 0, py: 0 }): MapPoint {
  out.px = (gx - view.centerX) / view.metersPerPixel + view.width / 2;
  out.py = (gz - view.centerZ) / view.metersPerPixel + view.height / 2;
  return out;
}

/** CSS pixel position on the map -> global world (x, z). */
export function mapToWorld(px: number, py: number, view: MapView, out: WorldPoint = { x: 0, z: 0 }): WorldPoint {
  out.x = (px - view.width / 2) * view.metersPerPixel + view.centerX;
  out.z = (py - view.height / 2) * view.metersPerPixel + view.centerZ;
  return out;
}

/**
 * Zoom the view around a fixed pixel anchor so the world point under the
 * cursor stays put.
 */
export function zoomAround(view: MapView, factor: number, anchorPx: number, anchorPy: number, minMpp: number, maxMpp: number): void {
  const before = mapToWorld(anchorPx, anchorPy, view);
  const next = Math.min(maxMpp, Math.max(minMpp, view.metersPerPixel * factor));
  view.metersPerPixel = next;
  const after = mapToWorld(anchorPx, anchorPy, view);
  view.centerX += before.x - after.x;
  view.centerZ += before.z - after.z;
}

/** Pan by a pixel delta. */
export function panBy(view: MapView, dpx: number, dpy: number): void {
  view.centerX -= dpx * view.metersPerPixel;
  view.centerZ -= dpy * view.metersPerPixel;
}

/** Convert a pointer event to CSS pixel coordinates within an element. */
export function pointerToLocal(el: HTMLElement, clientX: number, clientY: number): MapPoint {
  const r = el.getBoundingClientRect();
  return { px: clientX - r.left, py: clientY - r.top };
}
