/**
 * Small pool of terrain workers with a bounded priority queue. Jobs carry a
 * monotonically increasing id; callers discard results whose ids they no
 * longer expect.
 */
import type { WorkerRequest, WorkerResponse } from './terrain.worker';

type Job = { req: Exclude<WorkerRequest, { type: 'init' }>; priority: number };

export class WorkerPool {
  private workers: Worker[] = [];
  private busy: boolean[] = [];
  private queue: Job[] = [];
  private nextId = 1;
  private listeners = new Set<(msg: WorkerResponse) => void>();
  private readyCount = 0;
  private disposed = false;
  readonly size: number;
  maxQueue = 160;

  constructor(seed: number, size: number) {
    this.size = Math.max(1, size);
    for (let i = 0; i < this.size; i++) {
      const w = new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const msg = e.data;
        if (msg.type === 'ready') {
          this.readyCount++;
          this.pump();
          return;
        }
        this.busy[i] = false;
        for (const l of this.listeners) l(msg);
        this.pump();
      };
      w.onerror = (e) => {
        console.error('[worker] error', e.message);
        this.busy[i] = false;
        this.pump();
      };
      w.postMessage({ type: 'init', seed } satisfies WorkerRequest);
      this.workers.push(w);
      this.busy.push(false);
    }
  }

  get queued(): number {
    return this.queue.length;
  }
  get active(): number {
    return this.busy.filter(Boolean).length;
  }

  onMessage(listener: (msg: WorkerResponse) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  allocId(): number {
    return this.nextId++;
  }

  /** Enqueue a job. Lower priority value runs first. Returns false if dropped. */
  enqueue(req: Exclude<WorkerRequest, { type: 'init' }>, priority: number): boolean {
    if (this.disposed) return false;
    const job: Job = { req, priority };
    // Binary insertion keeps the queue ordered without re-sorting it on every request (a ring of
    // 289 chunks arrives in one update after a teleport or a preset change).
    let lo = 0, hi = this.queue.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.queue[mid].priority <= priority) lo = mid + 1; else hi = mid; }
    this.queue.splice(lo, 0, job);
    let kept = true;
    if (this.queue.length > this.maxQueue) {
      // Drop the lowest-priority jobs and tell their owners so they can retry.
      const dropped = this.queue.splice(this.maxQueue);
      for (const d of dropped) {
        if (d === job) kept = false;
        else for (const l of this.dropListeners) l(d.req);
      }
    }
    // Survival is decided before pumping: pump may dispatch the job right away.
    this.pump();
    return kept;
  }

  private dropListeners = new Set<(req: Exclude<WorkerRequest, { type: 'init' }>) => void>();

  /** Notified when a previously accepted job is evicted by the bounded queue. */
  onDrop(listener: (req: Exclude<WorkerRequest, { type: 'init' }>) => void): () => void {
    this.dropListeners.add(listener);
    return () => this.dropListeners.delete(listener);
  }

  /** Remove queued (not yet running) jobs matching a predicate. */
  cancelWhere(pred: (req: Exclude<WorkerRequest, { type: 'init' }>) => boolean): void {
    this.queue = this.queue.filter((j) => !pred(j.req));
  }

  private pump(): void {
    if (this.readyCount < this.size) return;
    for (let i = 0; i < this.workers.length && this.queue.length > 0; i++) {
      if (this.busy[i]) continue;
      const job = this.queue.shift()!;
      this.busy[i] = true;
      this.workers[i].postMessage(job.req);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
  }
}
