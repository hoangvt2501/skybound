import { describe, expect, it } from 'vitest';
import { WorldGen, createTerrainSample } from '../src/world/WorldGen';
import { buildChunkMesh, sampleHeightGrid, buildVegetation } from '../src/world/chunkMesh';
import { BIOME_COUNT, Biome } from '../src/world/biomes';
import { CHUNK_SIZE, LOD_SPACING, REGION_HALF_SIZE, SHOWCASE_SEED } from '../src/core/config';

describe('WorldGen determinism', () => {
  it('same seed and coordinates produce the same sample regardless of call order', () => {
    const a = new WorldGen(SHOWCASE_SEED);
    const b = new WorldGen(SHOWCASE_SEED);
    const pts: [number, number][] = [
      [0, 0], [1234.5, -987.25], [-15999, 15999], [40000, -40000], [-3.2, 7.9], [512, 512],
    ];
    const sa = createTerrainSample();
    const sb = createTerrainSample();
    // Different visiting orders.
    const ha = pts.map(([x, z]) => a.sample(x, z, sa).height);
    const hb = [...pts].reverse().map(([x, z]) => b.sample(x, z, sb).height).reverse();
    expect(ha).toEqual(hb);
    for (const [x, z] of pts) {
      a.sample(x, z, sa);
      b.sample(x, z, sb);
      expect(Array.from(sa.weights)).toEqual(Array.from(sb.weights));
      expect(sa.biome).toBe(sb.biome);
    }
  });

  it('different seeds produce different worlds', () => {
    const a = new WorldGen(1);
    const b = new WorldGen(2);
    let diff = 0;
    for (let i = 0; i < 50; i++) {
      const x = i * 733.3 - 8000, z = i * 311.7 - 6000;
      if (Math.abs(a.heightAt(x, z) - b.heightAt(x, z)) > 0.01) diff++;
    }
    expect(diff).toBeGreaterThan(40);
  });

  it('chunk meshes are identical regardless of generation order (incl. negative coords)', () => {
    const gen = new WorldGen(SHOWCASE_SEED);
    const order1 = [[-1, -1], [0, 0], [3, -2]] as const;
    const first = order1.map(([cx, cz]) => buildChunkMesh(gen, cx, cz, 1, 1));
    const gen2 = new WorldGen(SHOWCASE_SEED);
    const second = [...order1].reverse().map(([cx, cz]) => buildChunkMesh(gen2, cx, cz, 1, 1)).reverse();
    for (let i = 0; i < first.length; i++) {
      expect(first[i].positions).toEqual(second[i].positions);
      expect(first[i].colors).toEqual(second[i].colors);
      expect(first[i].trees).toEqual(second[i].trees);
    }
  });

  it('vegetation for a chunk is deterministic and lands on terrain', () => {
    const gen = new WorldGen(SHOWCASE_SEED);
    const t1 = buildVegetation(gen, -2, 3, 1);
    const t2 = buildVegetation(gen, -2, 3, 1);
    expect(t1).toEqual(t2);
    for (let i = 0; i < t1.length; i += 6) {
      const h = gen.heightAt(t1[i], t1[i + 2]);
      expect(Math.abs(h - t1[i + 1])).toBeLessThan(1e-3);
    }
  });
});

