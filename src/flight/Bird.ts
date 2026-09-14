/**
 * Procedural bird model: body, head, beak, eyes, fanned tail and two
 * three-segment articulated wings with feathered primaries. Local forward is
 * -Z, up is +Y, right wing is +X.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export interface BirdPose {
  /** 0 = pure glide, 1 = full flapping. */
  flap: number;
  /** Wingbeat frequency multiplier (boost speeds it up). */
  beatRate: number;
  /** -1..1 pitch input (tail follows). */
  pitchInput: number;
  /** -1..1 turn input (tail twists). */
  turnInput: number;
  /** Airspeed (m/s) for wing sweep. */
  speed: number;
  /** Brake pose (spread wings/tail) 0..1. */
  brake: number;
}

const COL_BACK = new THREE.Color('#4b3a2c');
const COL_BELLY = new THREE.Color('#d8cbb4');
const COL_WING_TOP = new THREE.Color('#3e3024');
const COL_WING_UNDER = new THREE.Color('#bfae95');
const COL_PRIMARY = new THREE.Color('#2b2119');
const COL_HEAD = new THREE.Color('#f0e8dc');
const COL_BEAK = new THREE.Color('#e0a030');
const COL_EYE = new THREE.Color('#151010');
const COL_TAIL = new THREE.Color('#3a2c21');
const COL_TAIL_TIP = new THREE.Color('#e9dfcd');

/** Two-tone paint by vertex normal (top darker, underside lighter). */
function paintTwoTone(g: THREE.BufferGeometry, top: THREE.Color, under: THREE.Color): THREE.BufferGeometry {
  g.computeVertexNormals();
  const pos = g.attributes.position;
  const nrm = g.attributes.normal;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = THREE.MathUtils.clamp(nrm.getY(i) * 0.5 + 0.5, 0, 1);
    const c = under.clone().lerp(top, t);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

function paintFlat(g: THREE.BufferGeometry, c: THREE.Color): THREE.BufferGeometry {
  const pos = g.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/**
 * Tapered wing panel: a thin box whose far edge is narrower (chord taper) and
 * swept back. Root at x=0, extends along +X by `length`.
 */
function wingPanel(length: number, rootChord: number, tipChord: number, sweep: number, top: THREE.Color, under: THREE.Color, thickness = 0.02): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(length, thickness, 1, 1, 1, 1);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + length / 2; // 0..length
    const t = x / length;
    const chord = THREE.MathUtils.lerp(rootChord, tipChord, t);
    const z = pos.getZ(i) * chord + sweep * t + (rootChord - chord) * 0.25;
    pos.setXYZ(i, x, pos.getY(i), z);
  }
  pos.needsUpdate = true;
  return paintTwoTone(g, top, under);
}

/** A single primary feather: thin tapered slab along +X. */
function feather(length: number, width: number, c: THREE.Color): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(length, 0.014, width, 1, 1, 1);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + length / 2;
    const t = x / length;
    pos.setXYZ(i, x, pos.getY(i), pos.getZ(i) * (1 - 0.6 * t));
  }
  pos.needsUpdate = true;
  return paintTwoTone(g, c, c.clone().lerp(COL_WING_UNDER, 0.55));
}

export class BirdModel {
  readonly group = new THREE.Group();
  private material: THREE.MeshLambertMaterial;
  private wingsL: THREE.Group[] = [];
  private wingsR: THREE.Group[] = [];
  private tail: THREE.Group;
  private tailFeathers: THREE.Group[] = [];
  private head: THREE.Group;
  private body: THREE.Mesh;
  private phase = 0;
  private flapSmooth = 0;
  private glideBob = 0;
  /** Wingspan (m) tip to tip at full extension. */
  readonly wingspan: number;

  constructor() {
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const mat = this.material;

    // Body: elongated ellipsoid, slightly deeper toward the chest.
    const bodyGeo = new THREE.SphereGeometry(1, 16, 12);
    {
      const pos = bodyGeo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        // taper toward the tail (+z) and neck (-z)
        const taper = z > 0 ? 1 - 0.35 * z * z : 1 - 0.18 * z * z;
        pos.setXYZ(i, x * 0.17 * taper, y * 0.17 * taper - 0.02 * z, z * 0.46);
      }
      pos.needsUpdate = true;
    }
    paintTwoTone(bodyGeo, COL_BACK, COL_BELLY);
    this.body = new THREE.Mesh(bodyGeo, mat);
    this.group.add(this.body);

