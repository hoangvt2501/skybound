/**
 * In-flight HUD: speed/altitude readout, heading tape, boost bar, waypoint
 * bearing indicator, autopilot status and transient toasts. DOM is updated
 * only when values change to avoid layout churn.
 */
import { formatDistance, headingDegrees, headingLabel } from '../world/coords';
import type { AutopilotStatus } from '../flight/Autopilot';

export interface HUDData {
  speed: number;
  altitudeAGL: number;
  altitudeASL: number;
  heading: number;
  boost: number;
  boosting: boolean;
  autopilot: boolean;
  autopilotStatus: AutopilotStatus;
  waypoint: { bearing: number; distance: number; name: string | null } | null;
  timeLabel: string;
  cameraMode: string;
}

export class HUD {
  readonly root: HTMLElement;
  private speedEl: HTMLElement;
  private altEl: HTMLElement;
  private aslEl: HTMLElement;
  private headingEl: HTMLElement;
  private headingLabelEl: HTMLElement;
  private tapeEl: HTMLElement;
  private boostEl: HTMLElement;
  private boostWrap: HTMLElement;
  private wpEl: HTMLElement;
  private wpArrow: HTMLElement;
  private wpText: HTMLElement;
  private apEl: HTMLElement;
  private timeEl: HTMLElement;
  private toasts: HTMLElement;
  private resetBtn: HTMLButtonElement;
  private last: Partial<Record<string, string | number | boolean>> = {};
  /** Called when the on-screen "Reset view" button is pressed. */
  onSettings: (() => void) | null = null;
  onResetView: (() => void) | null = null;

