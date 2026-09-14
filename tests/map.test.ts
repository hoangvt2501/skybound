import { describe, expect, it } from 'vitest';
import { mapToWorld, panBy, worldToMap, zoomAround, type MapView } from '../src/map/projection';
import { rasterizeTile, TILE_MPP, TILE_PX, tileSizeMeters } from '../src/map/tileRaster';
import { WorldGen } from '../src/world/WorldGen';
import { bearingTo, headingDegrees, headingToDir, dirToHeading, wrapAngle } from '../src/world/coords';
import { Navigation } from '../src/core/Navigation';

describe('Map projection', () => {
  const view: MapView = { centerX: -1234.5, centerZ: 987.25, metersPerPixel: 12.5, width: 640, height: 480 };

  it('round-trips world -> map -> world including negative coordinates', () => {
    for (const [x, z] of [[0, 0], [-16000, -16000], [16000, 16000], [-3.75, 9999.5], [123456, -654321]]) {
      const p = worldToMap(x, z, view);
      const w = mapToWorld(p.px, p.py, view);
      expect(w.x).toBeCloseTo(x, 6);
      expect(w.z).toBeCloseTo(z, 6);
    }
  });

  it('is north-up: decreasing z moves up the screen, increasing x moves right', () => {
    const a = worldToMap(0, 0, view);
    const north = worldToMap(0, -100, view);
    const east = worldToMap(100, 0, view);
    expect(north.py).toBeLessThan(a.py);
    expect(east.px).toBeGreaterThan(a.px);
    expect(a.px - north.px).toBeCloseTo(0, 9);
  });

  it('center maps to the middle of the canvas', () => {
    const p = worldToMap(view.centerX, view.centerZ, view);
    expect(p.px).toBeCloseTo(320);
    expect(p.py).toBeCloseTo(240);
  });

  it('zoomAround keeps the anchored world point under the cursor', () => {
    const v = { ...view };
    const anchor = { px: 100, py: 400 };
    const before = mapToWorld(anchor.px, anchor.py, v);
    zoomAround(v, 0.5, anchor.px, anchor.py, 1, 200);
    const after = mapToWorld(anchor.px, anchor.py, v);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.z).toBeCloseTo(before.z, 6);
    expect(v.metersPerPixel).toBeCloseTo(6.25);
    zoomAround(v, 1000, anchor.px, anchor.py, 1, 200);
    expect(v.metersPerPixel).toBe(200);
  });

  it('panBy moves the view by the pixel delta in meters', () => {
    const v = { ...view };
    panBy(v, 10, -20);
    expect(v.centerX).toBeCloseTo(view.centerX - 125);
    expect(v.centerZ).toBeCloseTo(view.centerZ + 250);
  });

  it('waypoint placement from a click resolves to the expected world point and bearing', () => {
    const v: MapView = { centerX: 0, centerZ: 0, metersPerPixel: 10, width: 400, height: 400 };
    const w = mapToWorld(300, 100, v); // right and up => east and north
    expect(w.x).toBeCloseTo(1000);
    expect(w.z).toBeCloseTo(-1000);
    const b = headingDegrees(bearingTo(0, 0, w.x, w.z));
    expect(b).toBeCloseTo(45);
    const nav = new Navigation();
    nav.setWaypoint(w.x, w.z);
    const r = nav.toWaypoint(0, 0)!;
    expect(r.distance).toBeCloseTo(Math.hypot(1000, 1000));
    expect(headingDegrees(r.bearing)).toBeCloseTo(45);
  });
});

describe('Coordinate conventions', () => {
  it('heading 0 is north (-Z), PI/2 is east (+X), and conversions round-trip', () => {
    const n = headingToDir(0);
    expect(n.x).toBeCloseTo(0);
    expect(n.z).toBeCloseTo(-1);
    const e = headingToDir(Math.PI / 2);
    expect(e.x).toBeCloseTo(1);
    expect(e.z).toBeCloseTo(0);
    for (const h of [-3, -1.5, 0, 0.7, 2.9]) {
      const d = headingToDir(h);
      expect(wrapAngle(dirToHeading(d.x, d.z) - h)).toBeCloseTo(0, 9);
    }
  });
});

describe('Map tiles', () => {
  it('tile pixels are deterministic and cover the intended world area', () => {
    const gen = new WorldGen(1207);
    // Tile -5 at zoom 0 (4096 m per 32 px tile) spans x in [-20480, -16384): open ocean beyond the region.
    const a = rasterizeTile(gen, 0, -5, 0, 32);
    const b = rasterizeTile(gen, 0, -5, 0, 32);
    expect(a).toEqual(b);
    expect(a.length).toBe(32 * 32 * 4);
    expect(tileSizeMeters(0)).toBe(TILE_MPP[0] * TILE_PX);
    // Ocean pixels are blue-ish where the sampler says water.
    const size = TILE_MPP[0] * 32;
    let checked = 0;
    for (let j = 0; j < 32; j += 8) {
      for (let i = 0; i < 32; i += 8) {
        const x = -5 * size + (i + 0.5) * TILE_MPP[0];
        const z = (j + 0.5) * TILE_MPP[0];
        const o = (j * 32 + i) * 4;
        const water = gen.heightAt(x, z) < 0;
        if (water) {
          expect(a[o + 2]).toBeGreaterThan(a[o]); // blue > red
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
