/**
 * Pause menu overlay.
 */
export interface PauseMenuOptions {
  onResume: () => void;
  onSettings: () => void;
  onHelp: () => void;
  onNewWorld: () => void;
  onResetProgress: () => void;
}

export class PauseMenu {
  readonly root: HTMLElement;
  private info: HTMLElement;

  constructor(container: HTMLElement, opts: PauseMenuOptions) {
    this.root = document.createElement('div');
    this.root.className = 'overlay pause';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="card">
        <h2>Paused</h2>
        <p class="pause-info muted"></p>
        <div class="menu">
          <button class="btn btn-primary" data-action="resume">Resume</button>
          <button class="btn" data-action="settings">Settings</button>
          <button class="btn" data-action="help">Controls</button>
          <button class="btn" data-action="new">New world…</button>
          <button class="btn btn-danger" data-action="reset">Reset progress…</button>
        </div>
        <p class="muted small">Esc resumes. Your flight is saved automatically.</p>
      </div>`;
    container.appendChild(this.root);
    this.info = this.root.querySelector('.pause-info')!;
    const on = (a: string, fn: () => void) => this.root.querySelector(`[data-action="${a}"]`)!.addEventListener('click', fn);
    on('resume', opts.onResume);
    on('settings', opts.onSettings);
    on('help', opts.onHelp);
    on('new', () => {
      const seedText = window.prompt('Seed for the new world (number or any text). Sharing a seed shares the world, not your progress.', '');
      if (seedText === null) return;
      if (!window.confirm('Start a new world? Your current flight, discoveries and waypoint will be replaced.')) return;
      opts.onNewWorld();
      const url = new URL(window.location.href);
      if (seedText.trim() === '') url.searchParams.delete('seed');
      else url.searchParams.set('seed', seedText.trim());
      url.searchParams.set('fresh', '1');
      window.location.href = url.toString();
    });
    on('reset', () => {
      if (!window.confirm('Reset progress? Discoveries, explored areas and the waypoint are cleared. The world stays the same.')) return;
      opts.onResetProgress();
    });
  }

  show(info: string): void {
    this.info.textContent = info;
    this.root.hidden = false;
  }

  hide(): void {
    this.root.hidden = true;
  }

  get visible(): boolean {
    return !this.root.hidden;
  }
}
