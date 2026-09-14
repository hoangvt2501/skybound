import './styles.css';
import { App } from './core/App';
import { SHOWCASE_SEED } from './core/config';
import { MusicBox } from './atmosphere/Music';
import { clearSave, loadSave, resolveSeed } from './persistence/Save';
import { loadSettings } from './persistence/Settings';
import { LocalStore } from './persistence/Storage';
import { WorldGen } from './world/WorldGen';

function showUnsupported(ui: HTMLElement, reason: string): void {
  ui.innerHTML = `
    <div class="unsupported">
      <div class="card">
        <h2>SKYBOUND needs WebGL2</h2>
        <p>${reason}</p>
        <p class="muted small">Try a current version of Chrome, Edge, Firefox or Safari with hardware acceleration enabled.</p>
      </div>
    </div>`;
}

function hasWebGL2(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}

function boot(): void {
  const canvas = document.getElementById('scene') as HTMLCanvasElement | null;
  const ui = document.getElementById('ui') as HTMLElement | null;
  if (!canvas || !ui) return;
  if (!hasWebGL2()) {
    showUnsupported(ui, 'Your browser or device did not provide a WebGL2 context.');
    return;
  }

  const store = new LocalStore();
  const params = new URLSearchParams(window.location.search);
  const fresh = params.get('fresh') === '1';
  if (fresh) {
    clearSave(store);
    params.delete('fresh');
    const url = new URL(window.location.href);
    url.search = params.toString();
    window.history.replaceState(null, '', url.toString());
  }
  const seedParam = params.get('seed');
  const urlSeed = seedParam !== null && seedParam !== '' ? WorldGen.parseSeed(seedParam, SHOWCASE_SEED) : null;
  const save = fresh ? null : loadSave(store);
  const resolved = resolveSeed(urlSeed, save, SHOWCASE_SEED);
  const settings = loadSettings(store);

  try {
    const app = new App(canvas, ui, {
      seed: resolved.seed,
      save: resolved.save,
      settings,
      store,
      urlSeed: urlSeed !== null,
      migrated: resolved.migrated,
    });
    (window as unknown as { skybound: unknown }).skybound = app;
    (window as unknown as { __musicModule: unknown }).__musicModule = { MusicBox }; // offline render checks
    // eslint-disable-next-line no-console
    console.info(`[skybound] seed ${resolved.seed} (${resolved.reason}); storage ${store.available ? 'ok' : 'unavailable'}`);
  } catch (err) {
    console.error(err);
    showUnsupported(ui, `The renderer failed to start: ${(err as Error).message}`);
  }
}

boot();