describe('Chunk seams', () => {
  const gen = new WorldGen(SHOWCASE_SEED);

  function edgeHeights(m: ReturnType<typeof buildChunkMesh>, edge: 'east' | 'west' | 'north' | 'south'): number[] {
    const n = m.segments + 1;
    const out: number[] = [];
    for (let k = 0; k < n; k++) {
      let vi: number;
      if (edge === 'west') vi = k * n;
      else if (edge === 'east') vi = k * n + (n - 1);
      else if (edge === 'north') vi = k;
      else vi = (n - 1) * n + k;
      out.push(m.positions[vi * 3 + 1]);
    }
    return out;
  }

  it('adjacent chunks at the same LOD share exact edge heights (negative coordinates)', () => {
    for (const lod of [0, 2]) {
      const a = buildChunkMesh(gen, -1, -1, lod, 0);
      const b = buildChunkMesh(gen, 0, -1, lod, 0);
      const c = buildChunkMesh(gen, -1, 0, lod, 0);
      expect(edgeHeights(a, 'east')).toEqual(edgeHeights(b, 'west'));
      expect(edgeHeights(a, 'south')).toEqual(edgeHeights(c, 'north'));
    }
  });

  it('coarser LOD edge vertices coincide with every other finer LOD edge vertex', () => {
    const fine = buildChunkMesh(gen, -3, 2, 0, 0);
    const coarse = buildChunkMesh(gen, -2, 2, 1, 0);
    const fe = edgeHeights(fine, 'east');
    const ce = edgeHeights(coarse, 'west');
    const ratio = LOD_SPACING[1] / LOD_SPACING[0];
    for (let k = 0; k < ce.length; k++) {
      expect(ce[k]).toBeCloseTo(fe[k * ratio], 5);
    }
  });

  it('height grid interpolation reproduces the rendered triangle surface', () => {
    const m = buildChunkMesh(gen, 1, 1, 0, 0);
    // At vertices, interpolation equals the vertex height exactly.
    const n = m.segments + 1;
    for (const [i, j] of [[0, 0], [5, 7], [m.segments, m.segments], [3, m.segments]]) {
      const h = sampleHeightGrid(m.heights, m.segments, m.spacing, i * m.spacing, j * m.spacing);
      expect(h).toBeCloseTo(m.heights[j * n + i], 3);
    }
    // Mid-edge points are linear interpolations of the two edge vertices.
    const hMid = sampleHeightGrid(m.heights, m.segments, m.spacing, 2.5 * m.spacing, 0);
    expect(hMid).toBeCloseTo((m.heights[2] + m.heights[3]) / 2, 5);
    // Interior point lies within the min/max of its quad.
    const q = [m.heights[4 * n + 4], m.heights[4 * n + 5], m.heights[5 * n + 4], m.heights[5 * n + 5]];
    const hi = sampleHeightGrid(m.heights, m.segments, m.spacing, 4.3 * m.spacing, 4.6 * m.spacing);
    expect(hi).toBeGreaterThanOrEqual(Math.min(...q) - 1e-6);
    expect(hi).toBeLessThanOrEqual(Math.max(...q) + 1e-6);
  });
});

describe('Showcase region content', () => {
  it('contains all six land biome families plus ocean inside the 32 km region', () => {
    const gen = new WorldGen(SHOWCASE_SEED);
    const counts = new Array(BIOME_COUNT).fill(0);
    const s = createTerrainSample();
    const step = 400;
    let minH = Infinity, maxH = -Infinity, total = 0;
    const t0 = performance.now();
    for (let z = -REGION_HALF_SIZE; z < REGION_HALF_SIZE; z += step) {
      for (let x = -REGION_HALF_SIZE; x < REGION_HALF_SIZE; x += step) {
        gen.sample(x, z, s);
        counts[s.biome]++;
        total++;
        if (s.height < minH) minH = s.height;
        if (s.height > maxH) maxH = s.height;
      }
    }
    const dt = performance.now() - t0;
    const share = counts.map((c, i) => `${['temperate', 'alpine', 'coast', 'arid', 'wetland', 'upland', 'ocean'][i]}=${((100 * c) / total).toFixed(1)}%`).join(' ');
    // eslint-disable-next-line no-console
    console.log(`[world] seed ${SHOWCASE_SEED}: ${share}; height ${minH.toFixed(0)}..${maxH.toFixed(0)} m; ${(1000 * dt / total).toFixed(2)} us/sample`);
    for (const b of [Biome.Temperate, Biome.Alpine, Biome.Coast, Biome.Arid, Biome.Wetland, Biome.Upland, Biome.Ocean]) {
      expect(counts[b] / total).toBeGreaterThan(0.015);
    }
    expect(maxH).toBeGreaterThan(900);
    expect(minH).toBeLessThan(-5);
  });

  it('chunk size and LOD spacings divide evenly', () => {
    for (const s of LOD_SPACING) expect(CHUNK_SIZE % s).toBe(0);
  });
});
