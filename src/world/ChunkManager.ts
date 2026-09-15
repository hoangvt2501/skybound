/**
 * ChunkManager: streams detailed terrain chunks and a coarse far shell around
 * the player, builds water and instanced vegetation per chunk, and answers
 * height/obstacle queries against the exact rendered surface.
 */
import * as THREE from 'three';
import {
  CHUNK_SIZE, FAR_TILE_SIZE, LOD_RINGS, LOD_SPACING, SEA_LEVEL, VEGETATION_FULL_LOD, type QualitySettings,
} from '../core/config';
import type { WorkerResponse } from '../workers/terrain.worker';
import { WorkerPool } from '../workers/WorkerPool';
import { SPECIES_COLLIDER } from './biomes';
import { chunkKey, WATER_SEGMENTS, COVER_STRIDE, sampleHeightGrid, TREE_STRIDE } from './chunkMesh';
import { hash2 } from './noise';
import { IMPOSTOR_SIZE, type VegetationLibrary } from './Vegetation';
import { createTerrainSample, type WorldGen } from './WorldGen';
import type { WaterMaterial } from '../atmosphere/WaterMaterial';
import { TerrainMaterial } from './TerrainMaterial';

interface ChunkRecord {
  cx: number;
  cz: number;
  key: string;
  lod: number;
  wantedLod: number;
  requestId: number;
  ring: number;
  mesh: THREE.Mesh | null;
  water: THREE.Mesh | null;
  heights: Float32Array | null;
  segments: number;
  spacing: number;
  trees: Float32Array;
  treeMeshes: THREE.InstancedMesh[];
  lastWanted: number;
}

interface FarRecord {
  tx: number;
  tz: number;
  key: string;
  requestId: number;
  mesh: THREE.Mesh | null;
  lastWanted: number;
}

export interface TreeHit {
  x: number;
  y: number;
  z: number;
  radius: number;
  top: number;
  species: number;
}

export interface ChunkStats {
  loaded: number;
  pending: number;
  queued: number;
  farLoaded: number;
  triangles: number;
  trees: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _axis = new THREE.Vector3(0, 1, 0);

/**
 * A geometry that shares the vertex attribute buffers of `base` (uploaded to
 * the GPU once) but can carry its own per-instance attributes.
 */
function shareGeometry(base: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const name of Object.keys(base.attributes)) g.setAttribute(name, base.attributes[name]);
  if (base.index) g.setIndex(base.index);
  g.boundingSphere = base.boundingSphere ? base.boundingSphere.clone() : null;
  g.boundingBox = base.boundingBox ? base.boundingBox.clone() : null;
  return g;
}

export function disposeInstanceGeometry(geometry: THREE.BufferGeometry): void {
  // Three deletes all attached attribute buffers on dispose. Detach borrowed
  // attributes so evicting one chunk cannot invalidate every surviving tree.
  for (const name of Object.keys(geometry.attributes)) {
    if (!(geometry.attributes[name] instanceof THREE.InstancedBufferAttribute)) geometry.deleteAttribute(name);
  }
  geometry.setIndex(null);
  geometry.dispose();
}

export class ChunkManager {
  readonly root: THREE.Group;
  private chunks = new Map<string, ChunkRecord>();
  private far = new Map<string, FarRecord>();
  private pool: WorkerPool;
  private gen: WorldGen;
  private veg: VegetationLibrary;
  private terrainMaterial: THREE.Material;
  private farMaterial: THREE.Material;
  private waterMaterial: WaterMaterial;
  private quality: QualitySettings;
  private tick = 0;
  private lastPlayerChunk = { cx: NaN, cz: NaN };
  private lastUpdateTime = -1;
  private waterGeometry: THREE.PlaneGeometry;
  private sampleScratch = createTerrainSample();
  private shadows = false;
  /** Total triangles currently in loaded chunk + far meshes (approx). */
  private triangleCount = 0;
  private treeCount = 0;
  onFirstChunksReady: (() => void) | null = null;
  private firstReadyFired = false;

