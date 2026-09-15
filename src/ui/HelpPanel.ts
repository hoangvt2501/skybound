/**
 * Compact controls help. Shown during onboarding and fades out; H toggles.
 */
export class HelpPanel {
  readonly root: HTMLElement;
  private timer = 0;

  constructor(container: HTMLElement, touch: boolean) {
    this.root = document.createElement('div');
    this.root.className = 'help';
    this.root.hidden = true;
    this.root.innerHTML = touch
      ? `
      <div class="help-title">Controls</div>
      <div class="help-grid">
        <span>Left stick</span><span>turn / climb</span>
        <span>Flap</span><span>lift &amp; speed</span>
        <span>Boost</span><span>burst of speed</span>
        <span>Drag canvas</span><span>orbit camera</span>
        <span>Pinch</span><span>camera distance</span>
        <span>Map / Auto / Recover</span><span>buttons top-left</span>
      </div>`
      : `
      <div class="help-title">Controls <span class="muted">(H to hide)</span></div>
      <div class="help-grid">
        <span>W / ↑ · S / ↓</span><span>climb · descend</span>
        <span>A / ← · D / →</span><span>turn (banks)</span>
        <span>Space (hold)</span><span>flap: lift + speed</span>
        <span>Shift (hold)</span><span>boost (limited)</span>
        <span>X</span><span>air brake</span>
        <span>Left drag</span><span>look around the bird (view is kept)</span>
        <span>Wheel</span><span>camera distance</span>
        <span>V</span><span>reset view behind the bird</span>
        <span>C</span><span>chase / cinematic camera</span>
        <span>F</span><span>autopilot on/off</span>
        <span>M</span><span>world map &amp; waypoint</span>
        <span>R</span><span>recover to safe air</span>
        <span>P</span><span>photo mode (Enter captures, Esc leaves)</span>
        <span>Esc</span><span>close overlay / pause</span>
        <span>F3</span><span>developer overlay</span>
      </div>`;
    container.appendChild(this.root);
  }

  show(autoHideMs = 0): void {
    this.root.hidden = false;
    this.root.classList.remove('fade');
    if (this.timer) clearTimeout(this.timer);
    if (autoHideMs > 0) {
      this.timer = window.setTimeout(() => this.hide(), autoHideMs);
    }
  }

  hide(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = 0;
    this.root.classList.add('fade');
    setTimeout(() => {
      if (this.root.classList.contains('fade')) this.root.hidden = true;
    }, 450);
  }

  toggle(): void {
    if (this.root.hidden || this.root.classList.contains('fade')) this.show();
    else this.hide();
  }

  get visible(): boolean {
    return !this.root.hidden && !this.root.classList.contains('fade');
  }
}
