/**
 * Corner minimap: north-up, cached terrain tiles, rotating player marker,
 * discovered landmarks, waypoint, compass and scale bar. Dynamic markers
 * redraw at ~10 Hz; terrain comes from the shared TileCache.
 */
import { REGION_HALF_SIZE } from '../core/config';
import type { Navigation } from '../core/Navigation';
import type { Landmark } from '../world/Landmarks';
import { worldToMap, type MapView } from './projection';
import type { TileCache } from './TileCache';

export interface MinimapPlayer {
  x: number;
  z: number;
  heading: number;
}

export interface MinimapOptions {
  getPlayer: () => MinimapPlayer;
  getLandmarks: () => Landmark[];
  nav: Navigation;
  onOpenMap: () => void;
  onZoomChange?: (level: number) => void;
}

const ZOOM_MPP = [6, 12, 24, 48]; // meters per CSS pixel per zoom level

export class Minimap {
  readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tiles: TileCache;
  private opts: MinimapOptions;
  private zoomLevel = 1;
  private lastDraw = -1;
  private size = 176;
  private view: MapView;
  private dirty = true;

  constructor(container: HTMLElement, tiles: TileCache, opts: MinimapOptions, zoomLevel = 1) {
    this.tiles = tiles;
    this.opts = opts;
    this.zoomLevel = Math.min(ZOOM_MPP.length - 1, Math.max(0, Math.round(zoomLevel)));
    this.root = document.createElement('div');
    this.root.className = 'minimap';
    this.root.innerHTML = `
      <canvas class="minimap-canvas" aria-label="Minimap"></canvas>
      <div class="minimap-compass" aria-hidden="true">N</div>
      <div class="minimap-scale"><span class="minimap-scale-bar"></span><span class="minimap-scale-label"></span></div>
      <div class="minimap-buttons">
        <button class="mm-btn" data-action="zoom-in" title="Zoom minimap in" aria-label="Zoom minimap in">+</button>
        <button class="mm-btn" data-action="zoom-out" title="Zoom minimap out" aria-label="Zoom minimap out">−</button>
        <button class="mm-btn mm-map" data-action="open-map" title="Open world map (M)" aria-label="Open world map">Map</button>
      </div>`;
    container.appendChild(this.root);
    this.canvas = this.root.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.view = { centerX: 0, centerZ: 0, metersPerPixel: ZOOM_MPP[this.zoomLevel], width: this.size, height: this.size };
    this.root.querySelector('[data-action="zoom-in"]')!.addEventListener('click', (e) => { e.stopPropagation(); this.zoom(-1); });
    this.root.querySelector('[data-action="zoom-out"]')!.addEventListener('click', (e) => { e.stopPropagation(); this.zoom(1); });
    this.root.querySelector('[data-action="open-map"]')!.addEventListener('click', (e) => { e.stopPropagation(); this.opts.onOpenMap(); });
    this.canvas.addEventListener('click', () => this.opts.onOpenMap());
    this.tiles.onTileReady = () => { this.dirty = true; };
    this.resize();
  }

  private zoom(delta: number): void {
    this.zoomLevel = Math.min(ZOOM_MPP.length - 1, Math.max(0, this.zoomLevel + delta));
    this.view.metersPerPixel = ZOOM_MPP[this.zoomLevel];
    this.dirty = true;
    this.opts.onZoomChange?.(this.zoomLevel);
  }

  get zoomIndex(): number {
    return this.zoomLevel;
  }

  resize(): void {
    const small = window.innerWidth < 640;
    this.size = small ? 128 : 176;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.size * dpr);
    this.canvas.height = Math.round(this.size * dpr);
    this.canvas.style.width = `${this.size}px`;
    this.canvas.style.height = `${this.size}px`;
    this.view.width = this.size;
    this.view.height = this.size;
    this.dirty = true;
  }

  setVisible(v: boolean): void {
    this.root.hidden = !v;
  }

  /** Redraw at ~10 Hz. */
  update(now: number): void {
    if (!this.dirty && now - this.lastDraw < 0.1) return;
    this.lastDraw = now;
    this.dirty = false;
    const p = this.opts.getPlayer();
    const v = this.view;
    v.centerX = p.x;
    v.centerZ = p.z;
    const ctx = this.ctx;
    const dpr = this.canvas.width / this.size;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    // Circular clip.
    ctx.beginPath();
    ctx.arc(this.size / 2, this.size / 2, this.size / 2 - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#1b2830';
    ctx.fillRect(0, 0, this.size, this.size);
    this.tiles.draw(ctx, v, p.x, p.z);

    // Region boundary.
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    const a = worldToMap(-REGION_HALF_SIZE, -REGION_HALF_SIZE, v);
    const b = worldToMap(REGION_HALF_SIZE, REGION_HALF_SIZE, v);
    ctx.strokeRect(a.px, a.py, b.px - a.px, b.py - a.py);
    ctx.setLineDash([]);

    // Discovered landmarks.
    const nav = this.opts.nav;
    for (const lm of this.opts.getLandmarks()) {
      if (!nav.isDiscovered(lm.id)) continue;
      const q = worldToMap(lm.x, lm.z, v);
      if (q.px < -8 || q.py < -8 || q.px > this.size + 8 || q.py > this.size + 8) continue;
      ctx.fillStyle = '#ffd166';
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath();
      ctx.moveTo(q.px, q.py - 5);
      ctx.lineTo(q.px + 5, q.py);
      ctx.lineTo(q.px, q.py + 5);
      ctx.lineTo(q.px - 5, q.py);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // Waypoint marker (clamped to the rim with an arrow when off-map).
    if (nav.waypoint) {
      const q = worldToMap(nav.waypoint.x, nav.waypoint.z, v);
      const cx = this.size / 2, cy = this.size / 2;
      const dx = q.px - cx, dy = q.py - cy;
      const dist = Math.hypot(dx, dy);
      const r = this.size / 2 - 10;
      let px = q.px, py = q.py;
      if (dist > r) {
        px = cx + (dx / dist) * r;
        py = cy + (dy / dist) * r;
      }
      ctx.strokeStyle = '#ffffff';
      ctx.fillStyle = '#ff5d5d';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(px, py, 2, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }

    // Player marker (rotates with heading; north up).
    const cx = this.size / 2, cy = this.size / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(p.heading);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(6, 7);
    ctx.lineTo(0, 3.5);
    ctx.lineTo(-6, 7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    ctx.restore();

    // Rim.
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(this.size / 2, this.size / 2, this.size / 2 - 1, 0, Math.PI * 2);
    ctx.stroke();

    // Scale bar: pick a round length.
    const target = this.size * 0.3 * v.metersPerPixel;
    const nice = [100, 200, 500, 1000, 2000, 5000].reduce((best, n) => (Math.abs(n - target) < Math.abs(best - target) ? n : best), 100);
    const bar = this.root.querySelector<HTMLElement>('.minimap-scale-bar')!;
    const label = this.root.querySelector<HTMLElement>('.minimap-scale-label')!;
    bar.style.width = `${nice / v.metersPerPixel}px`;
    label.textContent = nice >= 1000 ? `${nice / 1000} km` : `${nice} m`;
  }
}
