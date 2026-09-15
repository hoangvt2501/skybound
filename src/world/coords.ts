/**
 * World coordinate conventions used everywhere in SKYBOUND.
 *
 *  - One world unit is one meter.
 *  - +X is east, -Z is north, +Y is up (Three.js right-handed).
 *  - Heading is a compass angle in radians: 0 = north (-Z), increasing
 *    clockwise, so PI/2 = east (+X).
 *  - "Global" coordinates are the authoritative world position used for
 *    generation, maps, saves and navigation. "Render" coordinates are global
 *    minus the current floating origin (see Origin in world/Origin.ts).
 *  - Sea level is y = 0.
 */

export const TAU = Math.PI * 2;

/** Forward unit vector on the horizontal plane for a compass heading. */
export function headingToDir(heading: number): { x: number; z: number } {
  return { x: Math.sin(heading), z: -Math.cos(heading) };
}

/** Compass heading of a horizontal direction vector. */
export function dirToHeading(x: number, z: number): number {
  return Math.atan2(x, -z);
}

/** Bearing from point A to point B (compass heading), in radians. */
export function bearingTo(ax: number, az: number, bx: number, bz: number): number {
  return wrapAngle(Math.atan2(bx - ax, -(bz - az)));
}

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  else if (a <= -Math.PI) a += TAU;
  return a;
}

export function radToDeg(r: number): number {
  return (r * 180) / Math.PI;
}

/** Compass heading in degrees [0, 360). */
export function headingDegrees(heading: number): number {
  let d = radToDeg(heading) % 360;
  if (d < 0) d += 360;
  return d;
}

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export function headingLabel(heading: number): string {
  const d = headingDegrees(heading);
  return CARDINALS[Math.round(d / 45) % 8];
}

export function horizontalDistance(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(bx - ax, bz - az);
}

/** Format a distance for the HUD/map. */
export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  if (m < 10000) return `${(m / 1000).toFixed(2)} km`;
  return `${(m / 1000).toFixed(1)} km`;
}
