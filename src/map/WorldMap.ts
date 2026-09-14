/**
 * Full-screen world map overlay.
 *
 * Interaction contract:
 *  - Left-drag pans (grab cursor); the maximum movement over the whole
 *    gesture decides click vs drag, so dragging away and back is still a drag.
 *  - A short left click (below CLICK_THRESHOLD_PX) selects a visible landmark
 *    or places the single active waypoint.
 *  - Wheel/trackpad zoom is anchored at the pointer (delta modes normalized,
 *    extreme jumps limited). Wheel over the side panel scrolls the panel.
 *  - Two fingers pan around their midpoint and pinch-zoom; a multi-touch
 *    gesture never places a waypoint.
 *  - +, -, Center on bird (keeps zoom), Fit region, arrow-key panning.
 *  - View center and zoom persist across close/reopen during the session.
 *  - Map gestures never reach the flight input or the 3D camera.
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

export const MIN_MPP = 2;
export const MAX_MPP = 160;
/** Maximum pointer movement (CSS px) for a gesture to count as a click. */
export const CLICK_THRESHOLD_PX = 6;
/** Zoom factor per +/- button press. */
const BUTTON_ZOOM = 1.6;

interface PointerState {
  x: number;
  y: number;
  startX: number;
  startY: number;
  button: number;
  type: string;
}

export class WorldMap {
  readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tiles: TileCache;
  private opts: WorldMapOptions;
  private view: MapView = { centerX: 0, centerZ: 0, metersPerPixel: 64, width: 800, height: 600 };
  private open = false;
  private raf = 0;
  private pointers = new Map<number, PointerState>();
  /** Max distance from the gesture start over the whole gesture. */
  private maxMove = 0;
  private multiTouch = false;
  private gestureActive = false;
  private panAnchor: { cx: number; cz: number; px: number; py: number } | null = null;
  private pinchDist = 0;
  private hoverText: HTMLElement;
  private journal: HTMLElement;
  private wpInfo: HTMLElement;
  private selectedLandmark: string | null = null;
  private resizeObs: ResizeObserver | null = null;
  private framed = false;
  private labelBoxes: { x: number; y: number; w: number; h: number }[] = [];
  private disposeFns: (() => void)[] = [];

  constructor(container: HTMLElement, tiles: TileCache, opts: WorldMapOptions) {
    this.tiles = tiles;
    this.opts = opts;
    this.root = document.createElement('div');
    this.root.className = 'worldmap';
    this.root.tabIndex = -1;
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="worldmap-top">
        <div class="worldmap-title">World map</div>
        <div class="worldmap-coords" aria-live="off"></div>
        <div class="worldmap-actions">
          <button class="btn" data-action="recenter" title="Center on bird (keeps zoom)">Center on bird</button>
          <button class="btn" data-action="fit" title="Fit the 32 km region">Fit region</button>
          <button class="btn" data-action="clear" title="Clear waypoint">Clear waypoint</button>
          <button class="btn btn-primary" data-action="close" title="Close (M / Esc)">Close</button>
        </div>
      </div>
      <div class="worldmap-body">
        <div class="worldmap-stage">
          <canvas class="worldmap-canvas" aria-label="World map"></canvas>
          <div class="worldmap-zoom">
            <button class="mm-btn" data-action="zoom-in" title="Zoom in (+)" aria-label="Zoom in">+</button>
            <button class="mm-btn" data-action="zoom-out" title="Zoom out (−)" aria-label="Zoom out">−</button>
            <button class="mm-btn wide" data-action="recenter" title="Center on bird" aria-label="Center on bird">Bird</button>
            <button class="mm-btn wide" data-action="fit" title="Fit region" aria-label="Fit region">Fit</button>
          </div>
        </div>
        <aside class="worldmap-side">
          <div class="worldmap-wp"></div>
          <h3>Journal</h3>
          <div class="worldmap-journal"></div>
          <h3>Legend</h3>
          <div class="worldmap-legend"></div>
          <p class="worldmap-hint">Drag to pan · scroll or pinch to zoom · click or tap to set a waypoint · arrow keys pan.</p>
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
    for (const [cls, label] of [['legend-lm', 'Discovered landmark'], ['legend-wp', 'Waypoint']] as const) {
      const row = document.createElement('div');
      row.className = 'legend-row';
      row.innerHTML = `<span class="legend-swatch ${cls}"></span><span>${label}</span>`;
      legend.appendChild(row);
    }

    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, type: K | string, fn: (e: any) => void, o?: AddEventListenerOptions) => {
      el.addEventListener(type, fn, o);
      this.disposeFns.push(() => el.removeEventListener(type, fn, o));
    };
    for (const btn of Array.from(this.root.querySelectorAll<HTMLElement>('[data-action]'))) {
      on(btn, 'click', (e: Event) => {
        e.stopPropagation();
        const a = btn.dataset.action;
        if (a === 'close') this.opts.onClose();
        else if (a === 'recenter') this.recenter();
        else if (a === 'fit') this.frameRegion(true);
        else if (a === 'clear') this.opts.onWaypointClear();
        else if (a === 'zoom-in') this.zoomBy(1 / BUTTON_ZOOM);
        else if (a === 'zoom-out') this.zoomBy(BUTTON_ZOOM);
      });
    }
    const c = this.canvas;
    on(c, 'pointerdown', (e: PointerEvent) => this.onPointerDown(e));
    on(c, 'pointermove', (e: PointerEvent) => this.onPointerMove(e));
    on(c, 'pointerup', (e: PointerEvent) => this.onPointerUp(e));
    on(c, 'pointercancel', (e: PointerEvent) => this.onPointerCancel(e));
    on(c, 'lostpointercapture', (e: PointerEvent) => this.onPointerCancel(e));
    on(c, 'wheel', (e: WheelEvent) => this.onWheel(e), { passive: false });
    on(c, 'contextmenu', (e: Event) => e.preventDefault());
    on(this.root, 'keydown', (e: KeyboardEvent) => this.onKey(e));
    on(window, 'blur', () => this.cancelGesture());
    on(window, 'resize', () => { if (this.open) { this.layout(); this.requestDraw(); } });
    this.opts.nav.onChange(() => { if (this.open) { this.renderJournal(); this.requestDraw(); } });
    this.tiles.onTileReady = () => { if (this.open) this.requestDraw(); };
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Current view (tests/debug). */
  getView(): MapView {
    return { ...this.view };
  }