    // Head group.
    this.head = new THREE.Group();
    this.head.position.set(0, 0.07, -0.44);
    const headGeo = paintTwoTone(new THREE.SphereGeometry(0.12, 14, 10), COL_HEAD, COL_HEAD);
    const headMesh = new THREE.Mesh(headGeo, mat);
    headMesh.scale.set(1, 0.95, 1.15);
    this.head.add(headMesh);
    const beak = new THREE.Mesh(paintFlat(new THREE.ConeGeometry(0.038, 0.16, 8), COL_BEAK), mat);
    beak.rotation.x = -Math.PI / 2;
    beak.position.set(0, -0.015, -0.19);
    this.head.add(beak);
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(paintFlat(new THREE.SphereGeometry(0.022, 8, 6), COL_EYE), mat);
      eye.position.set(sx * 0.085, 0.03, -0.07);
      this.head.add(eye);
    }
    this.group.add(this.head);

    // Wings: three hinged segments each. Segment lengths (m).
    const segs = [
      { len: 0.42, root: 0.34, tip: 0.30, sweep: 0.02 },
      { len: 0.40, root: 0.30, tip: 0.24, sweep: 0.06 },
      { len: 0.38, root: 0.24, tip: 0.10, sweep: 0.14 },
    ];
    this.wingspan = 2 * (segs[0].len + segs[1].len + segs[2].len) + 0.3;
    for (const side of [-1, 1] as const) {
      const chain: THREE.Group[] = [];
      let parent: THREE.Object3D = this.group;
      let px = side * 0.13, py = 0.06, pz = -0.06;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        const hinge = new THREE.Group();
        hinge.position.set(px, py, pz);
        const panel = new THREE.Mesh(wingPanel(s.len, s.root, s.tip, s.sweep, COL_WING_TOP, COL_WING_UNDER), mat);
        if (side < 0) panel.scale.x = -1;
        hinge.add(panel);
        if (i === 2) {
          // Fanned primaries at the tip.
          const feathers = [
            [0.34, 0.09, 0.05], [0.4, 0.085, 0.17], [0.42, 0.08, 0.3], [0.38, 0.075, 0.44], [0.32, 0.07, 0.58],
          ];
          for (const [len, w, zOff] of feathers) {
            const f = new THREE.Mesh(feather(len, w, COL_PRIMARY), mat);
            f.position.set(side * (s.len - 0.12), 0.004, s.tip * 0.5 + zOff * 0.2 + 0.02);
            f.rotation.y = -side * (zOff * 1.3 - 0.25);
            if (side < 0) f.scale.x = -1;
            hinge.add(f);
          }
        }
        parent.add(hinge);
        chain.push(hinge);
        parent = hinge;
        px = side * s.len;
        py = 0;
        pz = 0;
      }
      if (side < 0) this.wingsL = chain;
      else this.wingsR = chain;
    }

    // Tail: fan of feathers pivoting at the body rear.
    this.tail = new THREE.Group();
    this.tail.position.set(0, 0.01, 0.4);
    const tailCount = 7;
    for (let i = 0; i < tailCount; i++) {
      const t = (i / (tailCount - 1)) * 2 - 1;
      const fg = new THREE.Group();
      const f = new THREE.Mesh(paintTwoTone(new THREE.BoxGeometry(0.075, 0.012, 0.36), COL_TAIL, COL_TAIL_TIP), mat);
      f.position.set(0, 0, 0.18);
      fg.add(f);
      fg.rotation.y = -t * 0.32;
      fg.userData.base = fg.rotation.y;
      this.tail.add(fg);
      this.tailFeathers.push(fg);
    }
    this.group.add(this.tail);
  }

  /** Advance animation. `dt` in seconds. */
  update(dt: number, pose: BirdPose): void {
    // Smooth transitions between flap and glide.
    const k = 1 - Math.exp(-dt * 6);
    this.flapSmooth += (pose.flap - this.flapSmooth) * k;
    const flap = this.flapSmooth;
    // Wingbeat: fast while flapping, an occasional slow beat while gliding.
    const freq = THREE.MathUtils.lerp(0.35, 3.1 * pose.beatRate, flap);
    this.phase += dt * freq * Math.PI * 2;
    if (this.phase > Math.PI * 2000) this.phase -= Math.PI * 2000;
    this.glideBob += dt;

    const amp = THREE.MathUtils.lerp(0.06, 0.78, flap);
    const s0 = Math.sin(this.phase);
    const s1 = Math.sin(this.phase - 0.45);
    const s2 = Math.sin(this.phase - 0.95);

    // Gliding pose: slight dihedral inboard, tips drooping a little.
    const glideInner = 0.14, glideMid = -0.06, glideOuter = -0.16;
    const brakeSpread = pose.brake * 0.35;
    const sweep = THREE.MathUtils.clamp((pose.speed - 34) / 60, -0.15, 0.32) * (1 - flap * 0.5) - brakeSpread * 0.5;

    for (const [side, chain] of [[-1, this.wingsL], [1, this.wingsR]] as const) {
      const sgn = side; // right wing (+X): positive Z rotation lifts the tip; mirrored on the left
      const inner = glideInner * (1 - flap) + s0 * amp;
      const mid = glideMid * (1 - flap) + s1 * amp * 0.75;
      const outer = glideOuter * (1 - flap) + s2 * amp * 0.9;
      chain[0].rotation.set(0, side * sweep * -1, sgn * inner);
      chain[1].rotation.set(0, side * sweep * -0.6, sgn * mid);
      chain[2].rotation.set(0, side * sweep * -0.5, sgn * outer);
    }

    // Tail follows pitch and twists into turns; spreads when braking.
    this.tail.rotation.x = -pose.pitchInput * 0.35 - pose.brake * 0.4;
    this.tail.rotation.z = pose.turnInput * 0.45;
    const spread = 1 + pose.brake * 0.9 - flap * 0.15;
    for (const fg of this.tailFeathers) fg.rotation.y = fg.userData.base * spread;

    // Head stays level-ish: counter part of the pitch; slight look into turns.
    this.head.rotation.x = -pose.pitchInput * 0.12;
    this.head.rotation.y = -pose.turnInput * 0.25;

    // Body bob with each beat.
    this.body.position.y = flap * Math.sin(this.phase - 0.6) * 0.02;
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.material.dispose();
  }
}

/** Merge helper exported for tests/tools that want a single static geometry. */
export function buildStaticBirdGeometry(): THREE.BufferGeometry {
  const model = new BirdModel();
  model.group.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  model.group.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
      g.deleteAttribute('uv');
      parts.push(g.index ? g.toNonIndexed() : g);
    }
  });
  const merged = mergeGeometries(parts, false)!;
  model.dispose();
  return merged;
}
