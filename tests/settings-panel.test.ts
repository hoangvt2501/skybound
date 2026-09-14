// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from '../src/ui/SettingsPanel';
import { defaultSettings } from '../src/persistence/Settings';
import { readFileSync } from 'node:fs';

afterEach(() => { document.body.innerHTML = ''; });
function setup() {
  const host = document.createElement('div'); document.body.appendChild(host);
  const changed = vi.fn(), closed = vi.fn();
  const panel = new SettingsPanel(host, defaultSettings(), { onChange: changed, onClose: closed, getTimeOfDay: () => 0.31, setTimeOfDay: vi.fn(), getCycling: () => true, setCycling: vi.fn() });
  panel.show(defaultSettings()); return { panel, changed, closed };
}
describe('Settings interactions', () => {
  it('stays above later pause overlays and gives long content its own scroll area', () => {
    const { panel } = setup();
    const style = document.createElement('style');
    style.textContent = readFileSync('src/styles.css', 'utf8');
    document.body.appendChild(style);
    const pause = document.createElement('div'); pause.className = 'overlay pause';
    panel.root.parentElement!.appendChild(pause);
    expect(Number(getComputedStyle(panel.root).zIndex)).toBeGreaterThan(Number(getComputedStyle(pause).zIndex));
    expect(getComputedStyle(panel.root.querySelector('.settings-body')!).overflowY).toBe('auto');
  });
  it('has an accessible modal, places focus inside and handles Escape locally', () => {
    const { panel, closed } = setup();
    expect(panel.root.getAttribute('aria-modal')).toBe('true');
    expect(panel.root.contains(document.activeElement)).toBe(true);
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(closed).toHaveBeenCalledOnce();
  });
  it('emits one change per selection and updates bird description and volume labels', () => {
    const { panel, changed } = setup();
    const bird = panel.root.querySelector<HTMLSelectElement>('[data-key="birdSpecies"]')!;
    bird.value = 'swallow'; bird.dispatchEvent(new Event('change', { bubbles: true }));
    expect(changed).toHaveBeenCalledOnce(); expect(changed.mock.calls[0][0].birdSpecies).toBe('swallow');
    expect(panel.root.querySelector('.bird-description')!.textContent).toContain('forked');
    const music = panel.root.querySelector<HTMLInputElement>('[data-key="musicVolume"]')!;
    music.value = '0'; music.dispatchEvent(new Event('input', { bubbles: true }));
    expect(panel.root.querySelector('[data-value="musicVolume"]')!.textContent).toBe('0%');
    expect(changed.mock.calls[1][0].musicVolume).toBe(0);
  });
  it('wraps focus and restores the opener when closed', () => {
    const opener = document.createElement('button'); document.body.appendChild(opener); opener.focus();
    const { panel } = setup();
    const last = Array.from(panel.root.querySelectorAll('button')).at(-1)!;
    last.focus(); last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(panel.root.querySelector('button'));
    panel.hide(); expect(document.activeElement).toBe(opener); expect(panel.visible).toBe(false);
  });
});