  /** Show the reset-view button only while a free-look orbit is active. */
  setFreeLook(active: boolean): void {
    if (this.resetBtn.hidden === !active) return;
    this.resetBtn.hidden = !active;
  }

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="hud-heading">
        <div class="hud-tape"><div class="hud-tape-inner"></div></div>
        <div class="hud-heading-value"><span class="hud-heading-deg">000</span><span class="hud-heading-label">N</span></div>
      </div>
      <div class="hud-waypoint" hidden>
        <span class="hud-wp-arrow">➤</span>
        <span class="hud-wp-text"></span>
      </div>
      <div class="hud-autopilot" hidden></div>
      <button class="hud-resetview" type="button" hidden title="Reset view behind the bird (V)" aria-label="Reset view">Reset view (V)</button>
      <div class="hud-bottom">
        <div class="hud-readout">
          <div class="hud-stat"><span class="hud-stat-value hud-speed">0</span><span class="hud-stat-unit">km/h</span></div>
          <div class="hud-stat"><span class="hud-stat-value hud-alt">0</span><span class="hud-stat-unit">m above ground</span></div>
          <div class="hud-stat hud-stat-small"><span class="hud-stat-value hud-asl">0</span><span class="hud-stat-unit">m above sea</span></div>
        </div>
        <div class="hud-boost" title="Boost (hold Shift)"><div class="hud-boost-fill"></div></div>
      </div>
      <button class="hud-settings" type="button" aria-label="Settings">Settings</button>
      <div class="hud-time"></div>
      <div class="hud-toasts" aria-live="polite"></div>`;
    // The HUD must never intercept pointer/wheel events meant for the canvas.
    this.root.style.pointerEvents = 'none';
    container.appendChild(this.root);
    // In-flight buttons open on a deliberate tap or click only. A look-around drag that
    // happens to start on the button (touch pointers are captured by the element they
    // start on) must not open Settings, and the button must not keep keyboard focus,
    // otherwise Enter during flight would open it again.
    const tapOnly = (button: HTMLElement, action: () => void) => {
      let downX = 0, downY = 0, moved = false;
      button.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; moved = false; });
      button.addEventListener('pointermove', (e) => { if (Math.hypot(e.clientX - downX, e.clientY - downY) > 8) moved = true; });
      button.addEventListener('click', (e) => {
        button.blur();
        if (moved && e.detail > 0) { moved = false; return; } // pointer click after a drag: ignore (keyboard clicks have detail 0)
        moved = false;
        action();
      });
    };
    tapOnly(this.root.querySelector<HTMLElement>('.hud-settings')!, () => this.onSettings?.());
    const q = <T extends HTMLElement>(s: string) => this.root.querySelector<T>(s)!;
    this.speedEl = q('.hud-speed');
    this.altEl = q('.hud-alt');
    this.aslEl = q('.hud-asl');
    this.headingEl = q('.hud-heading-deg');
    this.headingLabelEl = q('.hud-heading-label');
    this.tapeEl = q('.hud-tape-inner');
    this.boostEl = q('.hud-boost-fill');
    this.boostWrap = q('.hud-boost');
    this.wpEl = q('.hud-waypoint');
    this.wpArrow = q('.hud-wp-arrow');
    this.wpText = q('.hud-wp-text');
    this.apEl = q('.hud-autopilot');
    this.timeEl = q('.hud-time');
    this.toasts = q('.hud-toasts');
    this.resetBtn = q<HTMLButtonElement>('.hud-resetview');
    this.resetBtn.style.pointerEvents = 'auto';
    this.resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onResetView?.();
    });
    // Build the heading tape once: ticks every 15 degrees over 720 deg.
    let html = '';
    for (let d = -360; d <= 720; d += 15) {
      const deg = ((d % 360) + 360) % 360;
      const major = deg % 90 === 0;
      const label = major ? ['N', 'E', 'S', 'W'][deg / 90] : deg % 45 === 0 ? String(deg) : '';
      html += `<span class="tick ${major ? 'major' : ''}" style="left:${(d + 360) * 2}px">${label}</span>`;
    }
    this.tapeEl.innerHTML = html;
  }

  setVisible(v: boolean): void {
    this.root.hidden = !v;
  }

  private set(key: string, el: HTMLElement, value: string): void {
    if (this.last[key] === value) return;
    this.last[key] = value;
    el.textContent = value;
  }

  update(d: HUDData): void {
    this.set('speed', this.speedEl, String(Math.round(d.speed * 3.6)));
    this.set('alt', this.altEl, String(Math.max(0, Math.round(d.altitudeAGL))));
    this.set('asl', this.aslEl, String(Math.round(d.altitudeASL)));
    const deg = headingDegrees(d.heading);
    this.set('hdg', this.headingEl, String(Math.round(deg)).padStart(3, '0'));
    this.set('hdgl', this.headingLabelEl, headingLabel(d.heading));
    // Tape: 2 px per degree; center on current heading.
    const offset = -(deg + 360) * 2;
    const tapeKey = Math.round(offset);
    if (this.last.tape !== tapeKey) {
      this.last.tape = tapeKey;
      this.tapeEl.style.transform = `translateX(calc(50% + ${offset}px))`;
    }
    const boostPct = Math.round(d.boost);
    if (this.last.boost !== boostPct) {
      this.last.boost = boostPct;
      this.boostEl.style.width = `${boostPct}%`;
    }
    const boosting = d.boosting ? 'boosting' : d.boost < 100 ? 'recovering' : '';
    if (this.last.boostState !== boosting) {
      this.last.boostState = boosting;
      this.boostWrap.dataset.state = boosting;
    }
    if (d.waypoint) {
      const rel = ((d.waypoint.bearing - d.heading) * 180) / Math.PI;
      const relKey = Math.round(rel);
      if (this.last.wpRot !== relKey) {
        this.last.wpRot = relKey;
        this.wpArrow.style.transform = `rotate(${rel - 90}deg)`;
      }
      const text = `${d.waypoint.name ?? 'Waypoint'} · ${formatDistance(d.waypoint.distance)} · ${Math.round(headingDegrees(d.waypoint.bearing))}°`;
      this.set('wp', this.wpText, text);
      if (this.wpEl.hidden) this.wpEl.hidden = false;
    } else if (!this.wpEl.hidden) {
      this.wpEl.hidden = true;
      this.last.wp = '';
    }
    if (d.autopilot) {
      const label: Record<string, string> = {
        exploring: 'Autopilot · exploring',
        enroute: 'Autopilot · en route to waypoint',
        climbing: 'Autopilot · climbing to clear terrain',
        arrived: 'Autopilot · arrived, circling',
        loitering: 'Autopilot · circling waypoint',
        blocked: 'Autopilot · terrain blocks the route, holding safely',
      };
      this.set('ap', this.apEl, label[d.autopilotStatus] ?? 'Autopilot');
      if (this.apEl.hidden) this.apEl.hidden = false;
      this.apEl.dataset.status = d.autopilotStatus;
    } else if (!this.apEl.hidden) {
      this.apEl.hidden = true;
    }
    this.set('time', this.timeEl, `${d.timeLabel} · ${d.cameraMode} cam`);
  }

  toast(text: string, kind: 'info' | 'discover' | 'warn' = 'info', ms = 3200): void {
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.textContent = text;
    this.toasts.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 400);
    }, ms);
    while (this.toasts.children.length > 4) this.toasts.firstElementChild?.remove();
  }
}
