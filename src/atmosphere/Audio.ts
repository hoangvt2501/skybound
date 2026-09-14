/** Procedural soundscape. Three independent buses, bounded voices, no downloads. */
import { MusicBox, type MusicStyle } from './Music';

export interface SoundMix { ambienceVolume: number; musicVolume: number; effectsVolume: number }
export interface SoundEnvironment { aboveGround: number; water: boolean; daylight: number }
const clamp = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

/** Total wind level for a speed; the two layers below split it by timbre. */
export function windLevel(speed: number, boosting: boolean): number {
  const amount = clamp((speed - 10) / 75);
  return 0.02 + amount * 0.09 + (boosting ? 0.02 : 0);
}

export class AudioSystem {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private ambience: GainNode | null = null;
  private music: GainNode | null = null;
  private effects: GainNode | null = null;
  /** Airy mid-band rush: the "wind past your face" layer, gusting slowly. */
  private airGain: GainNode | null = null;
  private airFilter: BiquadFilterNode | null = null;
  /** Low rumble, only noticeable when diving fast or boosting. */
  private rushGain: GainNode | null = null;
  private flapGain: GainNode | null = null;
  private waterGain: GainNode | null = null;
  private sources: AudioScheduledSourceNode[] = [];
  private musicBox: MusicBox | null = null;
  private musicStyle: MusicStyle = 'sunny';
  private volume = 0.45;
  private muted = false;
  private mix: SoundMix = { ambienceVolume: 0.55, musicVolume: 0.35, effectsVolume: 0.45 };
  private suspendedByUs = false;
  private transition = 0;
  private flapPhase = 0;
  private nextControl = 0;
  private nextBird = 5;
  private gust = 1;
  private gustTarget = 1;
  private nextGust = 0;
  private lastChime = -10;
  private liveVoices = 0;
  started = false;

  start(): void {
    if (this.started) { void this.resume(); return; }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    try {
      const ctx = new AC();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = 0;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -15; limiter.knee.value = 12;
      limiter.ratio.value = 5; limiter.attack.value = 0.01; limiter.release.value = 0.4;
      this.master.connect(limiter).connect(ctx.destination);
      this.ambience = ctx.createGain(); this.music = ctx.createGain(); this.effects = ctx.createGain();
      this.ambience.gain.value = this.mix.ambienceVolume;
      this.music.gain.value = this.mix.musicVolume;
      this.effects.gain.value = this.mix.effectsVolume;
      this.ambience.connect(this.master); this.music.connect(this.master); this.effects.connect(this.master);
      this.setMix(this.mix);
      const buffer = this.makeNoise(ctx, 4);
      // Wind: a bright, gusting band of air plus a quiet low rush. The old
      // single 330 Hz low-pass drone read as an aircraft cabin.
      this.airFilter = ctx.createBiquadFilter();
      this.airFilter.type = 'bandpass'; this.airFilter.frequency.value = 900; this.airFilter.Q.value = 0.55;
      this.airGain = ctx.createGain(); this.airGain.gain.value = 0;
      this.loopNoise(buffer).connect(this.airFilter).connect(this.airGain).connect(this.ambience);
      const rushFilter = ctx.createBiquadFilter();
      rushFilter.type = 'lowpass'; rushFilter.frequency.value = 190; rushFilter.Q.value = 0.5;
      this.rushGain = ctx.createGain(); this.rushGain.gain.value = 0;
      this.loopNoise(buffer).connect(rushFilter).connect(this.rushGain).connect(this.ambience);
      const flapFilter = ctx.createBiquadFilter();
      flapFilter.type = 'bandpass'; flapFilter.frequency.value = 160; flapFilter.Q.value = 0.65;
      this.flapGain = ctx.createGain(); this.flapGain.gain.value = 0;
      this.loopNoise(buffer).connect(flapFilter).connect(this.flapGain).connect(this.effects);
      const waterFilter = ctx.createBiquadFilter();
      waterFilter.type = 'lowpass'; waterFilter.frequency.value = 950; waterFilter.Q.value = 0.4;
      this.waterGain = ctx.createGain(); this.waterGain.gain.value = 0;
      this.loopNoise(buffer).connect(waterFilter).connect(this.waterGain).connect(this.ambience);
      this.musicBox = new MusicBox(ctx, this.music);
      this.musicBox.setStyle(this.musicStyle);
      this.started = true;
      void this.resume();
    } catch {
      this.dispose(); // Unsupported/denied audio must never prevent flight.
    }
  }

