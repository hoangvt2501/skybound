/**
 * ChunkManager: streams detailed terrain chunks and a coarse far shell around
 * the player, builds water and instanced vegetation per chunk, and answers
 * height/obstacle queries against the exact rendered surface.
 */
import * as THREE from 'three';
import {
  CHUNK_SIZE, FAR_TILE_SIZE, LOD_RINGS, LOD_SPACING, SEA_LEVEL, VEGETATION_FULL_LOD, VEGETATION_MAX_LOD, type QualitySettings,
} from '../core/config';
import type { WorkerResponse } from '../workers/terrain.worker';
import { WorkerPool } from '../workers/WorkerPool';
import { SPECIES_COLLIDER } from './biomes';
import { chunkKey, WATER_SEGMENTS, COVER_STRIDE, sampleHeightGrid, TREE_STRIDE } from './chunkMesh';
import { hash2 } from './noise';
import { IMPOSTOR_SIZE, SHADOW_CAST, coverTint, speciesTint, type ShadowClass, type VegetationLibrary } from './Vegetation';
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
  /** The coarser surface at the same grid (geomorph source), for collision blending. */
  parentHeights: Float32Array | null;
  /** Active geomorph of `mesh`: uMorph runs from `from` to `to` over MORPH_SECONDS from `start` (wall clock). */
  morph: { start: number; from: number; to: number; material: TerrainMaterial } | null;
  /** A coarser build waiting for the current mesh to morph down onto its surface before it swaps in. */
  pendingSwap: Extract<WorkerResponse, { type: 'chunk' }> | null;
  segments: number;
  spacing: number;
  trees: Float32Array;
  /** Tree representation currently instanced (full geometry near the player, impostors beyond). */
  vegRep: VegRep;
  treeMeshes: THREE.InstancedMesh[];
  coverMeshes: THREE.InstancedMesh[];
  /** Low-poly shadow casters standing in for the full trees. */
  shadowMeshes: THREE.InstancedMesh[];
  /** Ground cover waiting for its own frame to be instanced. */
  pendingCover: Float32Array | null;
  lastWanted: number;
}

type VegRep = 'none' | 'full' | 'impostor';
/** Chunk-centre distance (m) within which trees are drawn as full geometry; beyond it plus the hysteresis, impostors. */
const FULL_TREE_DISTANCE = 700;
const FULL_TREE_HYSTERESIS = 120;

