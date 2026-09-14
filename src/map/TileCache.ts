/**
 * Bounded LRU cache of rasterized map tiles, generated in the terrain worker
 * pool. Draws the best available tiles for a MapView with coarser fallbacks
 * while finer tiles are still pending.
 */
import type { WorkerPool } from '../workers/WorkerPool';
import type { WorkerResponse } from '../workers/terrain.worker';
import { MAX_ZOOM, TILE_MPP, TILE_PX, tileKey, tileSizeMeters } from './tileRaster';
import type { MapView } from './projection';

interface TileRecord {
  key: string;
  zoom: number;
  tx: number;
  tz: number;
  canvas: HTMLCanvasElement | null;
  requestId: number;
  lastUsed: number;
}

export class TileCache {
  private tiles = new Map<string, TileRecord>();
  private pool: WorkerPool;
  private maxTiles: number;
  private maxPending: number;
  private tick = 0;
  private pendingCount = 0;
  onTileReady: (() => void) | null = null;

  constructor(pool: WorkerPool, maxTiles = 220, maxPending = 6) {
    this.pool = pool;
    this.maxTiles = maxTiles;
    this.maxPending = maxPending;
    pool.onMessage((m) => this.onMessage(m));
    pool.onDrop((req) => {
      if (req.type !== 'tile') return;
      const rec = this.tiles.get(tileKey(req.zoom, req.tx, req.tz));
      if (rec && rec.requestId === req.id) {
        rec.requestId = 0;
        this.pendingCount = Math.max(0, this.pendingCount - 1);
      }
    });
  }

  get pending(): number {
    return this.pendingCount;
  }
  get size(): number {
    return this.tiles.size;
  }

  private onMessage(msg: WorkerResponse): void {
    if (msg.type !== 'tile') return;
    const key = tileKey(msg.zoom, msg.tx, msg.tz);
    const rec = this.tiles.get(key);
    if (!rec || rec.requestId !== msg.id) return;
    rec.requestId = 0;
    this.pendingCount = Math.max(0, this.pendingCount - 1);
    const canvas = document.createElement('canvas');
    canvas.width = TILE_PX;
    canvas.height = TILE_PX;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(TILE_PX, TILE_PX);
    img.data.set(msg.pixels);
    ctx.putImageData(img, 0, 0);
    rec.canvas = canvas;
    this.onTileReady?.();
  }

  /** Choose the tile zoom for a view: tiles are drawn at 0.5x..1.5x. */
  zoomFor(metersPerPixel: number): number {
    let z = 0;
    for (let i = 0; i <= MAX_ZOOM; i++) {
      if (TILE_MPP[i] >= metersPerPixel * 0.7) z = i;
    }
    return z;
  }

  /** Get a tile canvas if ready; request it otherwise. */
  get(zoom: number, tx: number, tz: number, priority: number): HTMLCanvasElement | null {
    const key = tileKey(zoom, tx, tz);
    let rec = this.tiles.get(key);
    this.tick++;
    if (!rec) {
      rec = { key, zoom, tx, tz, canvas: null, requestId: 0, lastUsed: this.tick };
      this.tiles.set(key, rec);
      this.evict();
    }
    rec.lastUsed = this.tick;
    if (!rec.canvas && rec.requestId === 0 && this.pendingCount < this.maxPending) {
      const id = this.pool.allocId();
      rec.requestId = id;
      if (this.pool.enqueue({ type: 'tile', id, zoom, tx, tz }, priority)) this.pendingCount++;
      else rec.requestId = 0;
    }
    return rec.canvas;
  }

  private evict(): void {
    if (this.tiles.size <= this.maxTiles) return;
    const list = Array.from(this.tiles.values()).filter((t) => t.requestId === 0);
    list.sort((a, b) => a.lastUsed - b.lastUsed);
    const n = this.tiles.size - this.maxTiles;
    for (let i = 0; i < n && i < list.length; i++) this.tiles.delete(list[i].key);
  }

  /**
   * Draw all tiles covering the view. `ctx` must already be scaled for DPR
   * so that 1 unit = 1 CSS pixel.
   */
  draw(ctx: CanvasRenderingContext2D, view: MapView, focusX: number, focusZ: number): void {
    const zoom = this.zoomFor(view.metersPerPixel);
    const size = tileSizeMeters(zoom);
    const halfW = (view.width / 2) * view.metersPerPixel;
    const halfH = (view.height / 2) * view.metersPerPixel;
    const x0 = Math.floor((view.centerX - halfW) / size), x1 = Math.floor((view.centerX + halfW) / size);
    const z0 = Math.floor((view.centerZ - halfH) / size), z1 = Math.floor((view.centerZ + halfH) / size);
    // Cap the amount of tiles per draw to keep bounded work.
    const maxTiles = 64;
    let count = 0;
    for (let tz = z0; tz <= z1; tz++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (count++ > maxTiles) return;
        const cx = (tx + 0.5) * size, cz = (tz + 0.5) * size;
        const priority = 50 + Math.hypot(cx - focusX, cz - focusZ) / size;
        const canvas = this.get(zoom, tx, tz, priority);
        const px = (tx * size - view.centerX) / view.metersPerPixel + view.width / 2;
        const py = (tz * size - view.centerZ) / view.metersPerPixel + view.height / 2;
        const pw = size / view.metersPerPixel;
        if (canvas) {
          ctx.drawImage(canvas, px, py, pw + 0.5, pw + 0.5);
        } else {
          // Fallback: coarser tiles that are ready.
          let drawn = false;
          for (let z = zoom - 1; z >= 0 && !drawn; z--) {
            const s2 = tileSizeMeters(z);
            const ptx = Math.floor((tx * size) / s2), ptz = Math.floor((tz * size) / s2);
            const parent = this.tiles.get(tileKey(z, ptx, ptz))?.canvas;
            if (parent) {
              const sub = size / s2; // fraction of parent
              const ox = ((tx * size) / s2 - ptx) * TILE_PX;
              const oy = ((tz * size) / s2 - ptz) * TILE_PX;
              ctx.drawImage(parent, ox, oy, TILE_PX * sub, TILE_PX * sub, px, py, pw + 0.5, pw + 0.5);
              drawn = true;
            }
          }
          if (!drawn) {
            // Stable loading placeholder: neutral fill with a faint hatch.
            ctx.fillStyle = '#243440';
            ctx.fillRect(px, py, pw + 0.5, pw + 0.5);
            ctx.save();
            ctx.beginPath();
            ctx.rect(px, py, pw, pw);
            ctx.clip();
            ctx.strokeStyle = 'rgba(255,255,255,0.05)';
            ctx.lineWidth = 1;
            for (let k = -pw; k < pw; k += 14) {
              ctx.beginPath();
              ctx.moveTo(px + k, py + pw);
              ctx.lineTo(px + k + pw, py);
              ctx.stroke();
            }
            ctx.restore();
          }
        }
      }
    }
  }

  clear(): void {
    this.tiles.clear();
    this.pendingCount = 0;
  }
}
