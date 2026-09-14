/**
 * Settings panel: quality, controls, motion, audio, time of day, dev overlay.
 */
import type { QualityPreset } from '../core/config';
import type { Settings } from '../persistence/Settings';

export interface SettingsPanelOptions {
  onChange: (s: Settings) => void;
  onClose: () => void;
  getTimeOfDay: () => number;
  setTimeOfDay: (t: number) => void;
  getCycling: () => boolean;
  setCycling: (c: boolean) => void;
}

export class SettingsPanel {
  readonly root: HTMLElement;
  private settings: Settings;
  private opts: SettingsPanelOptions;
  private timeInput: HTMLInputElement;
  private cycleInput: HTMLInputElement;

  constructor(container: HTMLElement, settings: Settings, opts: SettingsPanelOptions) {
    this.settings = settings;
    this.opts = opts;
    this.root = document.createElement('div');
    this.root.className = 'overlay settings';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="card card-wide">
        <h2>Settings</h2>
        <div class="settings-grid">
          <label>Quality
            <select data-key="quality">
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
          <label><input type="checkbox" data-key="dynamicResolution"> Dynamic resolution</label>
          <label><input type="checkbox" data-key="invertVertical"> Invert vertical (W dives)</label>
          <label>Mouse sensitivity <input type="range" min="0.3" max="2.5" step="0.1" data-key="sensitivity"></label>
          <label><input type="checkbox" data-key="reducedMotion"> Reduced motion (no shake, steady FOV)</label>
          <label>Volume <input type="range" min="0" max="1" step="0.05" data-key="volume"></label>
          <label><input type="checkbox" data-key="muted"> Mute</label>
          <label>Time of day <input type="range" min="0" max="1" step="0.005" class="time-input"></label>
          <label><input type="checkbox" class="cycle-input"> Day/night cycle</label>
          <label><input type="checkbox" data-key="showDevOverlay"> Developer overlay (F3)</label>
        </div>
        <div class="menu-row">
          <button class="btn btn-primary" data-action="close">Done</button>
        </div>
      </div>`;
    container.appendChild(this.root);
    this.timeInput = this.root.querySelector('.time-input')!;
    this.cycleInput = this.root.querySelector('.cycle-input')!;
    this.root.querySelector('[data-action="close"]')!.addEventListener('click', () => opts.onClose());
    for (const el of Array.from(this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-key]'))) {
      el.addEventListener('input', () => this.read());
      el.addEventListener('change', () => this.read());
    }
    this.timeInput.addEventListener('input', () => opts.setTimeOfDay(Number(this.timeInput.value)));
    this.cycleInput.addEventListener('change', () => opts.setCycling(this.cycleInput.checked));
    this.root.addEventListener('keydown', (e) => e.stopPropagation());
    this.write();
  }

  private write(): void {
    const s = this.settings;
    for (const el of Array.from(this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-key]'))) {
      const key = el.dataset.key as keyof Settings;
      const v = s[key];
      if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = Boolean(v);
      else el.value = String(v);
    }
    this.timeInput.value = String(this.opts.getTimeOfDay());
    this.cycleInput.checked = this.opts.getCycling();
  }

  private read(): void {
    const s = { ...this.settings };
    for (const el of Array.from(this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-key]'))) {
      const key = el.dataset.key as keyof Settings;
      if (el instanceof HTMLInputElement && el.type === 'checkbox') (s as Record<string, unknown>)[key] = el.checked;
      else if (el instanceof HTMLInputElement && el.type === 'range') (s as Record<string, unknown>)[key] = Number(el.value);
      else (s as Record<string, unknown>)[key] = el.value as QualityPreset;
    }
    this.settings = s;
    this.opts.onChange(s);
  }

  show(settings: Settings): void {
    this.settings = settings;
    this.write();
    this.root.hidden = false;
  }

  hide(): void {
    this.root.hidden = true;
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  /** Reflect the live time slider while the cycle runs. */
  syncTime(): void {
    if (this.root.hidden) return;
    if (document.activeElement !== this.timeInput) this.timeInput.value = String(this.opts.getTimeOfDay());
  }
}
