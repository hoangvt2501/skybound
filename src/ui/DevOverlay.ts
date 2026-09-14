/**
 * Developer overlay: frame time, draw calls, triangles, chunks, jobs, seed,
 * global coordinates. Updated a few times per second.
 */
export interface DevStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  chunks: number;
  farTiles: number;
  pendingJobs: number;
  queuedJobs: number;
  trees: number;
  seed: number;
  x: number;
  y: number;
  z: number;
  originX: number;
  originZ: number;
  pixelRatio: number;
  simSteps: number;
  dropped: number;
  tiles: number;
  memoryMB: number | null;
}

export class DevOverlay {
  readonly root: HTMLElement;
  private lastUpdate = 0;

  constructor(container: HTMLElement) {
    this.root = document.createElement('pre');
    this.root.className = 'dev';
    this.root.hidden = true;
    container.appendChild(this.root);
  }

  setVisible(v: boolean): void {
    this.root.hidden = !v;
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  update(now: number, s: DevStats): void {
    if (this.root.hidden || now - this.lastUpdate < 0.25) return;
    this.lastUpdate = now;
    this.root.textContent =
      `fps ${s.fps.toFixed(0)}  frame ${s.frameMs.toFixed(1)} ms  dpr ${s.pixelRatio.toFixed(2)}\n` +
      `draw calls ${s.drawCalls}  tris ${(s.triangles / 1000).toFixed(0)}k\n` +
      `chunks ${s.chunks}  far ${s.farTiles}  trees ${s.trees}\n` +
      `jobs pending ${s.pendingJobs}  queued ${s.queuedJobs}  map tiles ${s.tiles}\n` +
      `sim steps ${s.simSteps}  dropped ${s.dropped}\n` +
      `seed ${s.seed}\n` +
      `global x ${s.x.toFixed(1)}  y ${s.y.toFixed(1)}  z ${s.z.toFixed(1)}\n` +
      `origin x ${s.originX}  z ${s.originZ}` +
      (s.memoryMB !== null ? `\nheap ${s.memoryMB.toFixed(0)} MB` : '');
  }
}