  private layout(): void {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(200, Math.floor(rect.width)), h = Math.max(200, Math.floor(rect.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.view.width = w;
    this.view.height = h;
  }

  /** Frame the 32 km region. */
  frameRegion(redraw = false): void {
    this.layout();
    const span = REGION_HALF_SIZE * 2 * 1.08;
    this.view.metersPerPixel = Math.min(MAX_MPP, Math.max(MIN_MPP, span / Math.min(this.view.width, this.view.height)));
    this.view.centerX = 0;
    this.view.centerZ = 0;
    this.framed = true;
    if (redraw) this.requestDraw();
  }

  /** Center on the bird without changing zoom. */
  recenter(): void {
    const p = this.opts.getPlayer();
    this.view.centerX = p.x;
    this.view.centerZ = p.z;
    this.requestDraw();
  }

  private zoomBy(factor: number): void {
    zoomAround(this.view, factor, this.view.width / 2, this.view.height / 2, MIN_MPP, MAX_MPP);
    this.requestDraw();
  }

  show(): void {
    this.root.hidden = false;
    this.open = true;
    this.layout();
    if (!this.framed) this.frameRegion();
    this.cancelGesture();
    this.renderJournal();
    this.requestDraw();
    this.root.focus({ preventScroll: true });
    if (!this.resizeObs && typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => { if (this.open) { this.layout(); this.requestDraw(); } });
      this.resizeObs.observe(this.canvas);
    }
  }

  hide(): void {
    this.cancelGesture();
    this.root.hidden = true;
    this.open = false;
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

  // ---------------------------------------------------------------------
  // Pointer handling
  // ---------------------------------------------------------------------

  private cancelGesture(): void {
    for (const id of this.pointers.keys()) {
      try { this.canvas.releasePointerCapture(id); } catch { /* ignore */ }
    }
    this.pointers.clear();
    this.gestureActive = false;
    this.multiTouch = false;
    this.maxMove = 0;
    this.panAnchor = null;
    this.pinchDist = 0;
    this.canvas.classList.remove('grabbing');
  }

  private onPointerDown(e: PointerEvent): void {
    // Only the primary button (or touch/pen contact) starts a gesture.
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const p = pointerToLocal(this.canvas, e.clientX, e.clientY);
    this.pointers.set(e.pointerId, { x: p.px, y: p.py, startX: p.px, startY: p.py, button: e.button, type: e.pointerType });
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (this.pointers.size === 1) {
      this.gestureActive = true;
      this.multiTouch = false;
      this.maxMove = 0;
      this.panAnchor = { cx: this.view.centerX, cz: this.view.centerZ, px: p.px, py: p.py };
      this.canvas.classList.add('grabbing');
    } else {
      // Second contact: switch to pinch/pan around the midpoint.
      this.multiTouch = true;
      this.maxMove = Infinity;
      const [a, b] = Array.from(this.pointers.values());
      this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      this.panAnchor = { cx: this.view.centerX, cz: this.view.centerZ, px: (a.x + b.x) / 2, py: (a.y + b.y) / 2 };
    }
    e.preventDefault();
  }

  private onPointerMove(e: PointerEvent): void {
    const p = pointerToLocal(this.canvas, e.clientX, e.clientY);
    const w = mapToWorld(p.px, p.py, this.view);
    this.hoverText.textContent = `x ${Math.round(w.x)}  z ${Math.round(w.z)}  ·  ${this.view.metersPerPixel.toFixed(1)} m/px`;
    const ps = this.pointers.get(e.pointerId);
    if (!ps || !this.gestureActive) return;
    ps.x = p.px;
    ps.y = p.py;
    this.maxMove = Math.max(this.maxMove, Math.hypot(p.px - ps.startX, p.py - ps.startY));
    if (this.pointers.size >= 2) {
      const [a, b] = Array.from(this.pointers.values());
      const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinchDist > 0 && d > 0) {
        const factor = Math.min(1.25, Math.max(0.8, this.pinchDist / d));
        zoomAround(this.view, factor, midX, midY, MIN_MPP, MAX_MPP);
        this.pinchDist = d;
      }
      if (this.panAnchor) {
        // Pan so that the midpoint's world position follows the midpoint.
        const dx = midX - this.panAnchor.px, dy = midY - this.panAnchor.py;
        panBy(this.view, dx, dy);
        this.panAnchor.px = midX;
        this.panAnchor.py = midY;
      }
      this.requestDraw();
      return;
    }
    if (this.maxMove > CLICK_THRESHOLD_PX && this.panAnchor) {
      // Pan: world point under the gesture start follows the pointer.
      this.view.centerX = this.panAnchor.cx;
      this.view.centerZ = this.panAnchor.cz;
      panBy(this.view, p.px - this.panAnchor.px, p.py - this.panAnchor.py);
      this.requestDraw();
    }
  }

  private onPointerUp(e: PointerEvent): void {
    const ps = this.pointers.get(e.pointerId);
    if (!ps) return;
    this.pointers.delete(e.pointerId);
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (this.pointers.size === 0) {
      const isClick = this.gestureActive && !this.multiTouch && this.maxMove <= CLICK_THRESHOLD_PX && ps.button === 0;
      this.gestureActive = false;
      this.canvas.classList.remove('grabbing');
      this.panAnchor = null;
      if (isClick) this.handleClick(ps.startX, ps.startY);
      this.multiTouch = false;
      this.maxMove = 0;
    } else {
      // One finger left after a pinch: continue as a (non-click) pan.
      const [a] = Array.from(this.pointers.values());
      this.panAnchor = { cx: this.view.centerX, cz: this.view.centerZ, px: a.x, py: a.y };
      this.pinchDist = 0;
    }
  }

  private onPointerCancel(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) {
      this.gestureActive = false;
      this.multiTouch = false;
      this.maxMove = 0;
      this.panAnchor = null;
      this.canvas.classList.remove('grabbing');
    }
  }

