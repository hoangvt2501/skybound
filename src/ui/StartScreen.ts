/**
 * Start screen: title, Start flying / Continue, seed entry for a new world,
 * settings shortcut. Shown over the live scene once the first chunks exist.
 */
export interface StartScreenOptions {
  seed: number;
  hasSave: boolean;
  onStart: (mode: 'continue' | 'new', seedText: string) => void;
  onSettings: () => void;
}

export class StartScreen {
  readonly root: HTMLElement;
  private status: HTMLElement;
  private startBtn: HTMLButtonElement;
  private newBtn: HTMLButtonElement;
  private seedInput: HTMLInputElement;

  constructor(container: HTMLElement, opts: StartScreenOptions) {
    this.root = document.createElement('div');
    this.root.className = 'overlay start';
    this.root.innerHTML = `
      <div class="start-card">
        <h1 class="title">SKYBOUND</h1>
        <p class="tagline">Take wing over a 32 km hand-shaped world. Find its landmarks. Fly wherever you like.</p>
        <div class="start-actions">
          <button class="btn btn-primary btn-large" data-action="start">${opts.hasSave ? 'Continue flying' : 'Start flying'}</button>
          <button class="btn" data-action="settings">Settings</button>
        </div>
        <details class="start-new">
          <summary>${opts.hasSave ? 'New world' : 'Choose a seed'}</summary>
          <div class="start-new-row">
            <label>Seed <input class="seed-input" type="text" inputmode="text" value="${opts.seed}" maxlength="32" aria-label="World seed"></label>
            <button class="btn" data-action="new">${opts.hasSave ? 'Start new world' : 'Fly this seed'}</button>
          </div>
          <p class="muted small">Sharing a seed shares the world, not your progress. ${opts.hasSave ? 'Starting a new world replaces your current flight and discoveries.' : ''}</p>
        </details>
        <p class="start-status muted">Preparing the world…</p>
        <p class="start-controls muted small">W/S climb · A/D turn · Space flap · Shift boost · F autopilot · M map · H help</p>
      </div>`;
    container.appendChild(this.root);
    this.status = this.root.querySelector('.start-status')!;
    this.startBtn = this.root.querySelector('[data-action="start"]')!;
    this.newBtn = this.root.querySelector('[data-action="new"]')!;
    this.seedInput = this.root.querySelector('.seed-input')!;
    this.startBtn.disabled = true;
    this.newBtn.disabled = true;
    this.startBtn.addEventListener('click', () => opts.onStart(opts.hasSave ? 'continue' : 'new', this.seedInput.value));
    this.newBtn.addEventListener('click', () => {
      if (opts.hasSave && !window.confirm('Start a new world? Your current flight, discoveries and waypoint will be replaced.')) return;
      opts.onStart('new', this.seedInput.value);
    });
    this.root.querySelector('[data-action="settings"]')!.addEventListener('click', () => opts.onSettings());
    this.seedInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.newBtn.click();
      e.stopPropagation();
    });
  }

  setReady(ready: boolean, text?: string): void {
    this.startBtn.disabled = !ready;
    this.newBtn.disabled = !ready;
    this.status.textContent = text ?? (ready ? 'Ready.' : 'Preparing the world…');
  }

  hide(): void {
    this.root.classList.add('fade-out');
    // Stop intercepting input immediately, before the fade finishes.
    this.root.style.pointerEvents = 'none';
    setTimeout(() => (this.root.hidden = true), 500);
  }

  show(): void {
    this.root.hidden = false;
    this.root.style.pointerEvents = '';
    this.root.classList.remove('fade-out');
  }
}
