/** Procedural soundscape. Three independent buses, bounded voices, no downloads. */
import { MusicBox, type MusicStyle } from './Music';

export interface SoundMix { ambienceVolume: number; musicVolume: number; effectsVolume: number }
export interface SoundEnvironment { aboveGround: number; water: boolean; daylight: number; /** 0 sheltered lake .. 1 open sea, for surf loudness */ exposure?: number; /** 0..1 while touching or dripping */ wet?: number; /** sitting on a perch: a leafy breeze and busier songbirds instead of airflow */ resting?: boolean }
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
  private waterFilter: BiquadFilterNode | null = null;
  private skimGain: GainNode | null = null;
  private varioOsc: OscillatorNode | null = null;
  private varioGain: GainNode | null = null;
  private varioLfo: OscillatorNode | null = null;
  private varioLfoGain: GainNode | null = null;
  private liftLevel = 0;
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
      this.waterFilter = ctx.createBiquadFilter();
      this.waterFilter.type = 'lowpass'; this.waterFilter.frequency.value = 950; this.waterFilter.Q.value = 0.4;
      this.waterGain = ctx.createGain(); this.waterGain.gain.value = 0;
      this.loopNoise(buffer).connect(this.waterFilter).connect(this.waterGain).connect(this.ambience);
      // Skimming hiss: bright noise that only opens while the bird touches the water.
      const skimFilter = ctx.createBiquadFilter();
      skimFilter.type = 'bandpass'; skimFilter.frequency.value = 2600; skimFilter.Q.value = 0.7;
      this.skimGain = ctx.createGain(); this.skimGain.gain.value = 0;
      this.loopNoise(buffer).connect(skimFilter).connect(this.skimGain).connect(this.effects);
      // Variometer: a quiet pulsing sine whose pitch and pulse rate rise with the lift.
      this.varioOsc = ctx.createOscillator(); this.varioOsc.type = 'sine'; this.varioOsc.frequency.value = 520;
      this.varioGain = ctx.createGain(); this.varioGain.gain.value = 0;
      this.varioLfo = ctx.createOscillator(); this.varioLfo.type = 'sine'; this.varioLfo.frequency.value = 2;
      this.varioLfoGain = ctx.createGain(); this.varioLfoGain.gain.value = 0;
      this.varioLfo.connect(this.varioLfoGain).connect(this.varioGain.gain);
      const varioPan = ctx.createStereoPanner(); varioPan.pan.value = -0.15;
      this.varioOsc.connect(this.varioGain).connect(varioPan).connect(this.effects);
      this.varioOsc.start(); this.varioLfo.start(); this.sources.push(this.varioOsc, this.varioLfo);
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

  /** 0..1 lift level for the variometer; 0 silences it. */
  setLift(level: number): void { this.liftLevel = clamp(level); }

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
    const resting = !!environment.resting;
    const amount = resting ? 0 : clamp((speed - 10) / 75);
    // On a perch the airflow gives way to a soft breeze through the leaves that swells with the gusts.
    const total = resting ? 0.03 : windLevel(speed, boosting);
    this.airGain.gain.setTargetAtTime(total * 0.75 * this.gust, t, resting ? 1.2 : 0.5);
    this.airFilter.frequency.setTargetAtTime(resting ? 480 + 160 * this.gust : 700 + amount * 900 + (boosting ? 250 : 0), t, 0.8);
    this.rushGain.gain.setTargetAtTime(total * (0.15 + 0.85 * amount * amount) * (boosting ? 1.4 : 0.9), t, 0.7);
    const near = 1 - clamp(environment.aboveGround / 200);
    // Surf swells with exposure: open sea is louder and brighter than a sheltered lake.
    const exposure = clamp(environment.exposure ?? 0);
    this.waterGain?.gain.setTargetAtTime(environment.water ? near * (0.06 + 0.07 * exposure + Math.sin(t * 0.35) * (0.012 + 0.02 * exposure)) : 0, t, 2);
    this.waterFilter?.frequency.setTargetAtTime(950 + 900 * exposure, t, 2);
    this.skimGain?.gain.setTargetAtTime(0.09 * clamp(environment.wet ?? 0) * clamp(speed / 30), t, 0.08);
    if (this.varioGain && this.varioOsc && this.varioLfo && this.varioLfoGain) {
      const lv = this.liftLevel < 0.12 ? 0 : this.liftLevel;
      this.varioGain.gain.setTargetAtTime(0.022 * lv, t, 0.15);
      this.varioLfoGain.gain.setTargetAtTime(0.02 * lv, t, 0.15);
      this.varioOsc.frequency.setTargetAtTime(520 + 380 * lv, t, 0.2);
      this.varioLfo.frequency.setTargetAtTime(1.6 + 3.2 * lv, t, 0.2);
    }
    if (t >= this.nextBird) {
      // Songbirds call every 9-21 s near the ground; a resting bird hears them every 3-8 s, in longer phrases.
      this.nextBird = t + (resting ? 3 + Math.random() * 5 : 9 + Math.random() * 12);
      if ((near > 0.12 || resting) && environment.daylight > 0.25 && !environment.water && !this.muted && this.mix.ambienceVolume > 0) {
        const pitch = 1200 + Math.random() * 550, level = resting ? 0.022 : 0.018 * near, pan = Math.random() * 1.2 - 0.6;
        this.tone(pitch, pitch * 1.28, level, 0.22, t, this.ambience!, pan);
        this.tone(pitch * 1.15, pitch * 0.94, level * 0.66, 0.18, t + 0.27, this.ambience!, pan * 0.4 + 0.2);
        if (resting && Math.random() < 0.7) {
          const answer = pitch * (0.78 + Math.random() * 0.3);
          for (let i = 0; i < 2 + Math.floor(Math.random() * 3); i++) this.tone(answer * (1 + 0.06 * (i % 2)), answer * 1.18, level * 0.55, 0.13, t + 0.62 + i * 0.16, this.ambience!, -pan * 0.7);
        }
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

  /** Water entry: a noise burst that darkens as it decays, a low plop and a short 'shhh' tail scaled by strength. */
  splash(strength = 1): void {
    if (!this.ctx || !this.effects || this.ctx.state !== 'running' || this.suspendedByUs || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime, k = clamp(strength);
    const noise = ctx.createBufferSource(); noise.buffer = this.makeNoise(ctx, 0.5);
    const filter = ctx.createBiquadFilter(); filter.type = 'bandpass'; filter.Q.value = 0.6;
    filter.frequency.setValueAtTime(2200 + 1800 * k, t); filter.frequency.exponentialRampToValueAtTime(500, t + 0.35 + 0.3 * k);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t); gain.gain.linearRampToValueAtTime(0.22 + 0.3 * k, t + 0.02); gain.gain.exponentialRampToValueAtTime(0.0005, t + 0.45 + 0.5 * k);
    noise.connect(filter).connect(gain).connect(this.effects);
    noise.start(t); noise.stop(t + 1.1);
    noise.onended = () => { noise.disconnect(); filter.disconnect(); gain.disconnect(); };
    this.tone(160, 55, 0.05 + 0.08 * k, 0.3 + 0.2 * k, t, this.effects); // the plop
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
