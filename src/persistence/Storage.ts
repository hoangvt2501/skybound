/**
 * Safe localStorage wrapper. Every operation is guarded: private browsing,
 * disabled storage and quota errors degrade to in-memory behaviour.
 */
export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): boolean;
  remove(key: string): void;
  readonly available: boolean;
}

export class LocalStore implements KeyValueStore {
  readonly available: boolean;
  private memory = new Map<string, string>();

  constructor() {
    let ok = false;
    try {
      const k = '__skybound_probe__';
      window.localStorage.setItem(k, '1');
      window.localStorage.removeItem(k);
      ok = true;
    } catch {
      ok = false;
    }
    this.available = ok;
  }

  get(key: string): string | null {
    if (!this.available) return this.memory.get(key) ?? null;
    try {
      return window.localStorage.getItem(key);
    } catch {
      return this.memory.get(key) ?? null;
    }
  }

  set(key: string, value: string): boolean {
    this.memory.set(key, value);
    if (!this.available) return false;
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  remove(key: string): void {
    this.memory.delete(key);
    if (!this.available) return;
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}

/** In-memory store for tests. */
export class MemoryStore implements KeyValueStore {
  readonly available = true;
  private m = new Map<string, string>();
  get(key: string): string | null {
    return this.m.get(key) ?? null;
  }
  set(key: string, value: string): boolean {
    this.m.set(key, value);
    return true;
  }
  remove(key: string): void {
    this.m.delete(key);
  }
}
