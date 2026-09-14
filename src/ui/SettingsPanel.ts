/** One modal above start/pause/map, with bounded scrolling and focus ownership. */
import { BIRD_SPECIES } from '../flight/BirdSpecies';
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
  private returnFocus: HTMLElement | null = null;

  constructor(container: HTMLElement, settings: Settings, opts: SettingsPanelOptions) {
    this.settings = settings;
    this.opts = opts;
    this.root = document.createElement('div');
    this.root.className = 'overlay settings';
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-labelledby', 'settings-title');
    const slider = (name: string, key: string, min = 0, max = 1, step = 0.05) => `<label>${name}<span class="settings-range"><input type="range" min="${min}" max="${max}" step="${step}" data-key="${key}"><output data-value="${key}"></output></span></label>`;
    this.root.innerHTML = `
      <div class="card settings-card">
        <header class="settings-header"><div><h2 id="settings-title">Settings</h2><p class="muted small">Your bird, your soundscape, your pace.</p></div><button class="btn" data-action="close" aria-label="Close settings">✕</button></header>
        <div class="settings-body">
          <fieldset><legend>Your bird</legend><div class="settings-grid">
            <label>Fly as<select data-key="birdSpecies">${Object.entries(BIRD_SPECIES).map(([id, b]) => `<option value="${id}">${b.name}</option>`).join('')}</select></label>
            <p class="muted small bird-description" aria-live="polite"></p>
          </div><p class="muted small">Different silhouettes and wingbeats; the same familiar flight controls.</p></fieldset>
          <fieldset><legend>Soundscape</legend><div class="settings-grid">
            ${slider('Master volume', 'volume')}
            <label><input type="checkbox" data-key="muted"> Mute all sounds</label>
            ${slider('Nature & wind', 'ambienceVolume')}
            ${slider('Gentle music', 'musicVolume')}
            ${slider('Wings & discoveries', 'effectsVolume')}
          </div><p class="muted small">Sound starts when you begin flying. Set Gentle music to zero for nature only.</p></fieldset>
          <fieldset><legend>World & performance</legend><div class="settings-grid">
            <label>Quality<select data-key="quality"><option value="low">Low · lighter rendering</option><option value="medium">Medium · balanced</option><option value="high">High · richer detail</option></select></label>
            <label>Wildlife<select data-key="wildlife"><option value="off">Off</option><option value="subtle">Subtle · occasional company</option><option value="lively">Lively · more encounters</option></select></label>
            <label><input type="checkbox" data-key="dynamicResolution"> Adaptive resolution</label>
            <label><input type="checkbox" class="cycle-input"> Day/night cycle</label>
            <label>Time of day<input type="range" min="0" max="1" step="0.005" class="time-input"></label>
          </div><p class="muted small">Adaptive resolution lowers rendering cost when frames take longer. Wildlife stays within a fixed population limit.</p></fieldset>
          <fieldset><legend>Camera & controls</legend><div class="settings-grid">
            ${slider('Mouse sensitivity', 'sensitivity', 0.3, 2.5, 0.1)}
            <label><input type="checkbox" data-key="autoCenterCamera"> Auto-center camera</label>
            <label><input type="checkbox" data-key="invertVertical"> Invert vertical (W dives)</label>
            <label><input type="checkbox" data-key="reducedMotion"> Reduced camera motion</label>
          </div></fieldset>
          <details><summary class="muted small">Diagnostics</summary><label class="settings-check"><input type="checkbox" data-key="showDevOverlay"> Frame statistics (F3)</label></details>
        </div>
        <footer class="settings-footer"><span class="muted small">Changes apply immediately · Esc to close</span><button class="btn btn-primary" data-action="close">Done</button></footer>
      </div>`;
    container.appendChild(this.root);
    this.timeInput = this.root.querySelector('.time-input')!;
    this.cycleInput = this.root.querySelector('.cycle-input')!;
    this.root.querySelectorAll('[data-action="close"]').forEach(el => el.addEventListener('click', () => opts.onClose()));
    for (const el of this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-key]')) {
      el.addEventListener(el instanceof HTMLInputElement && el.type === 'range' ? 'input' : 'change', () => this.read());
    }
    this.timeInput.addEventListener('input', () => opts.setTimeOfDay(Number(this.timeInput.value)));
    this.cycleInput.addEventListener('change', () => opts.setCycling(this.cycleInput.checked));
    this.root.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); opts.onClose(); return; }
      if (e.key !== 'Tab') return;
      const elements = Array.from(this.root.querySelectorAll<HTMLElement>('button, input, select, summary')).filter(el => !el.closest('details:not([open])') || el.tagName === 'SUMMARY');
      const first = elements[0], last = elements[elements.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    this.write();
  }

  private syncLabels(): void {
    for (const el of this.root.querySelectorAll<HTMLOutputElement>('[data-value]')) {
      const key = el.dataset.value as keyof Settings;
      el.textContent = key === 'sensitivity' ? `${Number(this.settings[key]).toFixed(1)}×` : `${Math.round(Number(this.settings[key]) * 100)}%`;
    }
    this.root.querySelector('.bird-description')!.textContent = BIRD_SPECIES[this.settings.birdSpecies].description;
  }

  private write(): void {
    for (const el of this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-key]')) {
      const value = this.settings[el.dataset.key as keyof Settings];
      if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = Boolean(value);
      else el.value = String(value);
    }
    this.timeInput.value = String(this.opts.getTimeOfDay());
    this.cycleInput.checked = this.opts.getCycling();
    this.syncLabels();
  }

  private read(): void {
    const s = { ...this.settings };
    for (const el of this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-key]')) {
      const key = el.dataset.key as keyof Settings;
      const value = el instanceof HTMLInputElement ? (el.type === 'checkbox' ? el.checked : Number(el.value)) : el.value;
      (s as unknown as Record<string, unknown>)[key] = value;
    }
    this.settings = s;
    this.syncLabels();
    this.opts.onChange(s);
  }

  show(settings: Settings): void {
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.settings = settings;
    this.write();
    this.root.hidden = false;
    this.root.querySelector<HTMLSelectElement>('[data-key="birdSpecies"]')!.focus();
  }

  hide(): void {
    this.root.hidden = true;
    if (this.returnFocus?.isConnected) this.returnFocus.focus();
    this.returnFocus = null;
  }

  get visible(): boolean { return !this.root.hidden; }
  syncTime(): void {
    if (!this.root.hidden && document.activeElement !== this.timeInput) this.timeInput.value = String(this.opts.getTimeOfDay());
  }
}
