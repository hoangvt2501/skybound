/**
 * Day/night cycle: sun and moon positions, light colors, sky palette and fog
 * color derived from a time-of-day value in [0, 1) (0 = midnight, 0.5 = noon).
 */
import * as THREE from 'three';
import { DAY_LENGTH_SECONDS } from '../core/config';

export interface SkyPalette {
  zenith: THREE.Color;
  horizon: THREE.Color;
  fog: THREE.Color;
  sunColor: THREE.Color;
  sunIntensity: number;
  ambientSky: THREE.Color;
  ambientGround: THREE.Color;
  ambientIntensity: number;
  /** 0 = full night, 1 = full day. */
  daylight: number;
  starAlpha: number;
}

function mixColors(out: THREE.Color, stops: [number, THREE.Color][], t: number): THREE.Color {
  // stops sorted by position in [0,1]
  for (let i = 0; i < stops.length - 1; i++) {
    const [p0, c0] = stops[i];
    const [p1, c1] = stops[i + 1];
    if (t >= p0 && t <= p1) {
      const k = (t - p0) / (p1 - p0);
      return out.copy(c0).lerp(c1, k * k * (3 - 2 * k));
    }
  }
  return out.copy(stops[stops.length - 1][1]);
}

const C = (hex: string) => new THREE.Color(hex);
// Palette keyed by sun elevation e in [-1, 1] mapped to [0,1] as (e+1)/2.
// Night keeps a readable moonlit blue rather than true black.
const ZENITH: [number, THREE.Color][] = [
  [0.0, C('#0b1430')], [0.42, C('#101a3a')], [0.47, C('#3a3f6e')], [0.52, C('#6c89c4')], [0.6, C('#5f95d8')], [1.0, C('#3f7fd0')],
];
const HORIZON: [number, THREE.Color][] = [
  [0.0, C('#1a2440')], [0.42, C('#2e2a48')], [0.47, C('#e08a5a')], [0.52, C('#f2c294')], [0.6, C('#cfe3f4')], [1.0, C('#c9dff2')],
];
const SUN: [number, THREE.Color][] = [
  [0.0, C('#9fb4e6')], [0.44, C('#a3a8d0')], [0.47, C('#ff8c4a')], [0.52, C('#ffc88a')], [0.6, C('#fff0d8')], [1.0, C('#fff6e8')],
];
// Around sunrise the sky light stays cool and fairly strong while the sun is orange, so shadows read
// blue against the warm lit faces instead of going muddy.
const AMB_SKY: [number, THREE.Color][] = [
  [0.0, C('#3a4c78')], [0.46, C('#3d4468')], [0.49, C('#5e73b0')], [0.52, C('#8aa4d2')], [1.0, C('#9fc3ea')],
];
const AMB_GROUND: [number, THREE.Color][] = [
  [0.0, C('#1e2430')], [0.46, C('#33302c')], [0.49, C('#4a4650')], [0.52, C('#6a5a48')], [1.0, C('#6e6a58')],
];
// Evening variants blended in through the afternoon: the sunset horizon goes rose and amber under a
// violet zenith, the sun a deeper orange, so dusk is not a replay of dawn.
const ZENITH_EVE: [number, THREE.Color][] = [
  [0.0, C('#0b1430')], [0.42, C('#161a44')], [0.47, C('#4a3f7c')], [0.52, C('#6a7ec0')], [0.6, C('#5a8fd4')], [1.0, C('#3f7fd0')],
];
const HORIZON_EVE: [number, THREE.Color][] = [
  [0.0, C('#1a2440')], [0.42, C('#3a2a4c')], [0.47, C('#e8785a')], [0.52, C('#f2b088')], [0.6, C('#d9dcec')], [1.0, C('#c9dff2')],
];
const SUN_EVE: [number, THREE.Color][] = [
  [0.0, C('#9fb4e6')], [0.44, C('#a3a8d0')], [0.47, C('#ff7040')], [0.52, C('#ffb070')], [0.6, C('#ffe8cc')], [1.0, C('#fff6e8')],
];
const _eve = new THREE.Color();
function mixDayEve(out: THREE.Color, day: [number, THREE.Color][], eve: [number, THREE.Color][], t: number, evening: number): THREE.Color {
  mixColors(out, day, t);
  if (evening > 0.001) out.lerp(mixColors(_eve, eve, t), evening);
  return out;
}

