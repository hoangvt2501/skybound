import { describe, expect, it } from 'vitest';
import { SAVE_VERSION, STORAGE_KEYS, WORLD_GEN_VERSION } from '../src/core/config';
import { clearSave, loadSave, resolveSeed, validateSave, writeSave, type SaveData } from '../src/persistence/Save';
import { validateSettings, defaultSettings } from '../src/persistence/Settings';
import { MemoryStore } from '../src/persistence/Storage';

function goodSave(seed = 1207): SaveData {
  return {
    version: SAVE_VERSION,
    worldVersion: WORLD_GEN_VERSION,
    seed,
    savedAt: 1,
    position: { x: 10, y: 200, z: -20 },
    heading: 0.5,
    pitch: 0.1,
    speed: 34,
    boost: 80,
    timeOfDay: 0.4,
    cycling: true,
    autopilot: false,
    cameraMode: 'chase',
    discovered: ['a'],
    explored: ['0,0', '-1,3'],
    waypoint: { x: 1, z: 2, landmarkId: null },
    odometer: 100,
  };
}

describe('Save validation', () => {
  it('accepts a well-formed save and round-trips through the store', () => {
    const store = new MemoryStore();
    expect(writeSave(store, goodSave())).toBe(true);
    const back = loadSave(store);
    expect(back).not.toBeNull();
    expect(back!.position).toEqual({ x: 10, y: 200, z: -20 });
    expect(back!.explored).toEqual(['0,0', '-1,3']);
    clearSave(store);
    expect(loadSave(store)).toBeNull();
  });

  it('rejects malformed, wrong-version and out-of-range data', () => {
    expect(validateSave(null)).toBeNull();
    expect(validateSave('nope')).toBeNull();
    expect(validateSave({ ...goodSave(), version: 99 })).toBeNull();
    expect(validateSave({ ...goodSave(), position: { x: 'a', y: 1, z: 2 } })).toBeNull();
    expect(validateSave({ ...goodSave(), position: { x: 1e9, y: 1, z: 2 } })).toBeNull();
    expect(validateSave({ ...goodSave(), timeOfDay: 2 })).toBeNull();
    const store = new MemoryStore();
    store.set(STORAGE_KEYS.save, '{not json');
    expect(loadSave(store)).toBeNull();
  });

  it('clamps suspicious values and drops invalid explored keys', () => {
    const v = validateSave({ ...goodSave(), speed: 9999, pitch: 5, boost: -3, explored: ['1,1', 'bad', 'x,y', '2,-2'] })!;
    expect(v.speed).toBeLessThanOrEqual(90);
    expect(v.pitch).toBeLessThanOrEqual(1);
    expect(v.boost).toBe(0);
    expect(v.explored).toEqual(['1,1', '2,-2']);
  });

  it('seed precedence: URL seed wins over an unrelated save; matching seed restores', () => {
    const save = goodSave(1207);
    expect(resolveSeed(null, save, 5)).toMatchObject({ seed: 1207, reason: 'saved-world' });
    expect(resolveSeed(42, save, 5)).toMatchObject({ seed: 42, save: null, reason: 'url-seed-new' });
    expect(resolveSeed(1207, save, 5)).toMatchObject({ seed: 1207, reason: 'url-seed-matches-save' });
    expect(resolveSeed(null, null, 5)).toMatchObject({ seed: 5, save: null, reason: 'fresh' });
  });

  it('obsolete world versions are not restored', () => {
    const old = { ...goodSave(), worldVersion: WORLD_GEN_VERSION - 1 };
    expect(resolveSeed(null, old, 5)).toMatchObject({ seed: 5, save: null, reason: 'fresh' });
  });
});

describe('Settings validation', () => {
  it('fills defaults and clamps ranges', () => {
    const d = defaultSettings();
    expect(validateSettings(null)).toEqual(d);
    const s = validateSettings({ quality: 'ultra', sensitivity: 99, volume: -1, invertVertical: true });
    expect(s.quality).toBe(d.quality);
    expect(s.sensitivity).toBe(2.5);
    expect(s.volume).toBe(0);
    expect(s.invertVertical).toBe(true);
  });
});
