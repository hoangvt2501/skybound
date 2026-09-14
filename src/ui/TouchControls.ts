/**
 * Touch controls: a left virtual joystick for turn/climb, right-side flap
 * and boost buttons, top-left action buttons, and camera drag/pinch on the
 * unused canvas area. Pointer capture keeps multi-touch gestures separate.
 */
import type { InputManager } from '../flight/Input';

export interface TouchOptions {
  onMap: () => void;
  onAutopilot: () => void;
  onRecover: () => void;
  onPause: () => void;
  onCamera: () => void;
}

export class TouchControls {
  readonly root: HTMLElement;
  private input: InputManager;
  private stick: HTMLElement;
  private knob: HTMLElement;
  private stickPointer: number | null = null;
  private stickCenter = { x: 0, y: 0 };
  private stickRadius = 48;
  private cameraPointers = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;
  private canvas: HTMLElement;
  private disposeFns: (() => void)[] = [];

  constructor(container: HTMLElement, canvas: HTMLElement, input: InputManager, opts: TouchOptions) {
    this.input = input;
    this.canvas = canvas;
    this.root = document.createElement('div');
    this.root.className = 'touch';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="touch-actions">
        <button class="tbtn" data-action="map" aria-label="Map">Map</button>
        <button class="tbtn" data-action="auto" aria-label="Autopilot">Auto</button>
        <button class="tbtn" data-action="cam" aria-label="Camera">Cam</button>
        <button class="tbtn" data-action="recover" aria-label="Recover">Recover</button>
        <button class="tbtn" data-action="pause" aria-label="Pause">Pause</button>
      </div>
      <div class="touch-stick" aria-label="Flight stick"><div class="touch-knob"></div></div>
      <div class="touch-right">
        <button class="tbig" data-hold="boost" aria-label="Boost">Boost</button>
        <button class="tbig tbig-primary" data-hold="flap" aria-label="Flap">Flap</button>
      </div>`;
    container.appendChild(this.root);
    this.stick = this.root.querySelector('.touch-stick')!;
    this.knob = this.root.querySelector('.touch-knob')!;
    const on = (el: HTMLElement | Window, type: string, fn: (e: any) => void, o?: AddEventListenerOptions) => {
      el.addEventListener(type, fn, o);
      this.disposeFns.push(() => el.removeEventListener(type, fn, o));
    };
    for (const btn of Array.from(this.root.querySelectorAll<HTMLElement>('[data-action]'))) {
      on(btn, 'click', (e: Event) => {
        e.stopPropagation();
        const a = btn.dataset.action;
        if (a === 'map') opts.onMap();
        else if (a === 'auto') opts.onAutopilot();
        else if (a === 'recover') opts.onRecover();
        else if (a === 'pause') opts.onPause();
        else if (a === 'cam') opts.onCamera();
      });
    }
    for (const btn of Array.from(this.root.querySelectorAll<HTMLElement>('[data-hold]'))) {
      const key = btn.dataset.hold as 'flap' | 'boost';
      const set = (v: boolean) => {
        this.input.touch[key] = v;
        btn.classList.toggle('active', v);
      };
      on(btn, 'pointerdown', (e: PointerEvent) => { e.preventDefault(); btn.setPointerCapture(e.pointerId); set(true); });
      on(btn, 'pointerup', () => set(false));
      on(btn, 'pointercancel', () => set(false));
      on(btn, 'lostpointercapture', () => set(false));
      on(btn, 'contextmenu', (e: Event) => e.preventDefault());
    }
    on(this.stick, 'pointerdown', (e: PointerEvent) => this.stickDown(e));
    on(this.stick, 'pointermove', (e: PointerEvent) => this.stickMove(e));
    on(this.stick, 'pointerup', (e: PointerEvent) => this.stickUp(e));
    on(this.stick, 'pointercancel', (e: PointerEvent) => this.stickUp(e));
    on(this.stick, 'lostpointercapture', (e: PointerEvent) => this.stickUp(e));
    // Camera drag / pinch on the canvas for touch pointers only.
    on(canvas, 'pointerdown', (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || this.root.hidden) return;
      this.cameraPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      canvas.setPointerCapture(e.pointerId);
      if (this.cameraPointers.size === 2) {
        const [a, b] = Array.from(this.cameraPointers.values());
        this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    on(canvas, 'pointermove', (e: PointerEvent) => {
      const prev = this.cameraPointers.get(e.pointerId);
      if (!prev) return;
      const cur = { x: e.clientX, y: e.clientY };
      this.cameraPointers.set(e.pointerId, cur);
      if (this.cameraPointers.size === 1) {
        this.input.applyCameraDrag(cur.x - prev.x, cur.y - prev.y);
      } else if (this.cameraPointers.size === 2) {
        const [a, b] = Array.from(this.cameraPointers.values());
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinchDist > 0) this.input.applyZoom((this.pinchDist - d) * 0.05);
        this.pinchDist = d;
      }
    });
    const endCam = (e: PointerEvent) => {
      this.cameraPointers.delete(e.pointerId);
      this.pinchDist = 0;
    };
    on(canvas, 'pointerup', endCam);
    on(canvas, 'pointercancel', endCam);
    on(window, 'blur', () => this.resetAll());
  }

  private stickDown(e: PointerEvent): void {
    e.preventDefault();
    if (this.stickPointer !== null) return;
    this.stickPointer = e.pointerId;
    this.stick.setPointerCapture(e.pointerId);
    const r = this.stick.getBoundingClientRect();
    this.stickCenter = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    this.stickRadius = r.width / 2;
    this.stickMove(e);
  }

  private stickMove(e: PointerEvent): void {
    if (this.stickPointer !== e.pointerId) return;
    let dx = (e.clientX - this.stickCenter.x) / this.stickRadius;
    let dy = (e.clientY - this.stickCenter.y) / this.stickRadius;
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    const dead = 0.12;
    const shape = (v: number) => (Math.abs(v) < dead ? 0 : Math.sign(v) * (Math.abs(v) - dead) / (1 - dead));
    this.input.touch.turn = shape(dx);
    this.input.touch.pitch = -shape(dy);
    this.knob.style.transform = `translate(${dx * this.stickRadius * 0.55}px, ${dy * this.stickRadius * 0.55}px)`;
  }

  private stickUp(e: PointerEvent): void {
    if (this.stickPointer !== e.pointerId) return;
    this.stickPointer = null;
    this.input.touch.turn = 0;
    this.input.touch.pitch = 0;
    this.knob.style.transform = '';
  }

  resetAll(): void {
    this.stickPointer = null;
    this.cameraPointers.clear();
    this.input.touch.turn = 0;
    this.input.touch.pitch = 0;
    this.input.touch.flap = false;
    this.input.touch.boost = false;
    this.knob.style.transform = '';
    for (const b of Array.from(this.root.querySelectorAll('.active'))) b.classList.remove('active');
  }

  setVisible(v: boolean): void {
    this.root.hidden = !v;
    this.input.touch.active = v;
    if (!v) this.resetAll();
  }

  dispose(): void {
    for (const f of this.disposeFns) f();
    this.root.remove();
  }
}