export class DayCycle {
  /** 0..1 time of day. */
  time = 0.32;
  cycling = true;
  /** Cycle length in seconds. */
  dayLength = DAY_LENGTH_SECONDS;
  readonly sunDir = new THREE.Vector3(0, 1, 0);
  readonly moonDir = new THREE.Vector3(0, -1, 0);
  readonly palette: SkyPalette = {
    zenith: new THREE.Color(),
    horizon: new THREE.Color(),
    fog: new THREE.Color(),
    sunColor: new THREE.Color(),
    sunIntensity: 1,
    ambientSky: new THREE.Color(),
    ambientGround: new THREE.Color(),
    ambientIntensity: 1,
    daylight: 1,
    starAlpha: 0,
  };

  advance(dt: number): void {
    if (!this.cycling) return;
    this.time = (this.time + dt / this.dayLength) % 1;
    if (this.time < 0) this.time += 1;
  }

  setTime(t: number): void {
    this.time = ((t % 1) + 1) % 1;
  }

  /** Hour label like 06:30. */
  get label(): string {
    const h = Math.floor(this.time * 24);
    const m = Math.floor((this.time * 24 - h) * 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  }

  /** Recompute sun/moon directions and the palette. */
  compute(): SkyPalette {
    const a = (this.time - 0.25) * Math.PI * 2; // sunrise at 0.25, noon 0.5
    // Sun rises in the east (+X), passes slightly south (+Z), sets west.
    const elev = Math.sin(a);
    const az = Math.cos(a);
    this.sunDir.set(-az * 0.92, elev, 0.38 * Math.max(0.2, Math.abs(az) * 0.5 + 0.5)).normalize();
    this.moonDir.set(az * 0.85, -elev * 0.9 + 0.1, -0.45).normalize();
    const e = (elev + 1) / 2;
    // 0 through the morning, rising over the afternoon to 1 at sunset and through the night.
    const evening = THREE.MathUtils.smoothstep(-az, 0.05, 0.85);
    const p = this.palette;
    mixDayEve(p.zenith, ZENITH, ZENITH_EVE, e, evening);
    mixDayEve(p.horizon, HORIZON, HORIZON_EVE, e, evening);
    // Fog sits between horizon and zenith so distant terrain reads as blue
    // silhouettes rather than white cut-outs.
    p.fog.copy(p.horizon).lerp(p.zenith, 0.42);
    mixDayEve(p.sunColor, SUN, SUN_EVE, e, evening);
    mixColors(p.ambientSky, AMB_SKY, e);
    mixColors(p.ambientGround, AMB_GROUND, e);
    const daylight = THREE.MathUtils.smoothstep(elev, -0.12, 0.18);
    p.daylight = daylight;
    p.sunIntensity = daylight > 0.02 ? THREE.MathUtils.lerp(0.7, 2.6, daylight) : 0.7; // moonlight at night
    p.ambientIntensity = THREE.MathUtils.lerp(1.0, 1.15, daylight);
    p.starAlpha = 1 - THREE.MathUtils.smoothstep(elev, -0.22, 0.02);
    return p;
  }

  /** True when the sun is below the horizon (light comes from the moon). */
  get isNight(): boolean {
    return this.sunDir.y < -0.05;
  }

  /** Direction of the active key light (sun by day, moon by night). */
  keyLightDir(out: THREE.Vector3): THREE.Vector3 {
    if (this.sunDir.y > -0.03) return out.copy(this.sunDir);
    return out.copy(this.moonDir);
  }
}
