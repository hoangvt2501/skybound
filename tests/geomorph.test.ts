import { describe, expect, it } from 'vitest';
import { FAR_TILE_Y_OFFSET, LOD_SPACING, SEA_LEVEL } from '../src/core/config';
import { buildChunkMesh, buildFarTile, sampleHeightGrid } from '../src/world/chunkMesh';
import { WorldGen } from '../src/world/WorldGen';

const gen = new WorldGen(1207);

describe('terrain geomorph data', () => {
  it('stores the next LOD surface at every vertex: exact at shared vertices, the coarse triangle between them', () => {
    // A chunk with relief near the opening position.
    const cx = -10, cz = 13;
    for (let lod = 0; lod < LOD_SPACING.length - 1; lod++) {
      const fine = buildChunkMesh(gen, cx, cz, lod);
      const coarse = buildChunkMesh(gen, cx, cz, lod + 1);
      const n = fine.segments + 1;
      expect(fine.parentHeights.length).toBe(n * n);
      expect(fine.morph.length).toBe(fine.positions.length / 3 * 4);
      let maxErr = 0;
      for (let j = 0; j < n; j += 1) for (let i = 0; i < n; i += 1) {
        const lx = i * fine.spacing, lz = j * fine.spacing;
        const onCoarse = sampleHeightGrid(coarse.heights, coarse.segments, coarse.spacing, lx, lz);
        maxErr = Math.max(maxErr, Math.abs(fine.parentHeights[j * n + i] - onCoarse));
        expect(fine.morph[(j * n + i) * 4]).toBe(fine.parentHeights[j * n + i]);
      }
      expect(maxErr).toBeLessThan(1e-3);
      // Parent normals are unit length and the shared vertices carry the coarse mesh's own normal.
      const cn = coarse.segments + 1;
      for (let j = 0; j < n; j += 2) for (let i = 0; i < n; i += 2) {
        const o = (j * n + i) * 4, co = ((j / 2) * cn + i / 2) * 3;
        expect(Math.hypot(fine.morph[o + 1], fine.morph[o + 2], fine.morph[o + 3])).toBeCloseTo(1, 5);
        expect(fine.morph[o + 1]).toBeCloseTo(coarse.normals[co], 5);
        expect(fine.morph[o + 3]).toBeCloseTo(coarse.normals[co + 2], 5);
      }
    }
  });
  it('gives the coarsest LOD the far shell as its parent (sunk, water clamped)', () => {
    const lod = LOD_SPACING.length - 1;
    const cx = -10, cz = 13; // spans land and ponds
    const chunk = buildChunkMesh(gen, cx, cz, lod);
    const tx = Math.floor(cx * 512 / 4096), tz = Math.floor(cz * 512 / 4096);
    const far = buildFarTile(gen, tx, tz);
    const n = chunk.segments + 1, fn = 64 + 1;
    let checked = 0;
    for (let j = 0; j < n; j += 2) for (let i = 0; i < n; i += 2) {
      // Far vertex at the same world position.
      const gx = cx * 512 + i * chunk.spacing, gz = cz * 512 + j * chunk.spacing;
      const fi = Math.round((gx - tx * 4096) / 64), fj = Math.round((gz - tz * 4096) / 64);
      if (fi < 0 || fi >= fn || fj < 0 || fj >= fn) continue;
      const farY = far.positions[(fj * fn + fi) * 3 + 1];
      expect(chunk.parentHeights[j * n + i]).toBeCloseTo(farY, 4);
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
    // At shared (even) vertices water is clamped below the plane and everything is sunk by the far
    // offset; odd vertices interpolate between shared ones and may sit between land and water.
    for (let j = 0; j < n; j += 2) for (let i = 0; i < n; i += 2) {
      const v = j * n + i;
      if (chunk.heights[v] < SEA_LEVEL) expect(chunk.parentHeights[v]).toBeLessThanOrEqual(SEA_LEVEL - 4 + FAR_TILE_Y_OFFSET + 1e-6);
      else expect(chunk.parentHeights[v]).toBeCloseTo(chunk.heights[v] + FAR_TILE_Y_OFFSET, 4);
    }
  });
  it('drops the skirt parent heights with the skirt', () => {
    const chunk = buildChunkMesh(gen, -10, 13, 2);
    const n = chunk.segments + 1;
    const skirtDepth = chunk.spacing * 3 + 8;
    for (let i = 0; i < n; i++) {
      const top = i, skirt = n * n + i; // north edge and its skirt copy
      expect(chunk.positions[skirt * 3 + 1]).toBeCloseTo(chunk.positions[top * 3 + 1] - skirtDepth, 5);
      expect(chunk.morph[skirt * 4]).toBeCloseTo(chunk.morph[top * 4] - skirtDepth, 5);
    }
  });
});
