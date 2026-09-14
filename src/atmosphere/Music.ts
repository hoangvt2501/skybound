/**
 * Procedural music box: short cheerful tunes composed on the fly from a few
 * rules (major keys, pentatonic melodies, simple chord loops), played by
 * oscillator instruments. No audio files. Everything is scheduled a little
 * ahead of the audio clock from a timer, so it keeps playing while the render
 * loop is idle (start screen preview) and never depends on frame rate.
 */
export type MusicStyle = 'off' | 'sunny' | 'waltz' | 'island' | 'calm';

export const MUSIC_STYLES: { id: MusicStyle; name: string; description: string }[] = [
  { id: 'sunny', name: 'Sunny stroll', description: 'Bright plucked melody over a bouncy 4/4, major keys.' },
  { id: 'waltz', name: 'Meadow waltz', description: 'Lilting 3/4 with a marimba lead and oom-pah-pah bass.' },
  { id: 'island', name: 'Island breeze', description: 'Laid-back swing, kalimba lead, soft shaker.' },
  { id: 'calm', name: 'Calm pad', description: 'Slow sustained chords, no rhythm.' },
  { id: 'off', name: 'Off', description: 'Nature sounds only.' },
];
export const isMusicStyle = (v: unknown): v is MusicStyle => typeof v === 'string' && MUSIC_STYLES.some(s => s.id === v);

type Lead = 'pluck' | 'marimba' | 'kalimba';
interface StyleDef {
  tempo: number;
  beatsPerBar: 3 | 4;
  swing: number;
  lead: Lead;
  /** Chord loops as scale degrees (0 = I). */
  progressions: number[][];
  /** Melody rhythm patterns, one flag per eighth-note slot. */
  rhythms: number[][];
  /** Song length in bars before a new key/loop is drawn. */
  songBars: number;
}

const STYLES: Record<Exclude<MusicStyle, 'off' | 'calm'>, StyleDef> = {
  sunny: {
    tempo: 112, beatsPerBar: 4, swing: 0, lead: 'pluck', songBars: 32,
    progressions: [[0, 4, 5, 3], [0, 3, 4, 3], [0, 5, 3, 4], [0, 3, 0, 4]],
    rhythms: [[1, 0, 1, 1, 0, 1, 1, 0], [1, 1, 0, 1, 1, 0, 1, 0], [1, 0, 1, 0, 1, 1, 0, 1], [1, 1, 1, 0, 1, 0, 1, 0]],
  },
  waltz: {
    tempo: 138, beatsPerBar: 3, swing: 0, lead: 'marimba', songBars: 32,
    progressions: [[0, 0, 4, 4], [0, 3, 0, 4], [3, 0, 4, 0], [0, 5, 3, 4]],
    rhythms: [[1, 0, 1, 0, 1, 0], [1, 1, 0, 1, 0, 0], [1, 0, 0, 1, 0, 1], [1, 0, 1, 1, 0, 0]],
  },
  island: {
    tempo: 98, beatsPerBar: 4, swing: 0.2, lead: 'kalimba', songBars: 24,
    progressions: [[0, 3, 0, 4], [0, 5, 3, 4], [3, 4, 0, 0], [0, 3, 4, 4]],
    rhythms: [[1, 0, 0, 1, 0, 1, 0, 0], [1, 0, 1, 0, 0, 1, 1, 0], [0, 1, 0, 1, 0, 0, 1, 0], [1, 0, 0, 1, 1, 0, 0, 1]],
  },
};

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
/** Major pentatonic as major-scale degrees (never clashes with the triads). */
const PENTA = [0, 1, 2, 4, 5];
const KEY_ROOTS = [60, 62, 64, 65, 67]; // C D E F G (MIDI, octave 4)
const LOOKAHEAD = 0.45;
const MAX_VOICES = 28;

const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
/** Pitch of a pentatonic step relative to the key root; steps wrap across octaves. */
function pentaPitch(root: number, step: number): number {
  const octave = Math.floor(step / PENTA.length), index = ((step % PENTA.length) + PENTA.length) % PENTA.length;
  return root + octave * 12 + MAJOR[PENTA[index]];
}
function triad(root: number, degree: number): number[] {
  return [0, 2, 4].map(k => { const d = degree + k; return root + Math.floor(d / 7) * 12 + MAJOR[d % 7]; });
}

interface Song {
  def: StyleDef;
  root: number;
  progression: number[];
  tempo: number;
  motifs: number[][]; // rhythm flags per phrase bar (A, A', B, A'')
  bar: number;
  lastPitch: number;
}