  constructor(
    root: THREE.Group,
    gen: WorldGen,
    veg: VegetationLibrary,
    waterMaterial: WaterMaterial,
    quality: QualitySettings,
    workerCount: number,
  ) {
    this.root = root;
    this.gen = gen;
    this.veg = veg;
    this.waterMaterial = waterMaterial;
    this.quality = quality;
    this.terrainMaterial = new TerrainMaterial();
    this.farMaterial = new TerrainMaterial();
    (this.farMaterial as TerrainMaterial).terrainUniforms.uDetail.value = 0;
    this.pool = new WorkerPool(gen.seed, workerCount);
    this.pool.onMessage((m) => this.onResult(m));
    // A job evicted from the bounded queue must free its record so the next
    // update can request it again instead of leaving a hole in the world.
    this.pool.onDrop((req) => {
      if (req.type === 'chunk') {
        const rec = this.chunks.get(chunkKey(req.cx, req.cz));
        if (rec && rec.requestId === req.id) rec.requestId = 0;
      } else if (req.type === 'far') {
        const rec = this.far.get(`${req.tx},${req.tz}`);
        if (rec && rec.requestId === req.id) rec.requestId = 0;
      }
    });
    // 48 segments (~10.7 m) so shoreline depth interpolation follows small ponds.
    this.waterGeometry = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, WATER_SEGMENTS, WATER_SEGMENTS);
    this.waterGeometry.rotateX(-Math.PI / 2);
    this.waterGeometry.translate(CHUNK_SIZE / 2, 0, CHUNK_SIZE / 2);
  }

  get workerPool(): WorkerPool {
    return this.pool;
  }

  /** Near-field terrain detail strength (0 disables grain/cracks; diagnostics and presets). */
  setDetail(v: number): void {
    (this.terrainMaterial as TerrainMaterial).terrainUniforms.uDetail.value = v;
  }

  /** Global coordinates of the render origin (for world-anchored shader detail). */
  setOrigin(x: number, z: number): void {
    (this.terrainMaterial as TerrainMaterial).setOrigin(x, z);
    (this.farMaterial as TerrainMaterial).setOrigin(x, z);
  }

  setShadows(on: boolean): void {
    this.shadows = on;
    for (const rec of this.chunks.values()) {
      if (rec.mesh) rec.mesh.receiveShadow = on;
      for (const t of rec.treeMeshes) t.castShadow = on;
    }
  }

  setQuality(q: QualitySettings): void {
    const vegChanged = q.groundCover !== this.quality.groundCover;
    this.quality = q;
    if (vegChanged) {
      // Force rebuild so ground cover matches the preset (trees are unchanged).
      for (const rec of this.chunks.values()) {
        rec.lod = -1;
        rec.requestId = 0;
      }
      this.pool.cancelWhere(req => req.type === 'chunk');
    }
    this.lastPlayerChunk.cx = NaN;
  }

  private lodForRing(ring: number): number {
    let lod = 0;
    for (let i = 0; i < LOD_RINGS.length; i++) if (ring >= LOD_RINGS[i]) lod = i;
    return lod;
  }

  /**
   * Refresh the wanted chunk set around a global position. Cheap enough to
   * call every frame; it only does real work when the player crosses a chunk
   * boundary or every 400 ms.
   */
  update(gx: number, gz: number, fwdX: number, fwdZ: number, now: number, force = false): void {
    const pcx = Math.floor(gx / CHUNK_SIZE);
    const pcz = Math.floor(gz / CHUNK_SIZE);
    const moved = pcx !== this.lastPlayerChunk.cx || pcz !== this.lastPlayerChunk.cz;
    if (!force && !moved && now - this.lastUpdateTime < 0.4) return;
    this.lastUpdateTime = now;
    this.lastPlayerChunk.cx = pcx;
    this.lastPlayerChunk.cz = pcz;
    this.tick++;
    const R = this.quality.chunkRadius;
    const fl = Math.hypot(fwdX, fwdZ) || 1;
    const fx = fwdX / fl, fz = fwdZ / fl;
    const localX = (gx - pcx * CHUNK_SIZE) / CHUNK_SIZE - 0.5;
    const localZ = (gz - pcz * CHUNK_SIZE) / CHUNK_SIZE - 0.5;

    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const ring = Math.max(Math.abs(dx), Math.abs(dz));
        const ex = dx - localX, ez = dz - localZ;
        const dist = Math.hypot(ex, ez);
        if (dist > R + 0.5) continue;
        const cx = pcx + dx, cz = pcz + dz;
        const key = chunkKey(cx, cz);
        let rec = this.chunks.get(key);
        const wantedLod = this.lodForRing(ring);
        if (!rec) {
          rec = {
            cx, cz, key, lod: -1, wantedLod, requestId: 0, ring, mesh: null, water: null,
            heights: null, segments: 0, spacing: 0, trees: new Float32Array(0), treeMeshes: [], lastWanted: this.tick,
          };
          this.chunks.set(key, rec);
        }
        rec.lastWanted = this.tick;
        rec.ring = ring;
        // Hysteresis: only coarsen once we are a full ring beyond the boundary.
        let target = wantedLod;
        if (rec.lod >= 0 && target > rec.lod && ring < LOD_RINGS[target] + 1) target = rec.lod;
        rec.wantedLod = target;
        if (rec.lod !== target && rec.requestId === 0) {
          const ahead = dist > 0.01 ? (ex * fx + ez * fz) / dist : 1;
          const priority = dist - 1.4 * ahead + target * 0.6;
          this.requestChunk(rec, target, priority);
        }
      }
    }

    // Evict chunks that are out of range (with hysteresis of one ring).
    for (const rec of this.chunks.values()) {
      if (rec.lastWanted === this.tick) continue;
      const ring = Math.max(Math.abs(rec.cx - pcx), Math.abs(rec.cz - pcz));
      if (ring > R + 1) this.disposeChunk(rec);
    }
    this.pool.cancelWhere((req) => {
      if (req.type === 'chunk') {
        const rec = this.chunks.get(chunkKey(req.cx, req.cz));
        if (!rec || rec.requestId !== req.id) return true;
        return false;
      }
      if (req.type === 'far') {
        const rec = this.far.get(`${req.tx},${req.tz}`);
        return !rec || rec.requestId !== req.id;
      }
      return false;
    });

    this.updateFar(gx, gz, pcx, pcz);
  }

  private requestChunk(rec: ChunkRecord, lod: number, priority: number): void {
    const id = this.pool.allocId();
    rec.requestId = id;
    const ok = this.pool.enqueue({ type: 'chunk', id, cx: rec.cx, cz: rec.cz, lod, cover: this.quality.groundCover }, priority);
    if (!ok) rec.requestId = 0; // dropped by bounded queue; retried next update
  }

  private updateFar(gx: number, gz: number, pcx: number, pcz: number): void {
    const FR = this.quality.farRadius;
    const R = this.quality.chunkRadius;
    const perTile = FAR_TILE_SIZE / CHUNK_SIZE;
    const ptx = Math.floor(gx / FAR_TILE_SIZE), ptz = Math.floor(gz / FAR_TILE_SIZE);
    if (FR > 0) {
      for (let dz = -FR; dz <= FR; dz++) {
        for (let dx = -FR; dx <= FR; dx++) {
          const tx = ptx + dx, tz = ptz + dz;
          // Skip tiles fully covered by detailed chunks.
          const c0x = tx * perTile, c0z = tz * perTile;
          let maxCheb = 0;
          for (const [ex, ez] of [[c0x, c0z], [c0x + perTile - 1, c0z], [c0x, c0z + perTile - 1], [c0x + perTile - 1, c0z + perTile - 1]]) {
            maxCheb = Math.max(maxCheb, Math.abs(ex - pcx), Math.abs(ez - pcz));
          }
          if (maxCheb <= R - 1) continue;
          const key = `${tx},${tz}`;
          let rec = this.far.get(key);
          if (!rec) {
            rec = { tx, tz, key, requestId: 0, mesh: null, lastWanted: this.tick };
            this.far.set(key, rec);
          }
          rec.lastWanted = this.tick;
          if (!rec.mesh && rec.requestId === 0) {
            const id = this.pool.allocId();
            rec.requestId = id;
            const ok = this.pool.enqueue({ type: 'far', id, tx, tz }, 20 + Math.hypot(dx, dz));
            if (!ok) rec.requestId = 0;
          }
        }
      }
    }
    for (const rec of this.far.values()) {
      if (rec.lastWanted !== this.tick) {
        const ring = Math.max(Math.abs(rec.tx - ptx), Math.abs(rec.tz - ptz));
        if (ring > FR + 1 || FR === 0) this.disposeFar(rec);
      }
    }
  }

  /** Results waiting for main-thread installation (bounded per frame). */
  private installQueue: WorkerResponse[] = [];
  /** Wall-clock time shared with the vegetation shaders (drives the dissolve; keeps running while paused). */
  time = 0;
  /** Freshly born meshes dissolve in with the fading material, then settle onto the plain one. */
  private settling: { im: THREE.InstancedMesh; until: number }[] = [];
  /** Instanced meshes of a replaced representation, kept while they dissolve out. */
  private fading: { im: THREE.InstancedMesh; until: number }[] = [];

  private onResult(msg: WorkerResponse): void {
    // Defer GPU uploads to processInstalls() so a burst of results (start,
    // teleport, quality change) does not stall a single frame.
    // Map tiles have their own consumer: never enqueue their pixel buffers here.
    if (msg.type !== 'chunk' && msg.type !== 'far') return;
    this.installQueue.push(msg);
    const rank = (m: WorkerResponse) => m.type === 'chunk' ? (this.chunks.get(chunkKey(m.cx, m.cz))?.ring ?? 1000) : 100;
    this.installQueue.sort((a, b) => rank(a) - rank(b));
  }

  /**
   * Install up to `budgetMs` worth of pending results. Call once per frame.
   * Returns the number of results installed.
   */
  processInstalls(budgetMs = 4, maxCount = 6): number {
    while (this.fading.length > 0 && this.fading[0].until <= this.time) {
      const { im } = this.fading.shift()!;
      this.root.remove(im);
      disposeInstanceGeometry(im.geometry);
      im.dispose();
    }
    // A few swaps per frame: each settled mesh needs a new vertex-array binding for the plain program,
    // and the whole opening set would otherwise settle in one frame (a 50 ms hitch on integrated GPUs).
    for (let swaps = 0; swaps < 6 && this.settling.length > 0 && this.settling[0].until <= this.time; swaps++) {
      const { im } = this.settling.shift()!;
      const life = im.geometry.getAttribute('aLife') as THREE.InstancedBufferAttribute | undefined;
      // A mesh retired before it settled keeps the dissolving material until it is disposed.
      if (im.parent === this.root && life && life.getY(0) >= 1e9) im.material = this.veg.settledTwin(im.material as THREE.Material);
    }
    if (this.installQueue.length === 0) return 0;
    const t0 = performance.now();
    let n = 0;
    while (this.installQueue.length > 0 && n < maxCount) {
      const msg = this.installQueue.shift()!;
      this.install(msg);
      n++;
      if (performance.now() - t0 > budgetMs) break;
    }
    return n;
  }

  private install(msg: WorkerResponse): void {
    if (msg.type === 'chunk') {
      const rec = this.chunks.get(chunkKey(msg.cx, msg.cz));
      if (!rec || rec.requestId !== msg.id) return; // stale
      rec.requestId = 0;
      this.installChunk(rec, msg);
      if (!this.firstReadyFired && this.onFirstChunksReady) {
        // Consider the world ready when the player's ring-0/1 chunks exist.
        let ready = 0, wanted = 0;
        for (const r of this.chunks.values()) {
          if (r.ring <= 1) {
            wanted++;
            if (r.mesh) ready++;
          }
        }
        if (wanted > 0 && ready >= wanted) {
          this.firstReadyFired = true;
          this.onFirstChunksReady();
        }
      }
      if (rec.wantedLod !== rec.lod) {
        // LOD changed while building: request again.
        this.requestChunk(rec, rec.wantedLod, rec.ring);
      }
    } else if (msg.type === 'far') {
      const rec = this.far.get(`${msg.tx},${msg.tz}`);
      if (!rec || rec.requestId !== msg.id) return;
      rec.requestId = 0;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(msg.positions, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(msg.normals, 3));
      g.setAttribute('color', new THREE.BufferAttribute(msg.colors, 3));
      g.setAttribute('aux', new THREE.BufferAttribute(msg.aux, 4));
      g.setIndex(new THREE.BufferAttribute(msg.indices, 1));
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, this.farMaterial);
      mesh.position.set(msg.tx * FAR_TILE_SIZE, 0, msg.tz * FAR_TILE_SIZE);
      mesh.updateMatrix();
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = -1;
      this.root.add(mesh);
      rec.mesh = mesh;
      this.triangleCount += msg.indices.length / 3;
    }
  }

  private installChunk(rec: ChunkRecord, msg: Extract<WorkerResponse, { type: 'chunk' }>): void {
    this.retireChunkObjects(rec);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(msg.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(msg.normals, 3));
    g.setAttribute('color', new THREE.BufferAttribute(msg.colors, 3));
    g.setAttribute('aux', new THREE.BufferAttribute(msg.aux, 4));
    g.setIndex(new THREE.BufferAttribute(msg.indices, 1));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, this.terrainMaterial);
    mesh.position.set(rec.cx * CHUNK_SIZE, 0, rec.cz * CHUNK_SIZE);
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
    mesh.receiveShadow = this.shadows;
    this.root.add(mesh);
    rec.mesh = mesh;
    rec.lod = msg.lod;
    rec.heights = msg.heights;
    rec.segments = msg.segments;
    rec.spacing = msg.spacing;
    rec.trees = msg.trees;
    this.triangleCount += msg.indices.length / 3;

    if (msg.hasWater) {
      const wg = this.waterGeometry.clone();
      wg.setAttribute('depth', new THREE.BufferAttribute(msg.waterDepth, 1));
      wg.setAttribute('exposure', new THREE.BufferAttribute(msg.waterExposure, 1));
      const water = new THREE.Mesh(wg, this.waterMaterial);
      water.position.set(rec.cx * CHUNK_SIZE, SEA_LEVEL, rec.cz * CHUNK_SIZE);
      water.updateMatrix();
      water.matrixAutoUpdate = false;
      water.renderOrder = 2;
      this.root.add(water);
      rec.water = water;
    }

    const ox = rec.cx * CHUNK_SIZE, oz = rec.cz * CHUNK_SIZE;
    const n = msg.trees.length / TREE_STRIDE;
    const finish = (im: THREE.InstancedMesh) => {
      // Birth now, death never: the shader dissolves the instances in over 0.7 s.
      const life = new Float32Array(im.count * 2);
      for (let i = 0; i < im.count; i++) { life[i * 2] = this.time; life[i * 2 + 1] = 1e9; }
      im.geometry.setAttribute('aLife', new THREE.InstancedBufferAttribute(life, 2));
      this.settling.push({ im, until: this.time + 0.8 });
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.position.set(ox, 0, oz);
      im.updateMatrix();
      im.matrixAutoUpdate = false;
      this.root.add(im);
      rec.treeMeshes.push(im);
    };
    if (n > 0 && msg.lod <= VEGETATION_FULL_LOD) {
      // Full trees: one InstancedMesh per (species, geometry variant) present.
      // The variant is a stable hash of the tree position.
      const variantOf = (o: number) => {
        const s = msg.trees[o + 3];
        return hash2(Math.round(msg.trees[o] * 4), Math.round(msg.trees[o + 2] * 4), 77) % this.veg.variants(s);
      };
      const key = (s: number, v: number) => s * 8 + v;
      const counts = new Map<number, number>();
      for (let i = 0; i < n; i++) {
        const o = i * TREE_STRIDE;
        const k = key(msg.trees[o + 3], variantOf(o));
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const meshes = new Map<number, { im: THREE.InstancedMesh; rand: Float32Array; cursor: number }>();
      for (const [k, c] of counts) {
        const s = Math.floor(k / 8), v = k % 8;
        const im = new THREE.InstancedMesh(this.veg.geometry(s, v), this.veg.materialFading, c);
        im.instanceMatrix.setUsage(THREE.StaticDrawUsage);
        im.castShadow = this.shadows;
        const rand = new Float32Array(c);
        meshes.set(k, { im, rand, cursor: 0 });
      }
      for (let i = 0; i < n; i++) {
        const o = i * TREE_STRIDE;
        const s = msg.trees[o + 3];
        const entry = meshes.get(key(s, variantOf(o)))!;
        _p.set(msg.trees[o] - ox, msg.trees[o + 1] - 0.15, msg.trees[o + 2] - oz);
        _q.setFromAxisAngle(_axis, msg.trees[o + 5]);
        const sc = msg.trees[o + 4];
        _s.set(sc, sc, sc);
        _m.compose(_p, _q, _s);
        entry.im.setMatrixAt(entry.cursor, _m);
        entry.rand[entry.cursor] = hash2(Math.round(msg.trees[o] * 3), Math.round(msg.trees[o + 2] * 3), 913) / 4294967296;
        entry.cursor++;
      }
      for (const { im, rand } of meshes.values()) {
        // Per-instance random for crown displacement/wind phase. The geometry
        // is shared, so the attribute is attached to a shallow per-mesh copy.
        const g = shareGeometry(im.geometry);
        g.setAttribute('aRand', new THREE.InstancedBufferAttribute(rand, 1));
        im.geometry = g;
        finish(im);
      }
    } else if (n > 0) {
      // Impostors: crossed billboards, one tile per species.
      const im = new THREE.InstancedMesh(shareGeometry(this.veg.impostorGeometry), this.veg.impostorMaterialFading, n);
      im.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      const tile = new Float32Array(n), rand = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const o = i * TREE_STRIDE;
        const s = msg.trees[o + 3];
        const sc = msg.trees[o + 4];
        const [w, h] = IMPOSTOR_SIZE[s];
        _p.set(msg.trees[o] - ox, msg.trees[o + 1] - 0.2, msg.trees[o + 2] - oz);
        _q.setFromAxisAngle(_axis, msg.trees[o + 5]);
        _s.set(w * sc, h * sc, w * sc);
        _m.compose(_p, _q, _s);
        im.setMatrixAt(i, _m);
        tile[i] = s;
        rand[i] = hash2(Math.round(msg.trees[o]), Math.round(msg.trees[o + 2]), 5) / 4294967296;
      }
      im.geometry.setAttribute('aTile', new THREE.InstancedBufferAttribute(tile, 1));
      im.geometry.setAttribute('aRand', new THREE.InstancedBufferAttribute(rand, 1));
      finish(im);
    }
    // Ground cover (LOD0 only): purely visual.
    const cn = msg.cover.length / COVER_STRIDE;
    if (cn > 0) {
      const im = new THREE.InstancedMesh(shareGeometry(this.veg.coverGeometry), this.veg.coverMaterialFading, cn);
      im.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      const tile = new Float32Array(cn), rand = new Float32Array(cn);
      for (let i = 0; i < cn; i++) {
        const o = i * COVER_STRIDE;
        const sc = msg.cover[o + 3];
        _p.set(msg.cover[o] - ox, msg.cover[o + 1] - 0.05, msg.cover[o + 2] - oz);
        _q.setFromAxisAngle(_axis, msg.cover[o + 4]);
        _s.set(1.4 * sc, 0.9 * sc, 1.4 * sc);
        _m.compose(_p, _q, _s);
        im.setMatrixAt(i, _m);
        tile[i] = msg.cover[o + 5];
        rand[i] = hash2(Math.round(msg.cover[o] * 2), Math.round(msg.cover[o + 2] * 2), 17) / 4294967296;
      }
      im.geometry.setAttribute('aTile', new THREE.InstancedBufferAttribute(tile, 1));
      im.geometry.setAttribute('aRand', new THREE.InstancedBufferAttribute(rand, 1));
      finish(im);
    }
    this.treeCount += n;
  }

  /**
   * Like removeChunkObjects, but a replaced vegetation representation keeps
   * drawing while it dissolves out (its death time is written to every
   * instance); the terrain and water swap immediately, which is invisible.
   */
  private retireChunkObjects(rec: ChunkRecord): void {
    if (rec.treeMeshes.length > 0 && this.time > 0) {
      for (const im of rec.treeMeshes) {
        const life = im.geometry.getAttribute('aLife') as THREE.InstancedBufferAttribute | undefined;
        if (life) { for (let i = 0; i < life.count; i++) life.setY(i, this.time); life.needsUpdate = true; }
        im.material = this.veg.fadingTwin(im.material as THREE.Material);
        this.fading.push({ im, until: this.time + 0.85 });
      }
      this.treeCount -= rec.trees.length / TREE_STRIDE;
      rec.treeMeshes.length = 0;
      rec.trees = new Float32Array(0);
      rec.heights = null;
    }
    this.removeChunkObjects(rec);
  }

  private removeChunkObjects(rec: ChunkRecord): void {
    if (rec.mesh) {
      this.root.remove(rec.mesh);
      this.triangleCount -= (rec.mesh.geometry.index?.count ?? 0) / 3;
      rec.mesh.geometry.dispose();
      rec.mesh = null;
    }
    if (rec.water) {
      this.root.remove(rec.water);
      rec.water.geometry.dispose();
      rec.water = null;
    }
    for (const im of rec.treeMeshes) {
      this.root.remove(im);
      // The per-mesh geometry only holds instance attributes plus references
      // to shared buffers; disposing it frees the instance buffers.
      disposeInstanceGeometry(im.geometry);
      im.dispose();
    }
    this.treeCount -= rec.trees.length / TREE_STRIDE;
    rec.treeMeshes.length = 0;
    rec.trees = new Float32Array(0);
    rec.heights = null;
  }

  private disposeChunk(rec: ChunkRecord): void {
    this.removeChunkObjects(rec);
    this.chunks.delete(rec.key);
  }

  private disposeFar(rec: FarRecord): void {
    if (rec.mesh) {
      this.root.remove(rec.mesh);
      this.triangleCount -= (rec.mesh.geometry.index?.count ?? 0) / 3;
      rec.mesh.geometry.dispose();
      rec.mesh = null;
    }
    this.far.delete(rec.key);
  }

  /** Is the detailed chunk under a global position loaded? */
  isLoadedAt(gx: number, gz: number): boolean {
    const rec = this.chunks.get(chunkKey(Math.floor(gx / CHUNK_SIZE), Math.floor(gz / CHUNK_SIZE)));
    return !!rec?.heights;
  }

  /**
   * Terrain height at a global position, interpolating the exact rendered
   * triangle when the chunk is loaded, otherwise the analytic sampler.
   */
  heightAt(gx: number, gz: number): number {
    const cx = Math.floor(gx / CHUNK_SIZE), cz = Math.floor(gz / CHUNK_SIZE);
    const rec = this.chunks.get(chunkKey(cx, cz));
    if (rec && rec.heights) {
      return sampleHeightGrid(rec.heights, rec.segments, rec.spacing, gx - cx * CHUNK_SIZE, gz - cz * CHUNK_SIZE);
    }
    return this.gen.heightAt(gx, gz);
  }

  /** Surface height including water (never below sea level). */
  surfaceAt(gx: number, gz: number): number {
    return Math.max(this.heightAt(gx, gz), SEA_LEVEL);
  }

  /** Iterate trees whose collider circle intersects the given circle. */
  forEachTreeNear(gx: number, gz: number, radius: number, cb: (t: TreeHit) => boolean | void): void {
    const cx0 = Math.floor((gx - radius) / CHUNK_SIZE), cx1 = Math.floor((gx + radius) / CHUNK_SIZE);
    const cz0 = Math.floor((gz - radius) / CHUNK_SIZE), cz1 = Math.floor((gz + radius) / CHUNK_SIZE);
    const hit: TreeHit = { x: 0, y: 0, z: 0, radius: 0, top: 0, species: 0 };
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const rec = this.chunks.get(chunkKey(cx, cz));
        if (!rec || rec.trees.length === 0) continue;
        const t = rec.trees;
        for (let i = 0; i < t.length; i += TREE_STRIDE) {
          const sp = t[i + 3];
          const sc = t[i + 4];
          const col = SPECIES_COLLIDER[sp];
          const r = col.radius * sc;
          const dx = t[i] - gx, dz = t[i + 2] - gz;
          const rr = radius + r;
          if (dx * dx + dz * dz > rr * rr) continue;
          hit.x = t[i]; hit.y = t[i + 1]; hit.z = t[i + 2];
          hit.radius = r; hit.top = t[i + 1] + col.height * sc; hit.species = sp;
          if (cb(hit) === true) return;
        }
      }
    }
  }

  stats(): ChunkStats {
    let loaded = 0, pending = 0, farLoaded = 0;
    for (const r of this.chunks.values()) {
      if (r.mesh) loaded++;
      if (r.requestId) pending++;
    }
    for (const f of this.far.values()) if (f.mesh) farLoaded++;
    return { loaded, pending, queued: this.pool.queued, farLoaded, triangles: Math.round(this.triangleCount), trees: this.treeCount };
  }

  dispose(): void {
    this.installQueue.length = 0;
    for (const { im } of this.fading) { this.root.remove(im); disposeInstanceGeometry(im.geometry); im.dispose(); }
    this.fading.length = 0;
    this.settling.length = 0;
    for (const rec of Array.from(this.chunks.values())) this.disposeChunk(rec);
    for (const rec of Array.from(this.far.values())) this.disposeFar(rec);
    this.pool.dispose();
    this.waterGeometry.dispose();
    this.terrainMaterial.dispose();
    this.farMaterial.dispose();
  }
}

export { LOD_SPACING };
