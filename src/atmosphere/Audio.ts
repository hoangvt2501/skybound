/**
 * Lightweight Web Audio ambience: filtered wind noise scaled by airspeed,
 * soft wingbeat whooshes on each flap cycle, and small UI/discovery chimes.
 * Audio starts only after a user gesture.
 */
export class AudioSystem {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private flapGain: GainNode | null = null;
  private flapFilter: BiquadFilterNode | null = null;
  private noise: AudioBufferSourceNode | null = null;
  private noise2: AudioBufferSourceNode | null = null;
  private volume = 0.6;
  private muted = false;
  private suspendedByUs = false;
  private flapPhase = 0;
  private lastBeat = 0;
  started = false;

  /** Create the graph after a user gesture. Safe to call repeatedly. */
  start(): void {
    if (this.started) {
      void this.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(ctx.destination);

    const buffer = this.makeNoise(ctx, 2.5);
    // Wind: low-passed noise.
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 400;
    this.windFilter.Q.value = 0.7;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.noise = ctx.createBufferSource();
    this.noise.buffer = buffer;
    this.noise.loop = true;
    this.noise.connect(this.windFilter).connect(this.windGain).connect(this.master);
    this.noise.start();

    // Wingbeats: band-passed noise gated by an envelope.
    this.flapFilter = ctx.createBiquadFilter();
    this.flapFilter.type = 'bandpass';
    this.flapFilter.frequency.value = 180;
    this.flapFilter.Q.value = 1.2;
    this.flapGain = ctx.createGain();
    this.flapGain.gain.value = 0;
    this.noise2 = ctx.createBufferSource();
    this.noise2.buffer = buffer;
    this.noise2.loop = true;
    this.noise2.connect(this.flapFilter).connect(this.flapGain).connect(this.master);
    this.noise2.start();
    this.started = true;
  }

  private makeNoise(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      // pink-ish noise
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.11;
    }
    return buf;
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx!.currentTime, 0.05);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx!.currentTime, 0.05);
  }

  /** Update per frame with flight parameters. */
  update(dt: number, speed: number, flapping: boolean, boosting: boolean, beatRate: number): void {
    if (!this.ctx || !this.windGain || !this.windFilter || !this.flapGain || !this.flapFilter) return;
    if (this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    const s = Math.max(0, Math.min(1, (speed - 10) / 70));
    this.windGain.gain.setTargetAtTime(0.12 + s * 0.9 + (boosting ? 0.25 : 0), t, 0.12);
    this.windFilter.frequency.setTargetAtTime(250 + s * 1500 + (boosting ? 500 : 0), t, 0.15);
    // Wingbeat envelope: pulses when flapping (~3.1 Hz), soft slow beats when gliding.
    const freq = flapping ? 3.1 * beatRate : 0.35;
    this.flapPhase += dt * freq;
    if (this.flapPhase - this.lastBeat >= 1) {
      this.lastBeat = Math.floor(this.flapPhase);
      const strength = flapping ? 0.55 : 0.12;
      this.flapGain.gain.cancelScheduledValues(t);
      this.flapGain.gain.setValueAtTime(this.flapGain.gain.value, t);
      this.flapGain.gain.linearRampToValueAtTime(strength, t + 0.06);
      this.flapGain.gain.exponentialRampToValueAtTime(0.001, t + (flapping ? 0.26 : 0.6));
    }
  }

  /** Short two-note chime for discoveries. */
  chime(kind: 'discover' | 'waypoint' | 'ui' = 'discover'): void {
    if (!this.ctx || !this.master || this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    const notes = kind === 'discover' ? [660, 880, 1320] : kind === 'waypoint' ? [520, 780] : [440];
    const t0 = ctx.currentTime;
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0 + i * 0.12);
      g.gain.linearRampToValueAtTime(0.18, t0 + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.12 + 0.5);
      o.connect(g).connect(this.master!);
      o.start(t0 + i * 0.12);
      o.stop(t0 + i * 0.12 + 0.55);
    });
  }

  /** Soft thump on impact. */
  thump(strength = 1): void {
    if (!this.ctx || !this.master || this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(120, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(45, ctx.currentTime + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.35 * strength, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    o.connect(g).connect(this.master);
    o.start();
    o.stop(ctx.currentTime + 0.3);
  }

  async suspend(): Promise<void> {
    if (this.ctx && this.ctx.state === 'running') {
      this.suspendedByUs = true;
      await this.ctx.suspend();
    }
  }

  async resume(): Promise<void> {
    if (this.ctx && this.ctx.state !== 'running') {
      this.suspendedByUs = false;
      try {
        await this.ctx.resume();
      } catch {
        /* needs a gesture */
      }
    }
  }

  get wasSuspendedByUs(): boolean {
    return this.suspendedByUs;
  }

  dispose(): void {
    try {
      this.noise?.stop();
      this.noise2?.stop();
      void this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.ctx = null;
    this.started = false;
  }
}