  private makeNoise(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
      data[i] = (b0 + b1 + b2 + w * 0.1848) * 0.11;
    }
    // Taper the loop join to remove clicks.
    const edge = Math.floor(ctx.sampleRate * 0.025);
    for (let i = 0; i < edge; i++) { const k = i / edge; data[i] *= k; data[len - i - 1] *= k; }
    return buffer;
  }

  private loopNoise(buffer: AudioBuffer): AudioBufferSourceNode {
    const source = this.ctx!.createBufferSource(); source.buffer = buffer; source.loop = true;
    source.start(0, Math.random() * buffer.duration); this.sources.push(source); return source;
  }

  setMix(mix: SoundMix): void {
    this.mix = { ambienceVolume: clamp(mix.ambienceVolume), musicVolume: clamp(mix.musicVolume), effectsVolume: clamp(mix.effectsVolume) };
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.ambience?.gain.setTargetAtTime(this.mix.ambienceVolume, t, 0.25);
    this.music?.gain.setTargetAtTime(this.mix.musicVolume, t, 0.8);
    this.effects?.gain.setTargetAtTime(this.mix.effectsVolume, t, 0.2);
  }

  setMusicStyle(style: MusicStyle): void {
    this.musicStyle = style;
    this.musicBox?.setStyle(style);
  }
  get currentMusicStyle(): MusicStyle { return this.musicStyle; }

  private fadeMaster(): void {
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.muted || this.suspendedByUs ? 0 : this.volume, this.ctx.currentTime, 0.08);
  }
  setVolume(v: number): void { this.volume = clamp(v); this.fadeMaster(); }
  setMuted(m: boolean): void { this.muted = m; this.fadeMaster(); }

  update(dt: number, speed: number, flapping: boolean, boosting: boolean, beatRate: number, environment: SoundEnvironment = { aboveGround: 200, water: false, daylight: 1 }): void {
    if (!this.ctx || !this.airGain || !this.airFilter || !this.rushGain || !this.flapGain || this.ctx.state !== 'running' || this.suspendedByUs) return;
    const t = this.ctx.currentTime;
    this.flapPhase += dt * (flapping ? 3.1 * beatRate : 0.35);
    if (this.flapPhase >= 1) {
      this.flapPhase %= 1;
      this.flapGain.gain.cancelScheduledValues(t);
      this.flapGain.gain.setTargetAtTime(flapping ? 0.14 : 0.025, t, 0.04);
      this.flapGain.gain.setTargetAtTime(0, t + 0.09, 0.10);
    }
    if (t < this.nextControl) return;
    this.nextControl = t + 0.05; // Audio automation does not need render-rate writes.
    this.musicBox?.pump(t);
    // Gusts: a slow random walk so the air never sits on one level.
    if (t >= this.nextGust) { this.gustTarget = 0.6 + Math.random() * 0.65; this.nextGust = t + 1.5 + Math.random() * 3.5; }
    this.gust += (this.gustTarget - this.gust) * 0.05;
    const amount = clamp((speed - 10) / 75);
    const total = windLevel(speed, boosting);
    this.airGain.gain.setTargetAtTime(total * 0.75 * this.gust, t, 0.5);
    this.airFilter.frequency.setTargetAtTime(700 + amount * 900 + (boosting ? 250 : 0), t, 0.8);
    this.rushGain.gain.setTargetAtTime(total * (0.15 + 0.85 * amount * amount) * (boosting ? 1.4 : 0.9), t, 0.7);
    const near = 1 - clamp(environment.aboveGround / 200);
    this.waterGain?.gain.setTargetAtTime(environment.water ? near * (0.06 + Math.sin(t * 0.35) * 0.012) : 0, t, 2);
    if (t >= this.nextBird) {
      this.nextBird = t + 9 + Math.random() * 12;
      if (near > 0.12 && environment.daylight > 0.25 && !environment.water && !this.muted && this.mix.ambienceVolume > 0) {
        const pitch = 1200 + Math.random() * 550;
        this.tone(pitch, pitch * 1.28, 0.018 * near, 0.22, t, this.ambience!, Math.random() * 1.2 - 0.6);
        this.tone(pitch * 1.15, pitch * 0.94, 0.012 * near, 0.18, t + 0.27, this.ambience!, 0.2);
      }
    }
  }

  private tone(f: number, endF: number, level: number, duration: number, t: number, bus: GainNode, panValue = 0): void {
    if (!this.ctx || this.liveVoices >= 12) return;
    const ctx = this.ctx, osc = ctx.createOscillator(), gain = ctx.createGain(), pan = ctx.createStereoPanner();
    osc.type = 'sine'; osc.frequency.setValueAtTime(f, t); osc.frequency.exponentialRampToValueAtTime(endF, t + duration);
    gain.gain.setValueAtTime(0, t); gain.gain.linearRampToValueAtTime(level, t + 0.04); gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    pan.pan.value = panValue; osc.connect(gain).connect(pan).connect(bus);
    this.liveVoices++;
    osc.onended = () => { osc.disconnect(); gain.disconnect(); pan.disconnect(); this.liveVoices = Math.max(0, this.liveVoices - 1); };
    osc.start(t); osc.stop(t + duration + 0.05);
  }

  chime(kind: 'discover' | 'waypoint' | 'ui' = 'discover'): void {
    if (!this.ctx || !this.effects || this.ctx.state !== 'running' || this.suspendedByUs || this.muted) return;
    const t = this.ctx.currentTime;
    if (t - this.lastChime < 0.8) return;
    this.lastChime = t;
    const notes = kind === 'discover' ? [587.33, 739.99, 880] : kind === 'waypoint' ? [440, 587.33] : [440];
    notes.forEach((f, i) => this.tone(f, f, 0.055, 0.8, t + i * 0.16, this.effects!));
  }

  thump(strength = 1): void {
    if (!this.ctx || !this.effects || this.ctx.state !== 'running' || this.suspendedByUs || this.muted) return;
    this.tone(110, 50, 0.06 * clamp(strength), 0.28, this.ctx.currentTime, this.effects);
  }

  async suspend(): Promise<void> {
    const id = ++this.transition;
    this.suspendedByUs = true; this.fadeMaster();
    if (!this.ctx || this.ctx.state !== 'running') return;
    await new Promise(resolve => setTimeout(resolve, 120));
    if (id !== this.transition) return;
    try { await this.ctx?.suspend(); } catch { /* closed */ }
  }

  async resume(): Promise<void> {
    ++this.transition;
    this.suspendedByUs = false;
    if (!this.ctx || this.ctx.state === 'closed') return;
    try { await this.ctx.resume(); this.fadeMaster(); } catch { /* needs another user gesture */ }
  }
  get wasSuspendedByUs(): boolean { return this.suspendedByUs; }
  dispose(): void {
    ++this.transition;
    this.musicBox?.dispose(); this.musicBox = null;
    for (const source of this.sources) { try { source.stop(); source.disconnect(); } catch { /* already stopped */ } }
    this.sources.length = 0;
    void this.ctx?.close().catch(() => {});
    this.ctx = null; this.master = null; this.ambience = null; this.music = null; this.effects = null;
    this.started = false;
  }
}
