/**
 * User settings with validation and persistence.
 */
import { STORAGE_KEYS, type QualityPreset } from '../core/config';
import type { KeyValueStore } from './Storage';

export interface Settings {
  quality: QualityPreset;
  invertVertical: boolean;
  sensitivity: number;
  reducedMotion: boolean;
  volume: number;
  muted: boolean;
  showDevOverlay: boolean;
  dynamicResolution: boolean;
  minimapZoom: number;
  helpSeen: boolean;
}

export function defaultSettings(): Settings {
  const mobile = typeof navigator !== 'undefined' && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  const reduce = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return {
    quality: mobile ? 'low' : 'medium',
    invertVertical: false,
    sensitivity: 1,
    reducedMotion: !!reduce,
    volume: 0.6,
    muted: false,
    showDevOverlay: false,
    dynamicResolution: true,
    minimapZoom: 1,
    helpSeen: false,
  };
}

export function validateSettings(raw: unknown): Settings {
  const d = defaultSettings();
  if (!raw || typeof raw !== 'object') return d;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  return {
    quality: o.quality === 'low' || o.quality === 'medium' || o.quality === 'high' ? o.quality : d.quality,
    invertVertical: bool(o.invertVertical, d.invertVertical),
    sensitivity: num(o.sensitivity, 0.3, 2.5, d.sensitivity),
    reducedMotion: bool(o.reducedMotion, d.reducedMotion),
    volume: num(o.volume, 0, 1, d.volume),
    muted: bool(o.muted, d.muted),
    showDevOverlay: bool(o.showDevOverlay, d.showDevOverlay),
    dynamicResolution: bool(o.dynamicResolution, d.dynamicResolution),
    minimapZoom: num(o.minimapZoom, 0, 3, d.minimapZoom),
    helpSeen: bool(o.helpSeen, d.helpSeen),
  };
}

export function loadSettings(store: KeyValueStore): Settings {
  const text = store.get(STORAGE_KEYS.settings);
  if (!text) return defaultSettings();
  try {
    return validateSettings(JSON.parse(text));
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(store: KeyValueStore, s: Settings): void {
  try {
    store.set(STORAGE_KEYS.settings, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
