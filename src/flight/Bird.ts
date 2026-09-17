/**
 * Procedural bird model: a lathed body with neck, a species head (beak, eyes,
 * brow, facial disc or ear tufts), cambered feathered wings in three hinged
 * segments with fanned primaries, a fanned tail and tucked feet. Local forward
 * is -Z, up is +Y, right wing is +X. Everything is vertex-coloured; one
 * Lambert material.
 */
import * as THREE from 'three';
import { BIRD_SPECIES, type BirdSpecies } from './BirdSpecies';
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
  /** Landing flare 0..1: wings raised and spread, tail fanned, legs reaching down. */
  flare?: number;
  /** Perched 0..1: wings folded along the body, legs down, no wingbeat. */
  perch?: number;
  /** Head yaw while perched (radians, + = looks right). */
  lookYaw?: number;
  /** Preening 0..1: head dips toward a wing. */
  preen?: number;
}

type Paint = (t: number, u: number, c: THREE.Color) => void;
/** Leg hinge angle with the legs tucked back under the tail (flight). 0 = straight down. */
const LEG_TUCKED = 1.35;
const _c = new THREE.Color();

/** Fill the colour attribute from a paint callback over (t, u) in [0,1]² stored in uv. */
function paintByUv(g: THREE.BufferGeometry, paint: Paint): THREE.BufferGeometry {
  const uv = g.attributes.uv, n = g.attributes.position.count, colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    paint(uv.getX(i), uv.getY(i), _c);
    colors[i * 3] = _c.r; colors[i * 3 + 1] = _c.g; colors[i * 3 + 2] = _c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/** Two-tone by normal (top colour above, under colour below), with an optional extra paint. */
function paintTwoTone(g: THREE.BufferGeometry, top: THREE.Color, under: THREE.Color, extra?: (i: number, c: THREE.Color, pos: THREE.BufferAttribute) => void): THREE.BufferGeometry {
  if (!g.attributes.normal) g.computeVertexNormals();
  const pos = g.attributes.position as THREE.BufferAttribute, nrm = g.attributes.normal;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = THREE.MathUtils.clamp(nrm.getY(i) * 0.5 + 0.5, 0, 1);
    _c.copy(under).lerp(top, THREE.MathUtils.smoothstep(t, 0.25, 0.75));
    extra?.(i, _c, pos);
    colors[i * 3] = _c.r; colors[i * 3 + 1] = _c.g; colors[i * 3 + 2] = _c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

function paintFlat(g: THREE.BufferGeometry, c: THREE.Color): THREE.BufferGeometry {
  const n = g.attributes.position.count, colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/**
 * Cambered wing plate. Root at x=0, span along +X, chord along Z with the
 * leading edge toward -Z. `t` = span fraction, `u` = chord fraction from the
 * leading edge (kept in uv for painting). The trailing edge is scalloped into
 * secondaries. One-sided; callers stack a top and an under plate.
 */
function wingPlate(length: number, rootChord: number, tipChord: number, sweep: number, camber: number, scallops: number, lift: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, 1, 10, 4);
  const pos = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getX(i) + 0.5, u = pos.getY(i) + 0.5;
    const chord = THREE.MathUtils.lerp(rootChord, tipChord, t);
    const scallop = scallops > 0 ? Math.pow(u, 4) * Math.abs(Math.sin(t * Math.PI * scallops)) * chord * 0.16 : 0;
    const z = (u - 0.3) * chord + sweep * t + scallop + (rootChord - chord) * 0.2;
    const y = camber * chord * Math.sin(Math.PI * u) + lift;
    pos.setXYZ(i, t * length, y, z);
    uv.setXY(i, t, u);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/** Rounded, tapered feather along +X: width `w`, elliptical tip over the last 45 %. */
function featherPlate(length: number, w: number, lift = 0): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, 1, 8, 2);
  const pos = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getX(i) + 0.5, v = pos.getY(i);
    const taper = t < 0.55 ? 1 : Math.sqrt(Math.max(0, 1 - Math.pow((t - 0.55) / 0.45, 2)));
    pos.setXYZ(i, t * length, lift * t * t, v * w * (0.75 + 0.25 * (1 - t)) * taper);
    uv.setXY(i, t, v + 0.5);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/** Cone beak pointing -Z with a downward hook. */
function beakGeometry(length: number, radius: number, hook: number, c: THREE.Color): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(radius, length, 10, 3);
  g.rotateX(-Math.PI / 2); // tip toward -Z
  g.translate(0, 0, -length / 2);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const t = THREE.MathUtils.clamp(-pos.getZ(i) / length, 0, 1);
    pos.setY(i, pos.getY(i) * (1 - 0.35 * t) - hook * t * t);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return paintFlat(g, c);
}

/** Body + neck as one lathe along Z (narrow neck end toward -Z). */
function bodyGeometry(): THREE.BufferGeometry {
  const profile: [number, number][] = [
    [0.02, -0.56], [0.06, -0.5], [0.11, -0.42], [0.155, -0.3], [0.17, -0.14], [0.165, 0.02], [0.14, 0.18], [0.1, 0.32], [0.06, 0.42], [0.025, 0.5], [0.005, 0.54],
  ];
  // Lathe revolves (x = radius, y = axis) around Y; rotate so the axis lies along Z.
  const g = new THREE.LatheGeometry(profile.map(([r, z]) => new THREE.Vector2(r, z)), 22);
  g.rotateX(Math.PI / 2); // (x, y, z) -> (x, -z, y): profile y (our z) lands on +Z
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i), z = pos.getZ(i);
    pos.setXYZ(i, pos.getX(i), y * 0.92 - 0.015 - 0.03 * Math.max(0, z), z);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  g.deleteAttribute('uv');
  return g;
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
  private legs: THREE.Group[] = [];
  private primaries: { g: THREE.Group; base: number }[] = [];
  /** Folded-wing orientation of each hinge (left chain, right chain): roll the plate onto the flank, droop, sweep back. */
  private foldPose: [THREE.Quaternion[], THREE.Quaternion[]];
  private perchSmooth = 0;
  private flareSmooth = 0;
  private lookSmooth = 0;
  private preenSmooth = 0;
  private phase = 0;
  private flapSmooth = 0;
  private glideBob = 0;
  /** Wingspan (m) tip to tip at full extension. */
  readonly wingspan: number;
  readonly species: BirdSpecies;
  private beatMultiplier = 1;

  constructor(species: BirdSpecies = 'eagle') {
    this.species = species;
    const style = BIRD_SPECIES[species];
    this.beatMultiplier = style.beat;
    const COL_BACK = new THREE.Color(style.back), COL_BELLY = new THREE.Color(style.belly);
    const COL_WING = new THREE.Color(style.wing), COL_UNDER = new THREE.Color(style.under);
    const COL_PRIMARY = new THREE.Color(style.primary), COL_FACE = new THREE.Color(style.face);
    const COL_BEAK = new THREE.Color(style.beak), COL_EYE = new THREE.Color('#151010'), COL_GLINT = new THREE.Color('#ffffff');
    const light = COL_WING.clone().lerp(COL_BELLY, 0.45), dark = COL_WING.clone().multiplyScalar(0.72);
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    // Wrapped diffuse: the sun's falloff continues a little past the terminator, so the shaded side and
    // the far wing keep their colour and read against the ground instead of dropping to a silhouette.
    this.material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_lambert_pars_fragment>',
        THREE.ShaderChunk.lights_lambert_pars_fragment.replace(
          'float dotNL = saturate( dot( geometryNormal, directLight.direction ) );',
          'float dotNL = saturate( ( dot( geometryNormal, directLight.direction ) + 0.45 ) / 1.45 );',
        ),
      );
    };
    this.material.customProgramCacheKey = () => 'skybound-bird-wrap-v1';
    const mat = this.material;
    const mesh = (g: THREE.BufferGeometry) => new THREE.Mesh(g, mat);

    // Species pattern painters for the wing top and under sides.
    const feathering = (t: number, u: number) => 1 + (Math.floor(t * 9 + u * 0.5) % 2 === 0 ? 0.035 : -0.035) * Math.max(0, u - 0.45) * 2;
    const topPaint = (outer: boolean): Paint => (t, u, c) => {
      c.copy(COL_WING);
      if (u < 0.35) c.multiplyScalar(0.88 + u * 0.3); // coverts sit darker along the leading edge
      c.multiplyScalar(feathering(t, u));
      if (species === 'owl' && Math.floor(t * 8 + u * 1.5) % 2 === 0) c.lerp(light, 0.38); // barring
      if (species === 'gull' && outer) c.lerp(COL_PRIMARY, THREE.MathUtils.smoothstep(t, 0.55, 0.95)); // dark tips
      if (species === 'swallow' && u < 0.3) c.lerp(new THREE.Color('#6d8fb8'), 0.35 * (1 - u / 0.3)); // steel sheen
      if (species === 'eagle' && !outer && t < 0.35) c.lerp(light, 0.22 * (1 - t / 0.35)); // pale shoulder
    };
    const underPaint: Paint = (t, u, c) => {
      c.copy(COL_UNDER).multiplyScalar(feathering(t, u));
      if (u > 0.65) c.lerp(COL_BELLY, 0.3);
      if (species === 'owl' && Math.floor(t * 8 + u * 1.5) % 2 === 0) c.multiplyScalar(0.92);
    };

    // Body.
    const bodyGeo = bodyGeometry();
    paintTwoTone(bodyGeo, COL_BACK, COL_BELLY, (i, c, pos) => {
      const z = pos.getZ(i), y = pos.getY(i);
      if (species === 'swallow' && z < -0.32 && y < 0.05) c.lerp(COL_FACE, 0.75); // rusty throat
      if (species === 'gull' && z < -0.3) c.lerp(COL_BELLY, 0.7); // white neck
      if (species === 'eagle' && z < -0.4) c.lerp(COL_FACE, 0.8); // white neck into the head
    });
    this.body = mesh(bodyGeo);
    this.body.scale.setScalar(style.body);
    this.group.add(this.body);

    // Head.
    this.head = new THREE.Group();
    this.head.position.set(0, 0.075 * style.body, -0.5 * style.body);
    const headGeo = new THREE.SphereGeometry(0.115, 18, 14);
    headGeo.scale(1, 0.94, 1.12);
    paintTwoTone(headGeo, species === 'swallow' ? COL_BACK : COL_FACE, species === 'swallow' ? COL_FACE : COL_FACE.clone().lerp(COL_BELLY, 0.3), (i, c, pos) => {
      if (species === 'swallow' && pos.getY(i) > 0.02) c.copy(COL_BACK); // blue crown, rust face
    });
    this.head.add(mesh(headGeo));
    const beak = species === 'eagle' ? beakGeometry(0.15, 0.04, 0.05, COL_BEAK)
      : species === 'gull' ? beakGeometry(0.16, 0.03, 0.015, COL_BEAK)
      : species === 'swallow' ? beakGeometry(0.07, 0.03, 0.005, COL_BEAK)
      : beakGeometry(0.075, 0.03, 0.045, COL_BEAK);
    const beakMesh = mesh(beak);
    beakMesh.position.set(0, species === 'owl' ? -0.02 : -0.01, -0.1);
    this.head.add(beakMesh);
    if (species === 'gull') { // red spot on the lower mandible
      const spot = mesh(paintFlat(new THREE.SphereGeometry(0.008, 6, 5), new THREE.Color('#d8452c')));
      spot.position.set(0, -0.022, -0.22); this.head.add(spot);
    }
    for (const sx of [-1, 1]) {
      if (species === 'owl') {
        const disc = mesh(paintFlat(new THREE.SphereGeometry(0.07, 16, 12), COL_FACE.clone().lerp(COL_BELLY, 0.4)));
        disc.position.set(sx * 0.06, 0.005, -0.075); disc.scale.set(1, 1.15, 0.3); this.head.add(disc);
        const rim = mesh(paintFlat(new THREE.TorusGeometry(0.062, 0.008, 6, 20), dark));
        rim.position.set(sx * 0.06, 0.005, -0.09); rim.scale.set(1, 1.15, 1); this.head.add(rim);
        const iris = mesh(paintFlat(new THREE.SphereGeometry(0.03, 12, 10), new THREE.Color('#f2b53a')));
        iris.position.set(sx * 0.06, 0.008, -0.105); this.head.add(iris);
        const pupil = mesh(paintFlat(new THREE.SphereGeometry(0.017, 10, 8), COL_EYE));
        pupil.position.set(sx * 0.06, 0.008, -0.128); this.head.add(pupil);
        const tuft = mesh(paintTwoTone(new THREE.ConeGeometry(0.03, 0.09, 7), COL_BACK, COL_BACK));
        tuft.position.set(sx * 0.075, 0.115, -0.02); tuft.rotation.z = -sx * 0.5; tuft.rotation.x = -0.3; this.head.add(tuft);
      } else {
        const eye = mesh(paintFlat(new THREE.SphereGeometry(0.02, 10, 8), COL_EYE));
        eye.position.set(sx * 0.085, 0.028, -0.075); this.head.add(eye);
        const glint = mesh(paintFlat(new THREE.SphereGeometry(0.006, 6, 5), COL_GLINT));
        glint.position.set(sx * 0.095, 0.036, -0.088); this.head.add(glint);
        if (species === 'eagle') { // brow ridge for the fierce look
          const brow = mesh(paintFlat(new THREE.BoxGeometry(0.06, 0.012, 0.05), COL_FACE.clone().multiplyScalar(0.85)));
          brow.position.set(sx * 0.085, 0.052, -0.075); brow.rotation.z = -sx * 0.25; brow.rotation.y = sx * 0.3; this.head.add(brow);
        }
      }
    }
    this.head.scale.setScalar(style.head);
    this.group.add(this.head);

    // Wings: three hinged segments, each a top and an under plate.
    const segs = [
      { len: 0.42, root: 0.36, tip: 0.31, sweep: 0.02, camber: 0.12, scallops: 4 },
      { len: 0.40, root: 0.31, tip: 0.25, sweep: 0.06, camber: 0.1, scallops: 4 },
      { len: 0.36, root: 0.25, tip: 0.12, sweep: 0.15, camber: 0.06, scallops: 0 },
    ];
    for (const seg of segs) { seg.len *= style.span; seg.root *= style.chord; seg.tip *= style.chord; if (style.fork) seg.sweep *= 2.2; }
    this.wingspan = 2 * (segs[0].len + segs[1].len + segs[2].len) + 0.32 * style.body;
    const primaryCount = species === 'eagle' ? 7 : species === 'owl' ? 6 : 5;
    const primarySpread = species === 'eagle' ? 0.62 : species === 'owl' ? 0.42 : 0.26;
    for (const side of [-1, 1] as const) {
      const chain: THREE.Group[] = [];
      let parent: THREE.Object3D = this.group;
      let px = side * 0.14 * style.body, py = 0.07 * style.body, pz = -0.06;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        const hinge = new THREE.Group();
        hinge.position.set(px, py, pz);
        const outer = i === 2;
        const top = mesh(paintByUv(wingPlate(s.len, s.root, s.tip, s.sweep, s.camber, s.scallops, 0.006), topPaint(outer)));
        const under = mesh(paintByUv(wingPlate(s.len, s.root, s.tip, s.sweep, s.camber, s.scallops, -0.006), underPaint));
        if (side < 0) { top.scale.x = -1; under.scale.x = -1; }
        hinge.add(top, under);
        // A flattened ellipsoid at the joint hides the seam between segments as they flex.
        const joint = mesh(paintTwoTone(new THREE.SphereGeometry(1, 10, 7), COL_WING, COL_UNDER));
        joint.scale.set(0.05 * style.chord + 0.02, 0.014, s.root * 0.42);
        joint.position.set(0, 0, s.root * 0.2 + (i === 0 ? 0.02 : 0));
        hinge.add(joint);
        if (outer) {
          // Fanned primaries at the tip: splayed "fingers" on the eagle, a pointed tip on gull and swallow.
          for (let k = 0; k < primaryCount; k++) {
            const f = k / (primaryCount - 1);
            const len = s.len * (species === 'eagle' ? 1.0 + 0.2 * Math.sin(f * Math.PI) : 1.05 + 0.25 * (1 - f)) * (species === 'owl' ? 0.8 : 1);
            const w = s.tip * (species === 'owl' ? 0.55 : 0.36) * (1 - 0.3 * f);
            const paint: Paint = (t, u, c) => {
              c.copy(COL_PRIMARY);
              if (species === 'gull' && k % 2 === 1) c.lerp(COL_BELLY, 0.55 * THREE.MathUtils.smoothstep(t, 0.82, 0.9) * (1 - THREE.MathUtils.smoothstep(t, 0.93, 1))); // white mirror spots
              if (species === 'owl' && Math.floor(t * 6) % 2 === 0) c.lerp(light, 0.3);
              if (u < 0.5) c.multiplyScalar(0.94);
            };
            const underPaintP: Paint = (t, u, c) => { c.copy(COL_PRIMARY).lerp(COL_UNDER, 0.45); if (u < 0.5) c.multiplyScalar(0.95); };
            const feather = new THREE.Group();
            const ft = mesh(paintByUv(featherPlate(len, w, species === 'eagle' ? 0.03 : 0.01), paint));
            const fu = mesh(paintByUv(featherPlate(len, w, species === 'eagle' ? 0.03 : 0.01), underPaintP));
            fu.position.y = -0.004;
            feather.add(ft, fu);
            const pivotZ = s.sweep + s.tip * 0.15 + f * s.tip * 0.35;
            feather.position.set(side * (s.len - 0.06), 0, pivotZ);
            feather.rotation.y = -side * (f * primarySpread - primarySpread * 0.35 + 0.05);
            feather.rotation.x = side * (species === 'eagle' ? 0.06 * (1 - f) : 0.02);
            if (side < 0) feather.scale.x = -1;
            hinge.add(feather);
            this.primaries.push({ g: feather, base: feather.rotation.y });
          }
        }
        parent.add(hinge);
        chain.push(hinge);
        parent = hinge;
        px = side * s.len; py = 0; pz = 0;
      }
      if (side < 0) this.wingsL = chain; else this.wingsR = chain;
    }
    // Folded wing: the upper arm rolls its top surface outward, drops and sweeps back along the flank; the
    // forearm and hand curve back up so the tips meet over the tail. Euler order YZX = roll, then droop,
    // then sweep, each about the segment's own axes. The left wing mirrors the yaw and droop.
    const folded = (roll: number, sweep: number, droop: number, side: number) => new THREE.Quaternion().setFromEuler(new THREE.Euler(roll, side * sweep, side * droop, 'YZX'));
    this.foldPose = [-1, 1].map((side) => [folded(-1.25, -1.62, -0.5, side), folded(0, -0.26, 0.12, side), folded(0, -0.2, 0.05, side)]) as [THREE.Quaternion[], THREE.Quaternion[]];

    // Tail: fan of rounded feathers pivoting at the body rear.
    this.tail = new THREE.Group();
    this.tail.position.set(0, 0.01, 0.42 * style.body);
    const tailCount = style.fork ? 6 : 7;
    const tailPaint = (outerness: number): Paint => (t, u, c) => {
      c.copy(COL_WING);
      if (species === 'eagle') c.copy(t < 0.25 ? COL_WING : COL_BELLY.clone().lerp(new THREE.Color('#ffffff'), 0.5));
      if (species === 'gull') { c.copy(COL_BELLY); if (t > 0.68 && t < 0.86) c.copy(COL_PRIMARY); }
      if (species === 'owl' && Math.floor(t * 6) % 2 === 0) c.lerp(light, 0.35);
      if (species === 'swallow' && t > 0.45 && t < 0.58 && outerness > 0.3) c.lerp(COL_BELLY, 0.8);
      c.multiplyScalar(1 + (u < 0.5 ? -0.03 : 0.03));
    };
    for (let i = 0; i < tailCount; i++) {
      const t = (i / (tailCount - 1)) * 2 - 1;
      const fg = new THREE.Group();
      const tailLength = 0.38 * style.tail * (style.fork ? 0.32 + Math.pow(Math.abs(t), 1.6) * 1.1 : 1 - Math.abs(t) * 0.1);
      const width = style.fork ? 0.055 : 0.085;
      const g = featherPlate(tailLength, width);
      g.rotateY(-Math.PI / 2); // feather +X -> +Z (backwards)
      const f = mesh(paintByUv(g, tailPaint(Math.abs(t))));
      fg.add(f);
      fg.rotation.y = -t * (style.fork ? 0.2 : 0.3);
      fg.userData.base = fg.rotation.y;
      this.tail.add(fg);
      this.tailFeathers.push(fg);
    }
    this.group.add(this.tail);

    // Legs: a hinge under the belly with a thin shank and the foot at its end. Tucked back along the
    // body in flight (the old pose), swung down to reach for a perch and while sitting on one.
    const footColor = species === 'swallow' ? new THREE.Color('#4a4340') : species === 'owl' ? COL_BELLY.clone().multiplyScalar(0.8) : COL_BEAK;
    const shankLength = 0.2 * style.body;
    for (const sx of [-1, 1]) {
      const leg = new THREE.Group();
      leg.position.set(sx * 0.06 * style.body, -0.09 * style.body, 0.1 * style.body);
      const shank = mesh(paintFlat(new THREE.CylinderGeometry(0.011 * style.body, 0.014 * style.body, shankLength, 5), footColor));
      shank.position.y = -shankLength / 2;
      leg.add(shank);
      const foot = mesh(paintFlat(new THREE.ConeGeometry(0.022, 0.12, 6), footColor));
      foot.rotation.x = Math.PI / 2 + 0.2;
      foot.position.set(0, -shankLength, -0.02 * style.body);
      leg.add(foot);
      leg.rotation.x = LEG_TUCKED;
      this.group.add(leg);
      this.legs.push(leg);
    }
  }

  /** Advance animation. `dt` in seconds. */
  update(dt: number, pose: BirdPose): void {
    // Smooth transitions between flap and glide, and into the landing / perched poses.
    const k = 1 - Math.exp(-dt * 6);
    const perch = pose.perch ?? 0, flare = pose.flare ?? 0;
    this.perchSmooth += (perch - this.perchSmooth) * (1 - Math.exp(-dt * 5));
    this.flareSmooth += (flare - this.flareSmooth) * (1 - Math.exp(-dt * 8));
    this.lookSmooth += ((pose.lookYaw ?? 0) - this.lookSmooth) * (1 - Math.exp(-dt * 3));
    this.preenSmooth += ((pose.preen ?? 0) - this.preenSmooth) * (1 - Math.exp(-dt * 4));
    this.flapSmooth += (pose.flap * (1 - this.perchSmooth) - this.flapSmooth) * k;
    const flap = this.flapSmooth;
    const fold = this.perchSmooth, spread = this.flareSmooth * (1 - fold);
    // Wingbeat: fast while flapping, an occasional slow beat while gliding.
    const freq = THREE.MathUtils.lerp(0.35, 3.1 * pose.beatRate * this.beatMultiplier, flap);
    this.phase += dt * freq * Math.PI * 2;
    if (this.phase > Math.PI * 2000) this.phase -= Math.PI * 2000;
    this.glideBob += dt;

    const amp = THREE.MathUtils.lerp(0.06, 0.78, flap);
    const s0 = Math.sin(this.phase);
    const s1 = Math.sin(this.phase - 0.45);
    const s2 = Math.sin(this.phase - 0.95);
    const stroke = Math.cos(this.phase - 0.5); // +1 on the way up, -1 on the way down

    // Gliding pose: slight dihedral inboard, tips drooping a little.
    const glideInner = 0.14, glideMid = -0.06, glideOuter = -0.16;
    const brakeSpread = pose.brake * 0.35;
    const sweep = THREE.MathUtils.clamp((pose.speed - 34) / 60, -0.15, 0.32) * (1 - flap * 0.5) - brakeSpread * 0.5;

    for (const [side, chain] of [[-1, this.wingsL], [1, this.wingsR]] as const) {
      const sgn = side; // right wing (+X): positive Z rotation lifts the tip; mirrored on the left
      const inner = glideInner * (1 - flap) + s0 * amp;
      const mid = glideMid * (1 - flap) + s1 * amp * 0.75;
      const outer = glideOuter * (1 - flap) + s2 * amp * 0.9;
      // The hand pitches nose-down on the downstroke and flexes back on the upstroke.
      const twist = flap * stroke * 0.22;
      const flex = flap * Math.max(0, stroke) * 0.35;
      // Flare: wings up and forward to catch the air (positive yaw brings the tips forward).
      const flareZ = spread * 0.55, flareY = spread * 0.3;
      chain[0].rotation.set(0, side * (sweep * -1 + flareY), sgn * (inner + flareZ));
      chain[1].rotation.set(twist * 0.5, side * (sweep * -0.6 + flex * 0.5 + flareY * 0.5), sgn * (mid - spread * 0.1));
      chain[2].rotation.set(twist, side * (sweep * -0.5 + flex), sgn * (outer - spread * 0.25));
      // Perched: blend each hinge toward its folded orientation.
      if (fold > 0.001) {
        const target = this.foldPose[side < 0 ? 0 : 1];
        for (let i = 0; i < 3; i++) chain[i].quaternion.slerp(target[i], fold);
      }
    }
    // The primaries close their fan as the wing folds.
    for (const p of this.primaries) p.g.rotation.y = p.base * (1 - fold * 0.8);

    // Tail follows pitch and twists into turns; spreads when braking or flaring.
    this.tail.rotation.x = -pose.pitchInput * 0.35 - pose.brake * 0.4 - spread * 0.35 + fold * 0.15;
    this.tail.rotation.z = pose.turnInput * 0.45;
    const fan = 1 + pose.brake * 0.9 + spread * 0.8 - flap * 0.15 - fold * 0.3;
    for (const fg of this.tailFeathers) fg.rotation.y = fg.userData.base * fan;

    // Legs swing down for the landing and stay down on the perch.
    const legAngle = LEG_TUCKED * (1 - Math.max(fold, spread * 0.9));
    for (const leg of this.legs) leg.rotation.x = legAngle;

    // Head stays level-ish: counter part of the pitch; slight look into turns; tiny bob per beat.
    // On a perch it looks around and dips to preen a wing.
    this.head.rotation.x = -pose.pitchInput * 0.12 + this.preenSmooth * 0.7;
    this.head.rotation.y = -pose.turnInput * 0.25 + this.lookSmooth * fold + this.preenSmooth * 1.1;
    this.head.rotation.z = -this.preenSmooth * 0.5;
    this.head.position.y = 0.075 * BIRD_SPECIES[this.species].body + flap * Math.sin(this.phase - 0.9) * 0.008 - this.preenSmooth * 0.03;

    // Body bob with each beat; a slow breath on the perch.
    this.body.position.y = flap * Math.sin(this.phase - 0.6) * 0.02 + fold * Math.sin(this.glideBob * 1.7) * 0.004;
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.material.dispose();
  }
}

