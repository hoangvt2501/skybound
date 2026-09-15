/**
 * Photo mode toolbar: lens (field of view), time of day, hide-the-bird, capture
 * and exit. The bar itself takes pointer events; the rest of the overlay lets
 * drags and wheel reach the canvas so the camera can be orbited.
 */
export interface PhotoPanelOptions {
  onCapture: () => void;
  onExit: () => void;
  onFov: (fov: number) => void;
  onTime: (t: number) => void;
  onHideBird: (hide: boolean) => void;
}

export class PhotoPanel {
  readonly root: HTMLElement;
  private fovInput: HTMLInputElement;
  private timeInput: HTMLInputElement;
  private hideInput: HTMLInputElement;
  private flashEl: HTMLElement;

  constructor(container: HTMLElement, opts: PhotoPanelOptions) {
    this.root = document.createElement('div');
    this.root.className = 'photo';
    this.root.hidden = true;
    this.root.style.pointerEvents = 'none';
    this.root.innerHTML = `
      <div class="photo-flash"></div>
      <div class="photo-bar" role="toolbar" aria-label="Photo mode">
        <span class="photo-title">Photo mode</span>
        <label>Lens <input type="range" class="photo-fov" min="18" max="100" step="1" value="60"><output class="photo-fov-out">60°</output></label>
        <label>Time <input type="range" class="photo-time" min="0" max="1" step="0.002" value="0.3"></label>
        <label class="photo-check"><input type="checkbox" class="photo-hide"> Hide bird</label>
        <button class="btn btn-primary" type="button" data-action="capture" title="Save a PNG (Enter)">Capture</button>
        <button class="btn" type="button" data-action="exit" title="Back to flight (Esc)">Exit</button>
      </div>
      <div class="photo-hint muted small">Drag to orbit · wheel for distance · flight is paused · Enter captures · Esc leaves</div>`;
    container.appendChild(this.root);
    this.fovInput = this.root.querySelector('.photo-fov')!;
    this.timeInput = this.root.querySelector('.photo-time')!;
    this.hideInput = this.root.querySelector('.photo-hide')!;
    this.flashEl = this.root.querySelector('.photo-flash')!;
    const fovOut = this.root.querySelector<HTMLOutputElement>('.photo-fov-out')!;
    this.fovInput.addEventListener('input', () => { fovOut.textContent = `${this.fovInput.value}°`; opts.onFov(Number(this.fovInput.value)); });
    this.timeInput.addEventListener('input', () => opts.onTime(Number(this.timeInput.value)));
    this.hideInput.addEventListener('change', () => opts.onHideBird(this.hideInput.checked));
    this.root.querySelector('[data-action="capture"]')!.addEventListener('click', () => opts.onCapture());
    this.root.querySelector('[data-action="exit"]')!.addEventListener('click', () => opts.onExit());
    // Keys typed into the sliders must not reach the flight input.
    this.root.querySelector('.photo-bar')!.addEventListener('keydown', (e) => {
      const key = (e as KeyboardEvent).key;
      if (key === 'Enter') { e.preventDefault(); e.stopPropagation(); opts.onCapture(); }
      else if (key === 'Escape') { e.preventDefault(); e.stopPropagation(); opts.onExit(); }
      else e.stopPropagation(); // slider keys must not fly the bird
    });
  }

  show(fov: number, time: number, hideBird: boolean): void {
    this.fovInput.value = String(Math.round(fov));
    this.root.querySelector<HTMLOutputElement>('.photo-fov-out')!.textContent = `${Math.round(fov)}°`;
    this.timeInput.value = String(time);
    this.hideInput.checked = hideBird;
    this.root.hidden = false;
  }

  hide(): void { this.root.hidden = true; }
  get visible(): boolean { return !this.root.hidden; }

  /** Brief white flash after a capture. */
  flash(): void {
    this.flashEl.classList.remove('is-on');
    void this.flashEl.offsetWidth; // restart the animation
    this.flashEl.classList.add('is-on');
  }
}