  private handleClick(px: number, py: number): void {
    const hit = this.hitLandmark(px, py);
    if (hit) {
      this.selectedLandmark = hit.id;
      this.opts.onWaypointSet(hit.x, hit.z, hit.id);
    } else {
      const w = mapToWorld(px, py, this.view);
      this.selectedLandmark = null;
      this.opts.onWaypointSet(w.x, w.z, null);
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    // Normalize delta modes (pixels, lines, pages) and cap extreme jumps.
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 16;
    else if (e.deltaMode === 2) delta *= 100;
    delta = Math.max(-240, Math.min(240, delta));
    const p = pointerToLocal(this.canvas, e.clientX, e.clientY);
    zoomAround(this.view, Math.exp(delta * 0.0022), p.px, p.py, MIN_MPP, MAX_MPP);
    this.requestDraw();
  }

  private onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    const step = 60;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft': panBy(this.view, step, 0); break;
      case 'ArrowRight': panBy(this.view, -step, 0); break;
      case 'ArrowUp': panBy(this.view, 0, step); break;
      case 'ArrowDown': panBy(this.view, 0, -step); break;
      case '+': case '=': this.zoomBy(1 / BUTTON_ZOOM); break;
      case '-': case '_': this.zoomBy(BUTTON_ZOOM); break;
      default: handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      this.requestDraw();
    }
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

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

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
    this.renderWaypointInfo();
  }

  private renderWaypointInfo(): void {
    const nav = this.opts.nav;
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
    ctx.fillStyle = '#1b2a33';
    ctx.fillRect(0, 0, v.width, v.height);
    const p = this.opts.getPlayer();
    this.tiles.draw(ctx, v, p.x, p.z);

    // Unexplored veil on cells not yet visited (only when zoomed in enough).
    const cell = 500;
    if (v.metersPerPixel <= 40) {
      const halfW = (v.width / 2) * v.metersPerPixel, halfH = (v.height / 2) * v.metersPerPixel;
      const cx0 = Math.floor((v.centerX - halfW) / cell), cx1 = Math.floor((v.centerX + halfW) / cell);
      const cz0 = Math.floor((v.centerZ - halfH) / cell), cz1 = Math.floor((v.centerZ + halfH) / cell);
      ctx.fillStyle = 'rgba(12, 18, 24, 0.3)';
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
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 6]);
    const a = worldToMap(-REGION_HALF_SIZE, -REGION_HALF_SIZE, v);
    const b = worldToMap(REGION_HALF_SIZE, REGION_HALF_SIZE, v);
    ctx.strokeRect(a.px, a.py, b.px - a.px, b.py - a.py);
    ctx.setLineDash([]);

    // Grid: 4 km / 1 km / 500 m depending on zoom, with faint labels.
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
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

    // Landmarks (discovered only). Labels avoid overlapping each other.
    ctx.font = '12px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    this.labelBoxes.length = 0;
    const nav = this.opts.nav;
    const activeId = nav.waypoint?.landmarkId ?? null;
    const items = this.opts.landmarks.filter((lm) => nav.isDiscovered(lm.id)).sort((x, y) => (x.id === activeId ? -1 : y.id === activeId ? 1 : 0));
    for (const lm of items) {
      const q = worldToMap(lm.x, lm.z, v);
      if (q.px < -20 || q.py < -20 || q.px > v.width + 20 || q.py > v.height + 20) continue;
      const active = lm.id === activeId;
      ctx.fillStyle = active ? '#ffe9a8' : '#ffd166';
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 1.5;
      const r = active ? 8 : 6;
      ctx.beginPath();
      ctx.moveTo(q.px, q.py - r); ctx.lineTo(q.px + r, q.py); ctx.lineTo(q.px, q.py + r); ctx.lineTo(q.px - r, q.py);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      if (v.metersPerPixel < 60 || active) {
        const w = ctx.measureText(lm.name).width + 8;
        const box = { x: q.px + 10, y: q.py - 8, w, h: 16 };
        if (!active && this.labelBoxes.some((o) => box.x < o.x + o.w && box.x + box.w > o.x && box.y < o.y + o.h && box.y + box.h > o.y)) continue;
        this.labelBoxes.push(box);
        ctx.fillStyle = active ? 'rgba(60,40,0,0.75)' : 'rgba(0,0,0,0.55)';
        ctx.fillRect(box.x, box.y, box.w, box.h);
        ctx.fillStyle = '#fff';
        ctx.font = active ? 'bold 12px system-ui, sans-serif' : '12px system-ui, sans-serif';
        ctx.fillText(lm.name, box.x + 4, q.py);
        ctx.font = '12px system-ui, sans-serif';
      }
    }

    // Waypoint + line from player.
    const pp = worldToMap(p.x, p.z, v);
    if (nav.waypoint) {
      const q = worldToMap(nav.waypoint.x, nav.waypoint.z, v);
      ctx.strokeStyle = 'rgba(255,93,93,0.85)';
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
    this.renderWaypointInfo();
  }

  dispose(): void {
    for (const f of this.disposeFns) f();
    this.resizeObs?.disconnect();
    this.root.remove();
  }
}
