/**
 * The mist-valley brook and its waterfall: a stream that meanders down the valley floor into the
 * lake, fed by a fall where the head wall meets the floor. Both are thin ribbons laid on the terrain
 * (the terrain itself is not carved, so saves and collision stay as they are) with one flowing-foam
 * shader: noise scrolls along the ribbon, foam gathers where the ribbon is steep, the edges fade out.
 * Purely visual: no collider, no water event. The group follows the floating origin.
 */
import * as THREE from 'three';
import { SEA_LEVEL } from '../core/config';
import { NOISE_CELLS, noiseTexture } from '../world/NoiseTexture';
import type { WorldGen } from '../world/WorldGen';

export interface FallInfo { x: number; y: number; z: number; baseY: number; drop: number }

interface RibbonPoint { x: number; y: number; z: number; width: number; foam: number }

const _a = new THREE.Vector3(), _b = new THREE.Vector3();

/** Build a ribbon along `points` (world space, minus `anchor`), uv.x along the length, uv.y across. */
function ribbon(points: RibbonPoint[], anchor: THREE.Vector3, lift: number, fall: number, uScale: number): THREE.BufferGeometry {
  const n = points.length;
  const pos = new Float32Array(n * 2 * 3), uv = new Float32Array(n * 2 * 2), extra = new Float32Array(n * 2 * 2);
  const idx: number[] = [];
  let u = 0;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const prev = points[Math.max(0, i - 1)], next = points[Math.min(n - 1, i + 1)];
    _a.set(next.x - prev.x, 0, next.z - prev.z).normalize();
    _b.set(-_a.z, 0, _a.x); // left of the flow direction
    if (i > 0) u += Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z) / uScale;
    for (let side = 0; side < 2; side++) {
      const s = side === 0 ? -1 : 1, k = (i * 2 + side);
      pos[k * 3] = p.x + _b.x * p.width * 0.5 * s - anchor.x;
      pos[k * 3 + 1] = p.y + lift - anchor.y;
      pos[k * 3 + 2] = p.z + _b.z * p.width * 0.5 * s - anchor.z;
      uv[k * 2] = u; uv[k * 2 + 1] = side;
      extra[k * 2] = p.foam; extra[k * 2 + 1] = fall;
    }
    if (i > 0) { const a = (i - 1) * 2, b = i * 2; idx.push(a, a + 1, b, a + 1, b + 1, b); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aExtra', new THREE.BufferAttribute(extra, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export class ValleyStream {
  readonly group = new THREE.Group();
  readonly material: THREE.ShaderMaterial;
  /** World position of the group's local origin (the stream's own coordinates are relative to it). */
  readonly anchor = new THREE.Vector3();
  readonly fall: FallInfo | null;
  /** Stream length (m) from the fall to the lake. */
  readonly length: number;

  constructor(gen: WorldGen) {
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uTime: { value: 0 },
          uNoise: { value: null },
          uSky: { value: new THREE.Color(0.55, 0.72, 0.9) },
          uDeep: { value: new THREE.Color(0.08, 0.3, 0.36) },
          uAmbient: { value: 1 },
        },
      ]),
      vertexShader: /* glsl */ `
        attribute vec2 aExtra;
        varying vec2 vUv;
        varying vec2 vExtra;
        #include <fog_pars_vertex>
        void main() {
          vUv = uv;
          vExtra = aExtra;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform sampler2D uNoise;
        uniform vec3 uSky;
        uniform vec3 uDeep;
        uniform float uAmbient;
        varying vec2 vUv;
        varying vec2 vExtra;
        #include <fog_pars_fragment>
        float vnoise(vec2 p) { return texture2D(uNoise, p * ${(1 / NOISE_CELLS).toFixed(8)}).r; }
        void main() {
          float fall = vExtra.y;
          // Foam streaks scroll with the flow; on the fall they stretch along the drop and run faster.
          float flow = uTime * (0.7 + 2.4 * fall);
          vec2 p = vec2(vUv.x, vUv.y * 1.6);
          vec2 stretch = mix(vec2(1.0, 2.6), vec2(0.35, 4.0), fall);
          float n1 = vnoise(p * stretch * 6.0 - vec2(flow, 0.0));
          float n2 = vnoise(p * stretch * vec2(2.3, 1.7) * 6.0 - vec2(flow * 1.7, 0.2));
          float foam = smoothstep(0.5, 0.72, n1 * 0.6 + n2 * 0.4 + vExtra.x * 0.22 + fall * 0.06);
          float edge = smoothstep(0.0, 0.2, vUv.y) * smoothstep(1.0, 0.8, vUv.y);
          vec3 water = mix(uDeep, uSky, 0.5 + 0.35 * fall);
          vec3 col = mix(water, vec3(0.93, 0.97, 1.0), foam) * uAmbient;
          float alpha = (0.6 + 0.36 * foam) * edge * mix(1.0, 0.9, fall);
          gl_FragColor = vec4(col, alpha);
          #include <fog_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      fog: true,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    this.material.uniforms.uNoise.value = noiseTexture();

    // Stream: from the head of the valley down to the lake, meandering across the floor.
    const path = gen.valleyPath(120); // mouth -> head
    const head = path[path.length - 1], mouth = path[0];
    const ax = head.x - mouth.x, az = head.z - mouth.z, len = Math.hypot(ax, az), dx = ax / len, dz = az / len;
    const nx = -dz, nz = dx;
    const points: RibbonPoint[] = [];
    let started = false, prevY = Infinity;
    for (let i = path.length - 1; i >= 0; i--) {
      const p = path[i];
      if (p.t > 0.955) continue;
      const along = p.t * len;
      const meander = 42 * Math.sin(along / 210 + 0.7) + 26 * Math.sin(along / 73 + 2.1);
      const x = p.x + nx * meander, z = p.z + nz * meander;
      const y = gen.heightAt(x, z);
      if (y < SEA_LEVEL + 0.3) { if (started) { points.push({ x, y: SEA_LEVEL + 0.05, z, width: 12, foam: 0 }); } break; }
      started = true;
      const steep = Math.max(0, prevY === Infinity ? 0 : (prevY - y) / 20);
      points.push({ x, y, z, width: 4.5 + 5 * (1 - p.t), foam: Math.min(1, steep * 3) });
      prevY = y;
    }
    this.anchor.set(head.x, 0, head.z);
    this.length = points.length > 1 ? points.reduce((s, p, i) => s + (i > 0 ? Math.hypot(p.x - points[i - 1].x, p.z - points[i - 1].z) : 0), 0) : 0;
    if (points.length > 1) this.group.add(new THREE.Mesh(ribbon(points, this.anchor, 0.35, 0, 7), this.material));

    // Waterfall: past the head, the floor climbs into the head wall. Take the steepest 60 m run of
    // the axis beyond the stream's first point and hang a ribbon down it.
    let fall: FallInfo | null = null;
    if (points.length > 1) {
      const top = points[0];
      const samples: { x: number; z: number; y: number }[] = [];
      for (let s = 0; s <= 260; s += 4) { const x = top.x + dx * s, z = top.z + dz * s; samples.push({ x, z, y: gen.heightAt(x, z) }); }
      let best = 0, bestI = -1;
      for (let i = 0; i + 15 < samples.length; i++) { const drop = samples[i + 15].y - samples[i].y; if (drop > best) { best = drop; bestI = i; } }
      if (bestI >= 0 && best > 12) {
        const fallPts: RibbonPoint[] = [];
        for (let i = bestI + 15; i >= bestI; i--) { const s = samples[i]; fallPts.push({ x: s.x, y: s.y, z: s.z, width: 6.5, foam: 0.8 }); }
        // Run into the pool: a few metres of level water at the base.
        const base = samples[bestI];
        for (let k = 1; k <= 3; k++) fallPts.push({ x: base.x - dx * k * 4, y: base.y - 0.2, z: base.z - dz * k * 4, width: 8 + k * 2, foam: 1 - k * 0.25 });
        this.group.add(new THREE.Mesh(ribbon(fallPts, this.anchor, 1.1, 1, 5), this.material));
        fall = { x: base.x, y: samples[bestI + 15].y, z: base.z, baseY: base.y, drop: best };
      }
    }
    this.fall = fall;
    this.group.renderOrder = 3;
  }

  update(time: number, originX: number, originZ: number, sky: THREE.Color, ambient: number): void {
    this.group.position.set(this.anchor.x - originX, 0, this.anchor.z - originZ);
    const u = this.material.uniforms;
    u.uTime.value = time;
    (u.uSky.value as THREE.Color).copy(sky);
    u.uAmbient.value = ambient;
  }

  dispose(): void {
    for (const c of this.group.children) (c as THREE.Mesh).geometry.dispose();
    this.material.dispose();
  }
}
