/**
 * Full-screen world map overlay: pan, zoom (wheel/pinch), recenter, legend,
 * coordinates, landmark journal, click-to-place waypoint. Simulation is
 * paused by the app while open.
 */
import { REGION_HALF_SIZE } from '../core/config';
import type { Navigation } from '../core/Navigation';
import { BIOMES } from '../world/biomes';
import { formatDistance, headingDegrees } from '../world/coords';
import type { Landmark } from '../world/Landmarks';
import { mapToWorld, panBy, pointerToLocal, worldToMap, zoomAround, type MapView } from './projection';
import type { TileCache } from './TileCache';

export interface WorldMapPlayer {
  x: number;
  z: number;
  heading: number;
}

export interface WorldMapOptions {
  nav: Navigation;
  landmarks: Landmark[];
  getPlayer: () => WorldMapPlayer;
  onClose: () => void;
  onWaypointSet: (x: number, z: number, landmarkId: string | null) => void;
  onWaypointClear: () => void;
}

const MIN_MPP = 2;
const MAX_MPP = 160;

export class WorldMap {
  readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tiles: TileCache;
  private opts: WorldMapOptions;
  private view: MapView = { centerX: 0, centerZ: 0, metersPerPixel: 64, width: 800, height: 600 };
  private open = false;
  private raf = 0;
  private pointers = new Map<number, { x: number; y: number }>();
  private dragStart: { x: number; y: number; cx: number; cz: number } | null = null;
  private moved = false;
  private pinchDist = 0;
  private hoverText: HTMLElement;
  private journal: HTMLElement;
  private wpInfo: HTMLElement;
  private selectedLandmark: string | null = null;
  private resizeObs: ResizeObserver | null = null;