/** Duration of a terrain LOD geomorph (wall clock). */
const MORPH_SECONDS = 0.6;
const COARSEST_LOD = LOD_SPACING.length - 1;
function smoothstep01(t: number): number { const c = t < 0 ? 0 : t > 1 ? 1 : t; return c * c * (3 - 2 * c); }

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
  /** Top of the collision cylinder. */
  top: number;
  species: number;
  /** Highest point of the rendered model over the trunk (world space, with the instance's stretch and yaw). */
  peakX: number;
  peakY: number;
  peakZ: number;
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

  /** Finished builds still waiting for their main-thread install (a cheap "is the streamer busy" signal). */
  get installPending(): number {
    return this.installQueue.length;
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
      for (const sm of rec.shadowMeshes) { sm.castShadow = on; sm.visible = on; }
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
    this.viewX = gx; this.viewZ = gz;
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
            heights: null, parentHeights: null, morph: null, pendingSwap: null, segments: 0, spacing: 0, trees: new Float32Array(0), vegRep: 'none', treeMeshes: [], coverMeshes: [], shadowMeshes: [], pendingCover: null, lastWanted: this.tick,
          };
          this.chunks.set(key, rec);
        }
        rec.lastWanted = this.tick;
        rec.ring = ring;
        if (rec.mesh && rec.trees.length > 0 && rec.lod <= VEGETATION_FULL_LOD && this.wantedRep(rec) !== rec.vegRep) this.revegQueue.add(rec);
        // Hysteresis: only coarsen once we are a full ring beyond the boundary.
        let target = wantedLod;
        if (rec.lod >= 0 && target > rec.lod && ring < LOD_RINGS[target] + 1) target = rec.lod;
        rec.wantedLod = target;
        const swapPending = rec.pendingSwap !== null && rec.pendingSwap.lod === target;
        if (rec.lod !== target && rec.requestId === 0 && !swapPending) {
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
  /** Chunks whose terrain mesh is geomorphing this frame. */
  private morphing = new Set<ChunkRecord>();
  /** Chunks whose tree representation should change (one is rebuilt per frame). */
  private revegQueue = new Set<ChunkRecord>();
  /** Chunks whose ground cover still has to be instanced (one per frame). */
  private coverQueue: ChunkRecord[] = [];
  /** Last position the wanted set was computed for (the look-ahead point while flying). */
  private viewX = 0;
  private viewZ = 0;

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
    this.stepMorphs();
    if (this.revegQueue.size > 0) {
      const rec = this.revegQueue.values().next().value as ChunkRecord;
      this.revegQueue.delete(rec);
      this.reinstanceTrees(rec);
    }
    while (this.coverQueue.length > 0) {
      const rec = this.coverQueue.shift()!;
      const cover = rec.pendingCover;
      rec.pendingCover = null;
      if (cover && rec.mesh) { this.buildCover(rec, cover); break; }
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
      if (rec.pendingSwap) return; // the coarser mesh swaps in when the geomorph completes
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
      ChunkManager.warmFirstDraw(mesh);
      this.root.add(mesh);
      rec.mesh = mesh;
      this.triangleCount += msg.indices.length / 3;
    }
  }

  /**
   * A finished build arrives. Refinement (a finer LOD replacing a coarser one) and a coarsest chunk
   * rising out of the far shell start at the parent surface and morph to their own over
   * MORPH_SECONDS. Coarsening keeps the finer mesh, morphs it down onto the coarser surface, then
   * swaps (see stepMorphs), so the terrain never pops at a ring boundary.
   */
  private installChunk(rec: ChunkRecord, msg: Extract<WorkerResponse, { type: 'chunk' }>): void {
    const live = rec.mesh !== null && rec.lod >= 0 && this.time > 0;
    if (live && msg.lod > rec.lod) {
      rec.pendingSwap = msg;
      this.startMorph(rec, this.morphValue(rec), 0);
      return;
    }
    rec.pendingSwap = null;
    // A chunk rising out of the far shell starts a few metres above it: at 4 km the depth buffer
    // resolves only ~3 m, so a coincident start would z-fight for the first frames.
    const fromFar = !live && msg.lod === COARSEST_LOD && this.time > 0;
    this.installChunkNow(rec, msg, live && msg.lod < rec.lod ? 0 : fromFar ? 0.25 : null);
  }

  private installChunkNow(rec: ChunkRecord, msg: Extract<WorkerResponse, { type: 'chunk' }>, morphFrom: number | null): void {
    this.retireChunkObjects(rec);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(msg.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(msg.normals, 3));
    g.setAttribute('color', new THREE.BufferAttribute(msg.colors, 3));
    g.setAttribute('aux', new THREE.BufferAttribute(msg.aux, 4));
    g.setAttribute('aMorph', new THREE.BufferAttribute(msg.morph, 4));
    g.setIndex(new THREE.BufferAttribute(msg.indices, 1));
    // Bounding sphere from the worker's height range (plus the skirt) instead of a pass over 17k vertices.
    {
      const skirt = msg.spacing * 3 + 8;
      const minY = msg.minHeight - skirt - 20; // the far-shell parent surface sits up to 18 m below the terrain
      const maxY = msg.maxHeight + 20;
      const half = CHUNK_SIZE / 2, halfY = (maxY - minY) / 2;
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(half, (minY + maxY) / 2, half), Math.hypot(half, halfY, half));
    }
    const mesh = new THREE.Mesh(g, this.terrainMaterial);
    mesh.position.set(rec.cx * CHUNK_SIZE, 0, rec.cz * CHUNK_SIZE);
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
    mesh.receiveShadow = this.shadows;
    ChunkManager.warmFirstDraw(mesh);
    this.root.add(mesh);
    rec.mesh = mesh;
    rec.lod = msg.lod;
    rec.heights = msg.heights;
    rec.parentHeights = msg.parentHeights;
    rec.segments = msg.segments;
    rec.spacing = msg.spacing;
    rec.trees = msg.trees;
    this.triangleCount += msg.indices.length / 3;
    if (morphFrom !== null) this.startMorph(rec, morphFrom, 1);

    if (msg.hasWater) {
      const wg = this.waterGeometry.clone();
      wg.setAttribute('depth', new THREE.BufferAttribute(msg.waterDepth, 1));
      wg.setAttribute('exposure', new THREE.BufferAttribute(msg.waterExposure, 1));
      const water = new THREE.Mesh(wg, this.waterMaterial);
      water.position.set(rec.cx * CHUNK_SIZE, SEA_LEVEL, rec.cz * CHUNK_SIZE);
      water.updateMatrix();
      water.matrixAutoUpdate = false;
      water.renderOrder = 2;
      ChunkManager.warmFirstDraw(water);
      this.root.add(water);
      rec.water = water;
    }

    const n = msg.trees.length / TREE_STRIDE;
    rec.vegRep = 'none';
    if (n > 0) this.buildTrees(rec, this.wantedRep(rec));
    // Ground cover (up to ~1600 instances) is instanced on a later frame so one install never
    // stacks terrain, trees and cover in the same frame.
    rec.pendingCover = msg.cover.length > 0 ? msg.cover : null;
    if (rec.pendingCover) this.coverQueue.push(rec);
    this.treeCount += n;
  }

  /** Birth bookkeeping shared by every instanced vegetation mesh: dissolve in over 0.7 s, settle, chunk placement. */
  /**
   * Draw a new mesh once even while it is outside the view: three uploads its buffers on the first
   * draw, and a mesh installed behind the bird would otherwise pay that upload in the frame the camera
   * swings round to it (a 180-degree drag used to draw about 400 meshes for the first time within a
   * second, with a run of 33 ms frames). One off-screen draw costs its vertex work only.
   */
  private static warmFirstDraw(obj: THREE.Object3D): void {
    obj.frustumCulled = false;
    obj.onAfterRender = () => { obj.frustumCulled = true; obj.onAfterRender = () => {}; };
  }

  private placeInstanced(rec: ChunkRecord, im: THREE.InstancedMesh, list: THREE.InstancedMesh[]): void {
    const life = new Float32Array(im.count * 2);
    for (let i = 0; i < im.count; i++) { life[i * 2] = this.time; life[i * 2 + 1] = 1e9; }
    im.geometry.setAttribute('aLife', new THREE.InstancedBufferAttribute(life, 2));
    this.settling.push({ im, until: this.time + 0.8 });
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    im.position.set(rec.cx * CHUNK_SIZE, 0, rec.cz * CHUNK_SIZE);
    im.updateMatrix();
    im.matrixAutoUpdate = false;
    ChunkManager.warmFirstDraw(im);
    this.root.add(im);
    list.push(im);
  }

  /**
   * Which tree representation a chunk should show. Full geometry only near the player (a 700-triangle
   * tree at 600 m is a dozen pixels tall and costs the same vertex work as one next to the bird);
   * impostors beyond, with hysteresis so a chunk on the boundary does not flip back and forth.
   */
  private wantedRep(rec: ChunkRecord): VegRep {
    if (rec.trees.length === 0 || rec.lod > VEGETATION_MAX_LOD) return 'none';
    if (rec.lod > VEGETATION_FULL_LOD) return 'impostor';
    const d = Math.hypot((rec.cx + 0.5) * CHUNK_SIZE - this.viewX, (rec.cz + 0.5) * CHUNK_SIZE - this.viewZ);
    if (d < FULL_TREE_DISTANCE) return 'full';
    if (d > FULL_TREE_DISTANCE + FULL_TREE_HYSTERESIS) return 'impostor';
    return rec.vegRep === 'none' ? 'full' : rec.vegRep;
  }

  /** Instance a chunk's trees as full geometry (with low-poly shadow casters) or as impostors. */
  private buildTrees(rec: ChunkRecord, rep: VegRep): void {
    const trees = rec.trees, n = trees.length / TREE_STRIDE, ox = rec.cx * CHUNK_SIZE, oz = rec.cz * CHUNK_SIZE;
    rec.vegRep = rep;
    if (n === 0 || rep === 'none') return;
    if (rep === 'full') {
      // Full trees: one InstancedMesh per (species, geometry variant) present.
      // The variant is a stable hash of the tree position.
      const variantOf = (o: number) => ChunkManager.treeVariant(trees[o], trees[o + 2], this.veg.variants(trees[o + 3]));
      const key = (s: number, v: number) => s * 8 + v;
      const counts = new Map<number, number>();
      for (let i = 0; i < n; i++) {
        const o = i * TREE_STRIDE;
        const k = key(trees[o + 3], variantOf(o));
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const meshes = new Map<number, { im: THREE.InstancedMesh; rand: Float32Array; tint: Float32Array; cursor: number }>();
      for (const [k, c] of counts) {
        const s = Math.floor(k / 8), v = k % 8;
        const im = new THREE.InstancedMesh(this.veg.geometry(s, v), this.veg.materialFading, c);
        im.instanceMatrix.setUsage(THREE.StaticDrawUsage);
        im.castShadow = false; // the unit casters below cast instead
        meshes.set(k, { im, rand: new Float32Array(c), tint: new Float32Array(c * 3), cursor: 0 });
      }
      // Shadow casters: one instanced blob and one instanced cone per chunk (two draws in the caster
      // pass instead of one per species and variant), scaled and lifted per species.
      const castCount: Record<ShadowClass, number> = { blob: 0, cone: 0 };
      for (let i = 0; i < n; i++) castCount[SHADOW_CAST[trees[i * TREE_STRIDE + 3]].cls]++;
      const casters: Partial<Record<ShadowClass, { mesh: THREE.InstancedMesh; cursor: number }>> = {};
      for (const cls of ['blob', 'cone'] as const) {
        if (castCount[cls] === 0) continue;
        const shadow = new THREE.InstancedMesh(shareGeometry(this.veg.shadowUnit(cls)), this.veg.shadowMaterial, castCount[cls]);
        shadow.instanceMatrix.setUsage(THREE.StaticDrawUsage);
        shadow.castShadow = this.shadows; shadow.visible = this.shadows; shadow.receiveShadow = false;
        casters[cls] = { mesh: shadow, cursor: 0 };
      }
      for (let i = 0; i < n; i++) {
        const o = i * TREE_STRIDE;
        const s = trees[o + 3];
        const entry = meshes.get(key(s, variantOf(o)))!;
        _p.set(trees[o] - ox, trees[o + 1] - 0.15, trees[o + 2] - oz);
        _q.setFromAxisAngle(_axis, trees[o + 5]);
        const sc = trees[o + 4];
        _s.set(sc, sc, sc);
        _m.compose(_p, _q, _s);
        entry.im.setMatrixAt(entry.cursor, _m);
        const cast = SHADOW_CAST[s], caster = casters[cast.cls]!;
        _p.y += cast.y * sc; _s.set(cast.sx * sc, cast.sy * sc, cast.sz * sc);
        caster.mesh.setMatrixAt(caster.cursor++, _m.compose(_p, _q, _s));
        entry.rand[entry.cursor] = ChunkManager.treeRand(trees[o], trees[o + 2]);
        speciesTint(s, trees[o], trees[o + 2], entry.tint, entry.cursor * 3);
        entry.cursor++;
      }
      for (const { im, rand, tint } of meshes.values()) {
        // Per-instance random for crown displacement/wind phase and the crown tint. The geometry
        // is shared, so the attributes are attached to a shallow per-mesh copy.
        const g = shareGeometry(im.geometry);
        g.setAttribute('aRand', new THREE.InstancedBufferAttribute(rand, 1));
        g.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));
        im.geometry = g;
        this.placeInstanced(rec, im, rec.treeMeshes);
      }
      for (const { mesh: shadow } of Object.values(casters)) {
        shadow.instanceMatrix.needsUpdate = true;
        shadow.computeBoundingSphere();
        shadow.position.set(ox, 0, oz);
        shadow.updateMatrix();
        shadow.matrixAutoUpdate = false;
        ChunkManager.warmFirstDraw(shadow);
        this.root.add(shadow);
        rec.shadowMeshes.push(shadow);
      }
    } else {
      // Impostors: crossed billboards, one tile per species.
      const im = new THREE.InstancedMesh(shareGeometry(this.veg.impostorGeometry), this.veg.impostorMaterialFading, n);
      im.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      const tile = new Float32Array(n), rand = new Float32Array(n), tint = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const o = i * TREE_STRIDE;
        const s = trees[o + 3];
        const sc = trees[o + 4];
        const [w, h] = IMPOSTOR_SIZE[s];
        _p.set(trees[o] - ox, trees[o + 1] - 0.2, trees[o + 2] - oz);
        _q.setFromAxisAngle(_axis, trees[o + 5]);
        _s.set(w * sc, h * sc, w * sc);
        _m.compose(_p, _q, _s);
        im.setMatrixAt(i, _m);
        tile[i] = s;
        rand[i] = hash2(Math.round(trees[o]), Math.round(trees[o + 2]), 5) / 4294967296;
        speciesTint(s, trees[o], trees[o + 2], tint, i * 3);
      }
      im.geometry.setAttribute('aTile', new THREE.InstancedBufferAttribute(tile, 1));
      im.geometry.setAttribute('aRand', new THREE.InstancedBufferAttribute(rand, 1));
      im.geometry.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));
      this.placeInstanced(rec, im, rec.treeMeshes);
    }
  }

  /** Ground cover (LOD0 only): purely visual. */
  private buildCover(rec: ChunkRecord, cover: Float32Array): void {
    const cn = cover.length / COVER_STRIDE, ox = rec.cx * CHUNK_SIZE, oz = rec.cz * CHUNK_SIZE;
    const im = new THREE.InstancedMesh(shareGeometry(this.veg.coverGeometry), this.veg.coverMaterialFading, cn);
    im.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const tile = new Float32Array(cn), rand = new Float32Array(cn), tint = new Float32Array(cn * 3);
    for (let i = 0; i < cn; i++) {
      const o = i * COVER_STRIDE;
      const sc = cover[o + 3];
      _p.set(cover[o] - ox, cover[o + 1] - 0.05, cover[o + 2] - oz);
      _q.setFromAxisAngle(_axis, cover[o + 4]);
      _s.set(1.4 * sc, 0.9 * sc, 1.4 * sc);
      _m.compose(_p, _q, _s);
      im.setMatrixAt(i, _m);
      tile[i] = cover[o + 5];
      rand[i] = hash2(Math.round(cover[o] * 2), Math.round(cover[o + 2] * 2), 17) / 4294967296;
      coverTint(cover[o + 5], cover[o], cover[o + 2], tint, i * 3);
    }
    im.geometry.setAttribute('aTile', new THREE.InstancedBufferAttribute(tile, 1));
    im.geometry.setAttribute('aRand', new THREE.InstancedBufferAttribute(rand, 1));
    im.geometry.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));
    this.placeInstanced(rec, im, rec.coverMeshes);
  }

  /** The player crossed a tree-detail boundary: the old representation dissolves out, the new one in. */
  private reinstanceTrees(rec: ChunkRecord): void {
    const want = this.wantedRep(rec);
    if (want === rec.vegRep || !rec.mesh) return;
    this.retireMeshes(rec.treeMeshes);
    this.dropShadowMeshes(rec);
    this.buildTrees(rec, want);
  }

  /** Keep instanced meshes drawing while they dissolve out (their death time is written to every instance). */
  private retireMeshes(list: THREE.InstancedMesh[]): void {
    for (const im of list) {
      const life = im.geometry.getAttribute('aLife') as THREE.InstancedBufferAttribute | undefined;
      if (life) { for (let i = 0; i < life.count; i++) life.setY(i, this.time); life.needsUpdate = true; }
      im.material = this.veg.fadingTwin(im.material as THREE.Material);
      this.fading.push({ im, until: this.time + 0.85 });
    }
    list.length = 0;
  }

  private dropShadowMeshes(rec: ChunkRecord): void {
    for (const sm of rec.shadowMeshes) { this.root.remove(sm); disposeInstanceGeometry(sm.geometry); sm.dispose(); }
    rec.shadowMeshes.length = 0;
  }

  /** Current geomorph value of a chunk's mesh (1 when settled). */
  private morphValue(rec: ChunkRecord): number {
    const m = rec.morph;
    if (!m) return 1;
    return m.from + (m.to - m.from) * smoothstep01((this.time - m.start) / MORPH_SECONDS);
  }

  /** Start (or redirect) the geomorph of a chunk's mesh toward `to`; the mesh gets a material twin with its own uMorph. */
  private startMorph(rec: ChunkRecord, from: number, to: number): void {
    if (!rec.mesh) return;
    if (!rec.morph) {
      const material = (this.terrainMaterial as TerrainMaterial).morphTwin();
      rec.mesh.material = material;
      rec.morph = { start: this.time, from, to, material };
    } else {
      rec.morph.from = from; rec.morph.to = to; rec.morph.start = this.time;
    }
    rec.morph.material.morphUniform.value = from;
    this.morphing.add(rec);
  }

  private endMorph(rec: ChunkRecord): void {
    if (!rec.morph) return;
    if (rec.mesh && rec.mesh.material === rec.morph.material) rec.mesh.material = this.terrainMaterial;
    rec.morph.material.dispose();
    rec.morph = null;
    this.morphing.delete(rec);
  }

  /** Advance every geomorph; finish settled ones and perform the swaps that waited for a morph-down. */
  private stepMorphs(): void {
    if (this.morphing.size === 0) return;
    for (const rec of Array.from(this.morphing)) {
      const m = rec.morph;
      if (!m || !rec.mesh) { this.morphing.delete(rec); continue; }
      const t = (this.time - m.start) / MORPH_SECONDS;
      m.material.morphUniform.value = this.morphValue(rec);
      if (t < 1) continue;
      if (m.to >= 1) { this.endMorph(rec); continue; }
      // Morphed down onto the coarser surface: swap in the coarser build, unless the player turned
      // back and this LOD is wanted again, in which case rise back to it.
      const msg = rec.pendingSwap;
      rec.pendingSwap = null;
      if (msg && rec.wantedLod > rec.lod) {
        this.endMorph(rec);
        this.installChunkNow(rec, msg, null);
        if (rec.wantedLod !== rec.lod) this.requestChunk(rec, rec.wantedLod, rec.ring);
      } else {
        this.startMorph(rec, 0, 1);
      }
    }
  }

  /**
   * Like removeChunkObjects, but a replaced vegetation representation keeps
   * drawing while it dissolves out (its death time is written to every
   * instance); the terrain and water swap immediately, which is invisible.
   */
  private retireChunkObjects(rec: ChunkRecord): void {
    if (this.time > 0) {
      this.retireMeshes(rec.treeMeshes);
      this.retireMeshes(rec.coverMeshes);
    }
    this.removeChunkObjects(rec);
  }

  private removeChunkObjects(rec: ChunkRecord): void {
    this.endMorph(rec);
    rec.pendingSwap = null;
    this.revegQueue.delete(rec);
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
    for (const list of [rec.treeMeshes, rec.coverMeshes]) {
      for (const im of list) {
        this.root.remove(im);
        // The per-mesh geometry only holds instance attributes plus references
        // to shared buffers; disposing it frees the instance buffers.
        disposeInstanceGeometry(im.geometry);
        im.dispose();
      }
      list.length = 0;
    }
    this.dropShadowMeshes(rec);
    rec.pendingCover = null;
    this.treeCount -= rec.trees.length / TREE_STRIDE;
    rec.vegRep = 'none';
    rec.trees = new Float32Array(0);
    rec.heights = null;
    rec.parentHeights = null;
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
      const lx = gx - cx * CHUNK_SIZE, lz = gz - cz * CHUNK_SIZE;
      const h = sampleHeightGrid(rec.heights, rec.segments, rec.spacing, lx, lz);
      // While the mesh geomorphs, collide with the blended surface the player actually sees.
      if (rec.morph && rec.parentHeights) {
        const m = this.morphValue(rec);
        if (m < 0.999) return sampleHeightGrid(rec.parentHeights, rec.segments, rec.spacing, lx, lz) * (1 - m) + h * m;
      }
      return h;
    }
    return this.gen.heightAt(gx, gz);
  }

  /** Surface height including water (never below sea level). */
  surfaceAt(gx: number, gz: number): number {
    return Math.max(this.heightAt(gx, gz), SEA_LEVEL);
  }

  /** Is any tree collider within `radius` of a global position? */
  treeNear(gx: number, gz: number, radius: number): boolean {
    let hit = false;
    this.forEachTreeNear(gx, gz, radius, () => { hit = true; return true; });
    return hit;
  }

  /** Geometry variant of a tree: a stable hash of its position (shared by instancing and the perch finder). */
  static treeVariant(x: number, z: number, variants: number): number {
    return hash2(Math.round(x * 4), Math.round(z * 4), 77) % variants;
  }
  /** Per-instance random of a tree (`aRand`): crown displacement, stretch and wind phase in the shader. */
  static treeRand(x: number, z: number): number {
    return hash2(Math.round(x * 3), Math.round(z * 3), 913) / 4294967296;
  }

  /** Iterate trees whose collider circle intersects the given circle. */
  forEachTreeNear(gx: number, gz: number, radius: number, cb: (t: TreeHit) => boolean | void): void {
    const cx0 = Math.floor((gx - radius) / CHUNK_SIZE), cx1 = Math.floor((gx + radius) / CHUNK_SIZE);
    const cz0 = Math.floor((gz - radius) / CHUNK_SIZE), cz1 = Math.floor((gz + radius) / CHUNK_SIZE);
    const hit: TreeHit = { x: 0, y: 0, z: 0, radius: 0, top: 0, species: 0, peakX: 0, peakY: 0, peakZ: 0 };
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
          // The model's highest point over the trunk, with the same variant, per-instance crown
          // stretch and yaw the instance is drawn with (models are planted 0.15 m into the ground).
          const pk = this.veg.peak(sp, ChunkManager.treeVariant(t[i], t[i + 2], this.veg.variants(sp)));
          const rnd = ChunkManager.treeRand(t[i], t[i + 2]);
          const sy = 1 + ((rnd * 7.31) % 1 - 0.5) * 0.14 * pk.crown, sxz = 1 + (rnd - 0.5) * 0.18 * pk.crown;
          const px = pk.x * sxz * sc, pz = pk.z * sxz * sc, yaw = t[i + 5], cy = Math.cos(yaw), sy2 = Math.sin(yaw);
          hit.peakX = t[i] + px * cy + pz * sy2;
          hit.peakZ = t[i + 2] - px * sy2 + pz * cy;
          hit.peakY = t[i + 1] - 0.15 + pk.y * sy * sc;
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
    this.morphing.clear();
    this.revegQueue.clear();
    this.coverQueue.length = 0;
    for (const rec of Array.from(this.chunks.values())) this.disposeChunk(rec);
    for (const rec of Array.from(this.far.values())) this.disposeFar(rec);
    this.pool.dispose();
    this.waterGeometry.dispose();
    this.terrainMaterial.dispose();
    this.farMaterial.dispose();
  }
}

export { LOD_SPACING };
