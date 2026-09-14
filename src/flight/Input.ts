/**
 * Keyboard, mouse and touch input. Produces a FlightInput each frame plus
 * one-shot action events. Pressed state is cleared on blur, pause, overlay
 * open and pointer cancellation so nothing sticks.
 */
import { CAMERA } from '../core/config';
import type { FlightInput } from './FlightController';

export type Action =
  | 'toggleAutopilot'
  | 'toggleMap'
  | 'recover'
  | 'toggleHelp'
  | 'escape'
  | 'cycleCamera'
  | 'togglePause'
  | 'toggleDev';

export interface CameraInput {
  /** Accumulated orbit deltas since last read (radians). */
  orbitYaw: number;
  orbitPitch: number;
  /** Accumulated zoom delta (meters, positive = further). */
  zoom: number;
  dragging: boolean;
}

export class InputManager {
  private keys = new Set<string>();
  private actions: Action[] = [];
  private camera: CameraInput = { orbitYaw: 0, orbitPitch: 0, zoom: 0, dragging: false };
  private canvas: HTMLElement;
  private pointerId: number | null = null;
  private lastX = 0;
  private lastY = 0;
  /** Touch controls feed these directly. */
  touch = { turn: 0, pitch: 0, flap: false, boost: false, active: false };
  /** When true, flight keys are ignored (overlay open). */
  blocked = false;
  sensitivity = 1;
  invertVertical = false;
  /** True when any manual flight input was active this frame. */
  manualActive = false;
  private disposeFns: (() => void)[] = [];

  constructor(canvas: HTMLElement) {
    this.canvas = canvas;
    const on = <K extends keyof WindowEventMap>(target: Window | HTMLElement, type: K | string, fn: (e: any) => void, opts?: AddEventListenerOptions) => {
      target.addEventListener(type, fn, opts);
      this.disposeFns.push(() => target.removeEventListener(type, fn, opts));
    };
    on(window, 'keydown', (e: KeyboardEvent) => this.onKeyDown(e));
    on(window, 'keyup', (e: KeyboardEvent) => this.keys.delete(e.code));
    on(window, 'blur', () => this.clear());
    on(canvas, 'pointerdown', (e: PointerEvent) => this.onPointerDown(e));
    on(canvas, 'pointermove', (e: PointerEvent) => this.onPointerMove(e));
    on(canvas, 'pointerup', (e: PointerEvent) => this.onPointerUp(e));
    on(canvas, 'pointercancel', (e: PointerEvent) => this.onPointerUp(e));
    on(canvas, 'wheel', (e: WheelEvent) => {
      e.preventDefault();
      this.camera.zoom += Math.sign(e.deltaY) * 2.2;
    }, { passive: false });
    on(canvas, 'contextmenu', (e: Event) => e.preventDefault());
  }

  private onKeyDown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
    if (e.repeat) {
      if (!this.blocked) this.keys.add(e.code);
      return;
    }
    switch (e.code) {
      case 'KeyF': this.actions.push('toggleAutopilot'); break;
      case 'KeyM': this.actions.push('toggleMap'); break;
      case 'KeyR': this.actions.push('recover'); break;
      case 'KeyH': this.actions.push('toggleHelp'); break;
      case 'KeyC': this.actions.push('cycleCamera'); break;
      case 'KeyP': this.actions.push('togglePause'); break;
      case 'F3': this.actions.push('toggleDev'); e.preventDefault(); break;
      case 'Escape': this.actions.push('escape'); break;
      default: break;
    }
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    if (!this.blocked) this.keys.add(e.code);
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.pointerType === 'touch') return; // touch camera drag is handled by TouchControls
    if (e.button !== 0) return;
    this.pointerId = e.pointerId;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.camera.dragging = true;
    this.canvas.setPointerCapture(e.pointerId);
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.pointerId !== e.pointerId) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.camera.orbitYaw -= dx * 0.006 * this.sensitivity;
    this.camera.orbitPitch -= dy * 0.005 * this.sensitivity;
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.pointerId !== e.pointerId) return;
    this.pointerId = null;
    this.camera.dragging = false;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  /** External camera drag (touch). */
  applyCameraDrag(dx: number, dy: number): void {
    this.camera.orbitYaw -= dx * 0.006 * this.sensitivity;
    this.camera.orbitPitch -= dy * 0.005 * this.sensitivity;
  }

  applyZoom(delta: number): void {
    this.camera.zoom += delta;
  }

  /** Clear all held keys and drags. */
  clear(): void {
    this.keys.clear();
    this.camera.dragging = false;
    this.pointerId = null;
    this.touch.turn = 0;
    this.touch.pitch = 0;
    this.touch.flap = false;
    this.touch.boost = false;
  }

  /** Drain one-shot actions. */
  takeActions(): Action[] {
    const a = this.actions;
    this.actions = [];
    return a;
  }

  /** Read and reset camera deltas. */
  takeCamera(): CameraInput {
    const c = { ...this.camera };
    this.camera.orbitYaw = 0;
    this.camera.orbitPitch = 0;
    this.camera.zoom = 0;
    c.zoom = Math.max(-CAMERA.maxDistance, Math.min(CAMERA.maxDistance, c.zoom));
    return c;
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** Compose the flight input for this frame. */
  read(out: FlightInput): FlightInput {
    let pitch = 0, turn = 0;
    if (!this.blocked) {
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) pitch += 1;
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) pitch -= 1;
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) turn -= 1;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) turn += 1;
    }
    const flapKey = !this.blocked && this.keys.has('Space');
    const boostKey = !this.blocked && (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'));
    const brakeKey = !this.blocked && (this.keys.has('KeyX') || this.keys.has('ControlLeft'));
    if (this.invertVertical) pitch = -pitch;
    if (this.touch.active) {
      turn += this.touch.turn;
      pitch += this.invertVertical ? -this.touch.pitch : this.touch.pitch;
    }
    out.pitch = Math.max(-1, Math.min(1, pitch));
    out.turn = Math.max(-1, Math.min(1, turn));
    out.flap = flapKey || this.touch.flap;
    out.boost = boostKey || this.touch.boost;
    out.brake = brakeKey ? 1 : 0;
    this.manualActive = out.pitch !== 0 || out.turn !== 0 || out.flap || out.boost || out.brake > 0;
    return out;
  }

  dispose(): void {
    for (const f of this.disposeFns) f();
    this.disposeFns.length = 0;
  }
}