  constructor(container: HTMLElement, tiles: TileCache, opts: WorldMapOptions) {
    this.tiles = tiles;
    this.opts = opts;
    this.root = document.createElement('div');
    this.root.className = 'worldmap';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="worldmap-top">
        <div class="worldmap-title">World map</div>
        <div class="worldmap-coords" aria-live="off"></div>
        <div class="worldmap-actions">
          <button class="btn" data-action="recenter" title="Center on bird">Center on bird</button>
          <button class="btn" data-action="clear" title="Clear waypoint">Clear waypoint</button>
          <button class="btn btn-primary" data-action="close" title="Close (M / Esc)">Close</button>
        </div>
      </div>
      <div class="worldmap-body">
        <canvas class="worldmap-canvas" aria-label="World map"></canvas>
        <aside class="worldmap-side">
          <div class="worldmap-wp"></div>
          <h3>Journal</h3>
          <div class="worldmap-journal"></div>
          <h3>Legend</h3>
          <div class="worldmap-legend"></div>
          <p class="worldmap-hint">Click or tap the map to set a waypoint. Drag to pan, scroll or pinch to zoom.</p>
        </aside>
      </div>`;
    container.appendChild(this.root);
    this.canvas = this.root.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.hoverText = this.root.querySelector('.worldmap-coords')!;
    this.journal = this.root.querySelector('.worldmap-journal')!;
    this.wpInfo = this.root.querySelector('.worldmap-wp')!;
    const legend = this.root.querySelector('.worldmap-legend')!;
    for (const b of BIOMES) {
      const row = document.createElement('div');
      row.className = 'legend-row';
      row.innerHTML = `<span class="legend-swatch" style="background: rgb(${b.mapColor.join(',')})"></span><span>${b.name}</span>`;
      legend.appendChild(row);
    }
    const extra = document.createElement('div');
    extra.className = 'legend-row';
    extra.innerHTML = `<span class="legend-swatch legend-lm"></span><span>Discovered landmark</span>`;
    legend.appendChild(extra);
    const extra2 = document.createElement('div');
    extra2.className = 'legend-row';
    extra2.innerHTML = `<span class="legend-swatch legend-wp"></span><span>Waypoint</span>`;
    legend.appendChild(extra2);

    this.root.querySelector('[data-action="close"]')!.addEventListener('click', () => this.opts.onClose());
    this.root.querySelector('[data-action="recenter"]')!.addEventListener('click', () => this.recenter());
    this.root.querySelector('[data-action="clear"]')!.addEventListener('click', () => this.opts.onWaypointClear());

    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    c.addEventListener('pointermove', (e) => this.onPointerMove(e));
    c.addEventListener('pointerup', (e) => this.onPointerUp(e));
    c.addEventListener('pointercancel', (e) => this.onPointerCancel(e));
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = pointerToLocal(c, e.clientX, e.clientY);
      zoomAround(this.view, Math.exp(e.deltaY * 0.0015), p.px, p.py, MIN_MPP, MAX_MPP);
      this.requestDraw();
    }, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    this.opts.nav.onChange(() => { if (this.open) { this.renderJournal(); this.requestDraw(); } });
    this.tiles.onTileReady = () => { if (this.open) this.requestDraw(); };
  }

  get isOpen(): boolean {
    return this.open;
  }

  private layout(): void {
    const body = this.root.querySelector<HTMLElement>('.worldmap-body')!;
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(200, Math.floor(rect.width)), h = Math.max(200, Math.floor(rect.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.view.width = w;
    this.view.height = h;
    void body;
  }

  /** Frame the 32 km region. */
  frameRegion(): void {
    this.layout();
    const span = REGION_HALF_SIZE * 2 * 1.08;
    this.view.metersPerPixel = Math.min(MAX_MPP, Math.max(MIN_MPP, span / Math.min(this.view.width, this.view.height)));
    this.view.centerX = 0;
    this.view.centerZ = 0;
  }

  recenter(): void {
    const p = this.opts.getPlayer();
    this.view.centerX = p.x;
    this.view.centerZ = p.z;
    this.requestDraw();
  }

  show(firstTime: boolean): void {
    this.root.hidden = false;
    this.open = true;
    this.layout();
    if (firstTime) this.frameRegion();
    this.renderJournal();
    this.requestDraw();
    if (!this.resizeObs && typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => { this.layout(); this.requestDraw(); });
      this.resizeObs.observe(this.canvas);
    }
  }

  hide(): void {
    this.root.hidden = true;
    this.open = false;
    this.pointers.clear();
    this.dragStart = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private requestDraw(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private onPointerDown(e: PointerEvent): void {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) {
      this.dragStart = { x: e.clientX, y: e.clientY, cx: this.view.centerX, cz: this.view.centerZ };
      this.moved = false;
    } else if (this.pointers.size === 2) {
      const [a, b] = Array.from(this.pointers.values());
      this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      this.dragStart = null;
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const prev = this.pointers.get(e.pointerId);
    if (prev) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = pointerToLocal(this.canvas, e.clientX, e.clientY);
    const w = mapToWorld(p.px, p.py, this.view);
    this.hoverText.textContent = `x ${Math.round(w.x)}  z ${Math.round(w.z)}  ·  ${this.view.metersPerPixel.toFixed(1)} m/px`;
    if (this.pointers.size === 2) {
      const [a, b] = Array.from(this.pointers.values());
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinchDist > 0 && d > 0) {
        const mid = pointerToLocal(this.canvas, (a.x + b.x) / 2, (a.y + b.y) / 2);
        zoomAround(this.view, this.pinchDist / d, mid.px, mid.py, MIN_MPP, MAX_MPP);
        this.pinchDist = d;
        this.moved = true;
        this.requestDraw();
      }
      return;
    }
    if (this.dragStart && prev) {
      const dx = e.clientX - this.dragStart.x, dy = e.clientY - this.dragStart.y;
      if (Math.hypot(dx, dy) > 4) this.moved = true;
      if (this.moved) {
        this.view.centerX = this.dragStart.cx;
        this.view.centerZ = this.dragStart.cz;
        panBy(this.view, dx, dy);
        this.requestDraw();
      }
    }
  }

  private onPointerUp(e: PointerEvent): void {
    const had = this.pointers.has(e.pointerId);
    this.pointers.delete(e.pointerId);
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (had && !this.moved && this.pointers.size === 0 && e.button === 0) {
      const p = pointerToLocal(this.canvas, e.clientX, e.clientY);
      // Landmark hit test first.
      const hit = this.hitLandmark(p.px, p.py);
      if (hit) {
        this.selectedLandmark = hit.id;
        this.opts.onWaypointSet(hit.x, hit.z, hit.id);
      } else {
        const w = mapToWorld(p.px, p.py, this.view);
        this.selectedLandmark = null;
        this.opts.onWaypointSet(w.x, w.z, null);
      }
    }
    if (this.pointers.size === 0) this.dragStart = null;
    if (this.pointers.size === 1) {
      const [a] = Array.from(this.pointers.values());
      this.dragStart = { x: a.x, y: a.y, cx: this.view.centerX, cz: this.view.centerZ };
    }
  }

  private onPointerCancel(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    this.dragStart = null;
  }

  private hitLandmark(px: number, py: number): Landmark | null {
    let best: Landmark | null = null, bestD = 14;
    for (const lm of this.opts.landmarks) {
      if (!this.opts.nav.isDiscovered(lm.id)) continue;
      const q = worldToMap(lm.x, lm.z, this.view);
      const d = Math.hypot(q.px - px, q.py - py);
      if (d < bestD) { bestD = d; best = lm; }
    }
    return best;
  }

  private renderJournal(): void {
    const nav = this.opts.nav;
    const discovered = this.opts.landmarks.filter((l) => nav.isDiscovered(l.id));
    const total = this.opts.landmarks.length;
    if (discovered.length === 0) {
      this.journal.innerHTML = `<p class="muted">No landmarks discovered yet (0 / ${total}). Fly close to something interesting.</p>`;
    } else {
      this.journal.innerHTML = `<p class="muted">${discovered.length} / ${total} discovered</p>`;
      for (const lm of discovered) {
        const b = document.createElement('button');
        b.className = 'journal-item' + (nav.waypoint?.landmarkId === lm.id ? ' active' : '');
        b.innerHTML = `<strong>${lm.name}</strong><span>${lm.blurb}</span>`;
        b.title = 'Set as destination';
        b.addEventListener('click', () => {
          this.selectedLandmark = lm.id;
          this.opts.onWaypointSet(lm.x, lm.z, lm.id);
          this.view.centerX = lm.x;
          this.view.centerZ = lm.z;
          this.requestDraw();
        });
        this.journal.appendChild(b);
      }
    }
    const p = this.opts.getPlayer();
    const wp = nav.toWaypoint(p.x, p.z);
    if (nav.waypoint && wp) {
      const lm = nav.waypoint.landmarkId ? this.opts.landmarks.find((l) => l.id === nav.waypoint!.landmarkId) : null;
      this.wpInfo.innerHTML = `<strong>Waypoint</strong><div>${lm ? lm.name : `x ${Math.round(nav.waypoint.x)}, z ${Math.round(nav.waypoint.z)}`}</div><div>${formatDistance(wp.distance)} · bearing ${Math.round(headingDegrees(wp.bearing))}°</div>`;
    } else {
      this.wpInfo.innerHTML = `<strong>Waypoint</strong><div class="muted">None set</div>`;
    }
  }

  draw(): void {
    if (!this.open) return;
    this.layout();
    const v = this.view;
    const ctx = this.ctx;
    const dpr = this.canvas.width / v.width;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#16232b';
    ctx.fillRect(0, 0, v.width, v.height);
    const p = this.opts.getPlayer();
    this.tiles.draw(ctx, v, p.x, p.z);

    // Unexplored veil: muted overlay on cells not yet visited (cheap: only when zoomed in enough).
    const cell = 500;
    if (v.metersPerPixel <= 40) {
      const halfW = (v.width / 2) * v.metersPerPixel, halfH = (v.height / 2) * v.metersPerPixel;
      const cx0 = Math.floor((v.centerX - halfW) / cell), cx1 = Math.floor((v.centerX + halfW) / cell);
      const cz0 = Math.floor((v.centerZ - halfH) / cell), cz1 = Math.floor((v.centerZ + halfH) / cell);
      ctx.fillStyle = 'rgba(10, 16, 22, 0.38)';
      const pw = cell / v.metersPerPixel;
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          if (this.opts.nav.isExploredCell(cx, cz)) continue;
          const q = worldToMap(cx * cell, cz * cell, v);
          ctx.fillRect(q.px, q.py, pw + 0.5, pw + 0.5);
        }
      }
    }

    // Region outline.
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 6]);
    const a = worldToMap(-REGION_HALF_SIZE, -REGION_HALF_SIZE, v);
    const b = worldToMap(REGION_HALF_SIZE, REGION_HALF_SIZE, v);
    ctx.strokeRect(a.px, a.py, b.px - a.px, b.py - a.py);
    ctx.setLineDash([]);

    // Grid every 4 km with labels when zoomed out.
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    const g = v.metersPerPixel > 20 ? 4000 : v.metersPerPixel > 6 ? 1000 : 500;
    const halfW = (v.width / 2) * v.metersPerPixel, halfH = (v.height / 2) * v.metersPerPixel;
    for (let x = Math.floor((v.centerX - halfW) / g) * g; x <= v.centerX + halfW; x += g) {
      const q = worldToMap(x, 0, v);
      ctx.beginPath(); ctx.moveTo(q.px, 0); ctx.lineTo(q.px, v.height); ctx.stroke();
    }
    for (let z = Math.floor((v.centerZ - halfH) / g) * g; z <= v.centerZ + halfH; z += g) {
      const q = worldToMap(0, z, v);
      ctx.beginPath(); ctx.moveTo(0, q.py); ctx.lineTo(v.width, q.py); ctx.stroke();
    }

    // Landmarks (discovered only; undiscovered stay hidden).
    ctx.font = '12px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const lm of this.opts.landmarks) {
      if (!this.opts.nav.isDiscovered(lm.id)) continue;
      const q = worldToMap(lm.x, lm.z, v);
      if (q.px < -20 || q.py < -20 || q.px > v.width + 20 || q.py > v.height + 20) continue;
      ctx.fillStyle = this.selectedLandmark === lm.id ? '#ffe9a8' : '#ffd166';
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(q.px, q.py - 7); ctx.lineTo(q.px + 7, q.py); ctx.lineTo(q.px, q.py + 7); ctx.lineTo(q.px - 7, q.py);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      if (v.metersPerPixel < 60) {
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        const w = ctx.measureText(lm.name).width + 8;
        ctx.fillRect(q.px + 10, q.py - 8, w, 16);
        ctx.fillStyle = '#fff';
        ctx.fillText(lm.name, q.px + 14, q.py);
      }
    }

    // Waypoint + line from player.
    const nav = this.opts.nav;
    const pp = worldToMap(p.x, p.z, v);
    if (nav.waypoint) {
      const q = worldToMap(nav.waypoint.x, nav.waypoint.z, v);
      ctx.strokeStyle = 'rgba(255,93,93,0.8)';
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(pp.px, pp.py); ctx.lineTo(q.px, q.py); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#ff5d5d';
      ctx.strokeStyle = '#fff';
      ctx.beginPath(); ctx.arc(q.px, q.py, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(q.px, q.py, 2.5, 0, Math.PI * 2); ctx.fill();
    }

    // Player.
    ctx.save();
    ctx.translate(pp.px, pp.py);
    ctx.rotate(p.heading);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(7, 8); ctx.lineTo(0, 4); ctx.lineTo(-7, 8); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();

    // Compass + scale.
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(10, 10, 26, 26);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', 23, 23);
    ctx.textAlign = 'left';
    const target = 140 * v.metersPerPixel;
    const nice = [100, 250, 500, 1000, 2000, 5000, 10000].reduce((best, n) => (Math.abs(n - target) < Math.abs(best - target) ? n : best), 100);
    const barW = nice / v.metersPerPixel;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(10, v.height - 30, barW + 16, 20);
    ctx.fillStyle = '#fff';
    ctx.fillRect(18, v.height - 16, barW, 3);
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, 18, v.height - 22);
    this.renderJournalDistance();
  }

  private renderJournalDistance(): void {
    // Keep waypoint info current without rebuilding the journal.
    const nav = this.opts.nav;
    const p = this.opts.getPlayer();
    const wp = nav.toWaypoint(p.x, p.z);
    const line = this.wpInfo.querySelector('div:last-child');
    if (nav.waypoint && wp && line && this.wpInfo.children.length > 2) {
      line.textContent = `${formatDistance(wp.distance)} · bearing ${Math.round(headingDegrees(wp.bearing))}°`;
    }
  }
}