class Rng { constructor(private s = Math.floor(Math.random() * 0x7fffffff) || 1) {}
  next(): number { this.s = (Math.imul(this.s, 48271) + 0x7fffffff) % 0x7fffffff; return this.s / 0x7fffffff; }
  pick<T>(list: readonly T[]): T { return list[Math.floor(this.next() * list.length)]; }
}

export class MusicBox {
  private style: MusicStyle = 'off';
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextSlot = 0;
  private slot = 0;
  private song: Song | null = null;
  private restBars = 0;
  private voices = 0;
  private noise: AudioBuffer;
  private pads: OscillatorNode[] = [];
  private padGain: GainNode | null = null;
  private padChord = 0;
  private nextPadChord = 0;
  private rng = new Rng();
  private lead: StereoPannerNode;
  private accomp: StereoPannerNode;
  private rhythm: GainNode;

  constructor(private ctx: BaseAudioContext, private bus: AudioNode) {
    this.noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.12), ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.lead = ctx.createStereoPanner(); this.lead.pan.value = 0.18; this.lead.connect(bus);
    this.accomp = ctx.createStereoPanner(); this.accomp.pan.value = -0.22; this.accomp.connect(bus);
    this.rhythm = ctx.createGain(); this.rhythm.gain.value = 1; this.rhythm.connect(bus);
  }

  get currentStyle(): MusicStyle { return this.style; }

  setStyle(style: MusicStyle): void {
    if (style === this.style) return;
    this.stopPads();
    this.style = style;
    this.song = null; this.restBars = 0; this.slot = 0;
    this.nextSlot = this.ctx.currentTime + 0.15;
    if (style === 'calm') this.startPads();
    if (style === 'off' || style === 'calm') { this.stopTimer(); return; }
    if (!this.timer) this.timer = setInterval(() => this.pump(), 80);
    this.pump();
  }

  /** Called from the audio system's control loop as well, so an offline render can drive it without timers. */
  pump(now = this.ctx.currentTime): void {
    if (this.style === 'off') return;
    if (this.style === 'calm') { this.updatePads(now); return; }
    if (this.ctx.state !== 'running' && !(this.ctx instanceof OfflineAudioContext)) return;
    if (this.nextSlot < now - 1) this.nextSlot = now + 0.05; // fell behind (tab hidden): resume cleanly
    while (this.nextSlot < now + LOOKAHEAD) this.scheduleSlot();
  }

  private newSong(): Song {
    const def = STYLES[this.style as keyof typeof STYLES];
    const rng = this.rng;
    const motifA = rng.pick(def.rhythms), motifB = rng.pick(def.rhythms);
    const vary = (m: number[]) => m.map((v, i) => (i >= m.length - 2 && rng.next() < 0.5 ? 1 - v : v));
    return {
      def, root: rng.pick(KEY_ROOTS), progression: rng.pick(def.progressions), tempo: def.tempo * (0.96 + rng.next() * 0.08),
      motifs: [motifA, vary(motifA), motifB, motifA.map((v, i) => (i === 0 ? 1 : i > m(motifA) ? 0 : v))],
      bar: 0, lastPitch: 7,
    };
    function m(a: number[]): number { return a.length - 3; }
  }

  private scheduleSlot(): void {
    if (!this.song) {
      if (this.restBars > 0) { // silence between songs
        const def = STYLES[this.style as keyof typeof STYLES];
        this.nextSlot += (60 / def.tempo) * def.beatsPerBar; this.restBars--; return;
      }
      this.song = this.newSong();
    }
    const song = this.song, def = song.def, slotsPerBar = def.beatsPerBar * 2;
    const beat = 60 / song.tempo, slotDur = beat / 2;
    const slot = this.slot, barInPhrase = song.bar % 4, chordDegree = song.progression[song.bar % song.progression.length];
    const chord = triad(song.root, chordDegree);
    const swingOffset = slot % 2 === 1 ? def.swing * slotDur : 0;
    const t = this.nextSlot + swingOffset;
    const lastBar = song.bar === def.songBars - 1;

    // Melody: chord tones on strong beats, pentatonic steps elsewhere, ending on the root.
    const motif = song.motifs[barInPhrase];
    if (motif[slot] && !(lastBar && slot > 0)) {
      let pitch: number;
      if (lastBar) pitch = song.root + 12;
      else if (slot % 4 === 0 || this.rng.next() < 0.25) {
        const candidates = [...chord, chord[0] + 12, chord[1] + 12].filter(p => Math.abs(p - pentaPitch(song.root, song.lastPitch)) <= 7);
        const target = candidates.length ? this.rng.pick(candidates) : chord[0] + 12;
        pitch = target;
      } else {
        const step = song.lastPitch + (this.rng.next() < 0.5 ? -1 : 1) * (this.rng.next() < 0.8 ? 1 : 2);
        pitch = pentaPitch(song.root, Math.max(2, Math.min(11, step)));
      }
      // Remember as a pentatonic step for the next stepwise move.
      let nearest = 0, best = Infinity;
      for (let s = 0; s <= 12; s++) { const d = Math.abs(pentaPitch(song.root, s) - pitch); if (d < best) { best = d; nearest = s; } }
      song.lastPitch = nearest;
      let hold = 1; for (let k = slot + 1; k < slotsPerBar && !motif[k]; k++) hold++;
      const dur = Math.min(hold, 2) * slotDur * 0.95 + 0.25;
      const accent = slot % 4 === 0 ? 1 : 0.8;
      this.playLead(def.lead, midiToHz(pitch), t, lastBar ? 1.6 : dur, 0.14 * accent);
    }

    // Accompaniment, bass and percussion per style.
    const strum = (notes: number[], at: number, level: number, dur: number) => notes.forEach((n, i) => this.pluck(midiToHz(n - 12), at + i * 0.014, dur, level, this.accomp));
    if (this.style === 'sunny') {
      if (slot === 0) strum(chord, t, 0.06, 0.8);
      else if (slot % 2 === 1) this.pluck(midiToHz(chord[(slot >> 1) % 3] - 12), t, 0.35, 0.045, this.accomp);
      if (slot === 0 || slot === 4) this.bass(midiToHz(chord[slot === 4 && this.rng.next() < 0.5 ? 2 : 0] - 24), t, 0.4, 0.11);
      this.shaker(t, slot % 2 === 1 ? 0.045 : 0.024);
      if (slot === 0 || slot === 4) this.kick(t, 0.09);
    } else if (this.style === 'waltz') {
      if (slot === 0) { this.bass(midiToHz(chord[0] - 24), t, 0.45, 0.12); this.kick(t, 0.06); }
      if (slot === 2 || slot === 4) { strum(chord, t, 0.05, 0.35); this.shaker(t, 0.03); }
    } else if (this.style === 'island') {
      if (slot === 0 || slot === 3) this.bass(midiToHz(chord[slot === 3 ? 2 : 0] - 24), t, 0.3, 0.12);
      if (slot === 2 || slot === 6) strum(chord, t, 0.055, 0.22);
      this.shaker(t, slot % 2 === 1 ? 0.042 : 0.018);
      if (slot === 0) this.kick(t, 0.08);
      if (slot === 4) this.rim(t, 0.045);
    }

    // Advance.
    this.nextSlot += slotDur;
    this.slot = (slot + 1) % slotsPerBar;
    if (this.slot === 0) {
      song.bar++;
      if (song.bar >= def.songBars) { this.song = null; this.restBars = 1; }
    }
  }

  // --- Instruments -----------------------------------------------------------

  private voice(nodes: AudioNode[], source: AudioScheduledSourceNode): void {
    this.voices++;
    source.onended = () => { for (const n of nodes) n.disconnect(); this.voices = Math.max(0, this.voices - 1); };
  }

  private playLead(lead: Lead, hz: number, t: number, dur: number, level: number): void {
    if (lead === 'pluck') this.pluck(hz, t, dur, level, this.lead);
    else if (lead === 'marimba') this.mallet(hz, t, dur, level, 3.93, 0.28);
    else this.mallet(hz, t, Math.min(dur, 0.7), level * 1.1, 2.0, 0.22, 5.4);
  }

  /** Plucked string: triangle + quiet saw through a closing low-pass, fast exponential decay. */
  private pluck(hz: number, t: number, dur: number, level: number, out: AudioNode): void {
    if (this.voices >= MAX_VOICES) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator(), saw = ctx.createOscillator(), sawGain = ctx.createGain(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
    osc.type = 'triangle'; osc.frequency.value = hz;
    saw.type = 'sawtooth'; saw.frequency.value = hz * 1.004; sawGain.gain.value = 0.3;
    filter.type = 'lowpass'; filter.Q.value = 0.7;
    filter.frequency.setValueAtTime(Math.min(9000, hz * 7), t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(300, hz * 1.4), t + dur * 0.7);
    gain.gain.setValueAtTime(0, t); gain.gain.linearRampToValueAtTime(level, t + 0.004); gain.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    osc.connect(filter); saw.connect(sawGain).connect(filter); filter.connect(gain).connect(out);
    osc.start(t); saw.start(t); osc.stop(t + dur + 0.02); saw.stop(t + dur + 0.02);
    this.voice([osc, saw, sawGain, filter, gain], osc);
  }

  /** Mallet tone: fundamental plus one inharmonic partial that dies quickly. */
  private mallet(hz: number, t: number, dur: number, level: number, partial: number, partialLevel: number, partial2 = 0): void {
    if (this.voices >= MAX_VOICES) return;
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t); gain.gain.linearRampToValueAtTime(level, t + 0.003); gain.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    gain.connect(this.lead);
    const nodes: AudioNode[] = [gain];
    const add = (mult: number, lv: number, decay: number) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = hz * mult;
      g.gain.setValueAtTime(lv, t); g.gain.exponentialRampToValueAtTime(0.001, t + decay);
      o.connect(g).connect(gain); o.start(t); o.stop(t + dur + 0.02); nodes.push(o, g); return o;
    };
    const root = add(1, 1, dur);
    add(partial, partialLevel, Math.min(dur, 0.18));
    if (partial2) add(partial2, 0.12, 0.09);
    this.voice(nodes, root);
  }

  private bass(hz: number, t: number, dur: number, level: number): void {
    if (this.voices >= MAX_VOICES) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator(), sub = ctx.createOscillator(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
    osc.type = 'triangle'; osc.frequency.value = hz; sub.type = 'sine'; sub.frequency.value = hz / 2;
    filter.type = 'lowpass'; filter.frequency.value = 520;
    gain.gain.setValueAtTime(0, t); gain.gain.linearRampToValueAtTime(level, t + 0.012); gain.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    osc.connect(filter); sub.connect(filter); filter.connect(gain).connect(this.accomp);
    osc.start(t); sub.start(t); osc.stop(t + dur + 0.02); sub.stop(t + dur + 0.02);
    this.voice([osc, sub, filter, gain], osc);
  }

  private burst(t: number, level: number, decay: number, type: BiquadFilterType, frequency: number): void {
    if (this.voices >= MAX_VOICES) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
    src.buffer = this.noise; filter.type = type; filter.frequency.value = frequency; filter.Q.value = 1.2;
    gain.gain.setValueAtTime(level, t); gain.gain.exponentialRampToValueAtTime(0.0005, t + decay);
    src.connect(filter).connect(gain).connect(this.rhythm);
    src.start(t); src.stop(t + decay + 0.01);
    this.voice([src, filter, gain], src);
  }
  private shaker(t: number, level: number): void { this.burst(t, level, 0.07, 'highpass', 6500); }
  private rim(t: number, level: number): void { this.burst(t, level, 0.03, 'bandpass', 2600); }

  private kick(t: number, level: number): void {
    if (this.voices >= MAX_VOICES) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, t); osc.frequency.exponentialRampToValueAtTime(46, t + 0.09);
    gain.gain.setValueAtTime(level, t); gain.gain.exponentialRampToValueAtTime(0.0005, t + 0.2);
    osc.connect(gain).connect(this.rhythm);
    osc.start(t); osc.stop(t + 0.22);
    this.voice([osc, gain], osc);
  }

  // --- Calm pad ----------------------------------------------------------------

  private startPads(): void {
    const ctx = this.ctx;
    const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 650;
    this.padGain = ctx.createGain(); this.padGain.gain.value = 0;
    filter.connect(this.padGain).connect(this.bus);
    const t = ctx.currentTime;
    this.padGain.gain.setTargetAtTime(1, t, 1.5);
    [146.83, 220, 329.63].forEach((f, i) => {
      const osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.value = f;
      const gain = ctx.createGain(); gain.gain.value = 0.06;
      const pan = ctx.createStereoPanner(); pan.pan.value = (i - 1) * 0.38;
      osc.connect(gain).connect(pan).connect(filter);
      osc.start(); this.pads.push(osc);
    });
    this.padChord = 0; this.nextPadChord = t + 20;
  }
  private updatePads(now: number): void {
    if (now < this.nextPadChord || this.pads.length < 3) return;
    const chords = [[146.83, 220, 329.63], [130.81, 196, 293.66], [123.47, 185, 293.66], [146.83, 220, 277.18]];
    this.padChord = (this.padChord + 1) % chords.length;
    this.pads.forEach((pad, i) => pad.frequency.setTargetAtTime(chords[this.padChord][i], now, 3));
    this.nextPadChord = now + 20;
  }
  private stopPads(): void {
    const t = this.ctx.currentTime;
    if (this.padGain) { this.padGain.gain.setTargetAtTime(0, t, 0.6); const g = this.padGain; setTimeout(() => g.disconnect(), 3000); this.padGain = null; }
    for (const pad of this.pads) { try { pad.stop(t + 3); } catch { /* already stopped */ } }
    this.pads = [];
  }

  private stopTimer(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  dispose(): void {
    this.stopTimer(); this.stopPads(); this.style = 'off';
    this.lead.disconnect(); this.accomp.disconnect(); this.rhythm.disconnect();
  }
}
