/**
 * Terrain worker: builds chunk meshes, far-shell tiles and map tiles off the
 * main thread. Results carry the request id so the main thread can discard
 * stale results.
 */
import { WorldGen } from '../world/WorldGen';
import { buildChunkMesh, buildFarTile } from '../world/chunkMesh';
import { rasterizeTile } from '../map/tileRaster';

export type WorkerRequest =
  | { type: 'init'; seed: number }
  | { type: 'chunk'; id: number; cx: number; cz: number; lod: number; cover: number }
  | { type: 'far'; id: number; tx: number; tz: number }
  | { type: 'tile'; id: number; zoom: number; tx: number; tz: number };

export type WorkerResponse =
  | { type: 'ready' }
  | {
      type: 'chunk';
      id: number;
      cx: number;
      cz: number;
      lod: number;
      positions: Float32Array;
      normals: Float32Array;
      colors: Float32Array;
      aux: Float32Array;
      indices: Uint32Array;
      heights: Float32Array;
      segments: number;
      spacing: number;
      minHeight: number;
      maxHeight: number;
      hasWater: boolean;
      trees: Float32Array;
      cover: Float32Array;
    }
  | {
      type: 'far';
      id: number;
      tx: number;
      tz: number;
      positions: Float32Array;
      normals: Float32Array;
      colors: Float32Array;
      aux: Float32Array;
      indices: Uint32Array;
    }
  | { type: 'tile'; id: number; zoom: number; tx: number; tz: number; pixels: Uint8ClampedArray };

let gen: WorldGen | null = null;
const ctx = self as unknown as { postMessage: (msg: WorkerResponse, transfer?: Transferable[]) => void; onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null };

ctx.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    gen = new WorldGen(msg.seed);
    ctx.postMessage({ type: 'ready' });
    return;
  }
  if (!gen) return;
  if (msg.type === 'chunk') {
    const m = buildChunkMesh(gen, msg.cx, msg.cz, msg.lod, msg.cover);
    ctx.postMessage(
      {
        type: 'chunk',
        id: msg.id,
        cx: m.cx,
        cz: m.cz,
        lod: m.lod,
        positions: m.positions,
        normals: m.normals,
        colors: m.colors,
        aux: m.aux,
        indices: m.indices,
        heights: m.heights,
        segments: m.segments,
        spacing: m.spacing,
        minHeight: m.minHeight,
        maxHeight: m.maxHeight,
        hasWater: m.hasWater,
        trees: m.trees,
        cover: m.cover,
      },
      [m.positions.buffer, m.normals.buffer, m.colors.buffer, m.aux.buffer, m.indices.buffer, m.heights.buffer, m.trees.buffer, m.cover.buffer],
    );
  } else if (msg.type === 'far') {
    const m = buildFarTile(gen, msg.tx, msg.tz);
    ctx.postMessage(
      { type: 'far', id: msg.id, tx: m.tx, tz: m.tz, positions: m.positions, normals: m.normals, colors: m.colors, aux: m.aux, indices: m.indices },
      [m.positions.buffer, m.normals.buffer, m.colors.buffer, m.aux.buffer, m.indices.buffer],
    );
  } else if (msg.type === 'tile') {
    const pixels = rasterizeTile(gen, msg.zoom, msg.tx, msg.tz);
    ctx.postMessage({ type: 'tile', id: msg.id, zoom: msg.zoom, tx: msg.tx, tz: msg.tz, pixels }, [pixels.buffer]);
  }
};
