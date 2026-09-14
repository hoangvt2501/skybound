/**
 * Versioned save data with strict validation and seed precedence rules.
 * Pure functions over a KeyValueStore so they are unit-testable.
 */
import { FLIGHT, SAVE_VERSION, STORAGE_KEYS, WORLD_GEN_VERSION } from '../core/config';
import type { KeyValueStore } from './Storage';

export interface SaveData {
  version: number;
  worldVersion: number;
  seed: number;
  savedAt: number;
  position: { x: number; y: number; z: number };
  heading: number;
  pitch: number;
  speed: number;
  boost: number;
  timeOfDay: number;
  cycling: boolean;
  autopilot: boolean;
  cameraMode: 'chase' | 'cinematic';
  discovered: string[];
  /** Explored cell keys "cx,cz" at EXPLORE_CELL_SIZE. */
  explored: string[];
  waypoint: { x: number; z: number; landmarkId: string | null } | null;
  odometer: number;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown): v is number => isNum(v) && Number.isInteger(v);

/** Validate arbitrary parsed JSON into SaveData, or return null. */
export function validateSave(raw: unknown): SaveData | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.version !== SAVE_VERSION) return null;
  if (!isInt(o.worldVersion) || !isInt(o.seed)) return null;
  const p = o.position as Record<string, unknown> | undefined;
  if (!p || !isNum(p.x) || !isNum(p.y) || !isNum(p.z)) return null;
  if (Math.abs(p.x) > 5e6 || Math.abs(p.z) > 5e6 || p.y < -100 || p.y > 10000) return null;
  if (!isNum(o.heading) || !isNum(o.pitch)) return null;
  if (!isNum(o.timeOfDay) || o.timeOfDay < 0 || o.timeOfDay >= 1) return null;
  const discovered = Array.isArray(o.discovered) ? o.discovered.filter((d): d is string => typeof d === 'string').slice(0, 500) : [];
  const explored = Array.isArray(o.explored) ? o.explored.filter((d): d is string => typeof d === 'string' && /^-?\d+,-?\d+$/.test(d)).slice(0, 50000) : [];
  let waypoint: SaveData['waypoint'] = null;
  const w = o.waypoint as Record<string, unknown> | null | undefined;
  if (w && typeof w === 'object' && isNum(w.x) && isNum(w.z)) {
    waypoint = { x: w.x, z: w.z, landmarkId: typeof w.landmarkId === 'string' ? w.landmarkId : null };
  }
  const speed = isNum(o.speed) ? Math.min(Math.max(o.speed, FLIGHT.minSpeed), FLIGHT.boostMaxSpeed) : FLIGHT.cruiseSpeed;
  return {
    version: SAVE_VERSION,
    worldVersion: o.worldVersion,
    seed: o.seed >>> 0,
    savedAt: isNum(o.savedAt) ? o.savedAt : 0,
    position: { x: p.x, y: p.y, z: p.z },
    heading: o.heading,
    pitch: Math.min(Math.max(o.pitch, FLIGHT.minPitch), FLIGHT.maxPitch),
    speed,
    boost: isNum(o.boost) ? Math.min(Math.max(o.boost, 0), FLIGHT.boostCapacity) : FLIGHT.boostCapacity,
    timeOfDay: o.timeOfDay,
    cycling: typeof o.cycling === 'boolean' ? o.cycling : true,
    autopilot: o.autopilot === true,
    cameraMode: o.cameraMode === 'cinematic' ? 'cinematic' : 'chase',
    discovered,
    explored,
    waypoint,
    odometer: isNum(o.odometer) ? o.odometer : 0,
  };
}

export function loadSave(store: KeyValueStore): SaveData | null {
  const text = store.get(STORAGE_KEYS.save);
  if (!text) return null;
  try {
    return validateSave(JSON.parse(text));
  } catch {
    return null;
  }
}

export function writeSave(store: KeyValueStore, data: SaveData): boolean {
  try {
    return store.set(STORAGE_KEYS.save, JSON.stringify(data));
  } catch {
    return false;
  }
}

export function clearSave(store: KeyValueStore): void {
  store.remove(STORAGE_KEYS.save);
}

export interface SeedResolution {
  seed: number;
  /** Save to restore, or null if starting fresh. */
  save: SaveData | null;
  reason: 'url-seed-new' | 'url-seed-matches-save' | 'saved-world' | 'fresh';
}

/**
 * Seed precedence: a ?seed= value wins over an unrelated save; the save is
 * only restored when its seed matches and its world version is current.
 */
export function resolveSeed(urlSeed: number | null, save: SaveData | null, defaultSeed: number): SeedResolution {
  const usable = save && save.worldVersion === WORLD_GEN_VERSION ? save : null;
  if (urlSeed !== null) {
    if (usable && usable.seed === urlSeed) return { seed: urlSeed, save: usable, reason: 'url-seed-matches-save' };
    return { seed: urlSeed, save: null, reason: 'url-seed-new' };
  }
  if (usable) return { seed: usable.seed, save: usable, reason: 'saved-world' };
  return { seed: defaultSeed, save: null, reason: 'fresh' };
}
