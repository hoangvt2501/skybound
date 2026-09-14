/**
 * User settings with validation and persistence.
 */
import { STORAGE_KEYS, type QualityPreset } from '../core/config';
import { isBirdSpecies, type BirdSpecies } from '../flight/BirdSpecies';
import { isMusicStyle, type MusicStyle } from '../atmosphere/Music';
import type { KeyValueStore } from './Storage';

export interface Settings {
  quality: QualityPreset;
  birdSpecies: BirdSpecies;
  wildlife: 'off' | 'subtle' | 'lively';
  /** Procedural music style; the volume below is its bus level. */
  musicStyle: MusicStyle;
  ambienceVolume: number;
  musicVolume: number;
  effectsVolume: number;
  invertVertical: boolean;
  sensitivity: number;
  reducedMotion: boolean;
  volume: number;
  muted: boolean;
  showDevOverlay: boolean;
  dynamicResolution: boolean;
  minimapZoom: number;
  helpSeen: boolean;
  /** Ease the camera back behind the bird after an idle delay (default off). */
  autoCenterCamera: boolean;
  /** Slowly changing haze and cloud cover (default on). */
  skyMoods: boolean;
}

export function defaultSettings(): Settings {
  const mobile = typeof navigator !== 'undefined' && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  const reduce = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return {
    quality: mobile ? 'low' : 'medium',
    birdSpecies: 'eagle',
    wildlife: 'subtle',
    musicStyle: 'sunny',
    ambienceVolume: 0.55,
    musicVolume: 0.35,
    effectsVolume: 0.45,
    invertVertical: false,
    sensitivity: 1,
    reducedMotion: !!reduce,
    volume: 0.45,
    muted: false,
    showDevOverlay: false,
    dynamicResolution: true,
    minimapZoom: 1,
    helpSeen: false,
    autoCenterCamera: false,
    skyMoods: true,
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
    birdSpecies: isBirdSpecies(o.birdSpecies) ? o.birdSpecies : d.birdSpecies,
    wildlife: o.wildlife === 'off' || o.wildlife === 'subtle' || o.wildlife === 'lively' ? o.wildlife : d.wildlife,
    musicStyle: isMusicStyle(o.musicStyle) ? o.musicStyle : d.musicStyle,
    ambienceVolume: num(o.ambienceVolume, 0, 1, d.ambienceVolume),
    // Preferences saved before there was music keep the new default level.
    musicVolume: 'musicStyle' in o ? num(o.musicVolume, 0, 1, d.musicVolume) : d.musicVolume,
    effectsVolume: num(o.effectsVolume, 0, 1, d.effectsVolume),
    invertVertical: bool(o.invertVertical, d.invertVertical),
    sensitivity: num(o.sensitivity, 0.3, 2.5, d.sensitivity),
    reducedMotion: bool(o.reducedMotion, d.reducedMotion),
    volume: num(o.volume, 0, 1, d.volume),
    muted: bool(o.muted, d.muted),
    showDevOverlay: bool(o.showDevOverlay, d.showDevOverlay),
    dynamicResolution: bool(o.dynamicResolution, d.dynamicResolution),
    minimapZoom: num(o.minimapZoom, 0, 3, d.minimapZoom),
    helpSeen: bool(o.helpSeen, d.helpSeen),
    autoCenterCamera: bool(o.autoCenterCamera, d.autoCenterCamera),
    skyMoods: bool(o.skyMoods, d.skyMoods),
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
