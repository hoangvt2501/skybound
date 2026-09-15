/**
 * Dust motes rising in a slow spiral inside nearby thermals: the visual hint
 * that a column of lift is there. One points cloud, all motion on the GPU
 * from per-mote seeds; the app supplies up to three columns per frame.
 */
import * as THREE from 'three';

const COLUMNS = 3;
const MOTES_PER_COLUMN = 220;

export class ThermalMotes {
  readonly points: THREE.Points;
  private material: THREE.ShaderMaterial;
  private columns: THREE.Vector4[] = [];
  enabled = true;

  constructor() {
    const n = COLUMNS * MOTES_PER_COLUMN;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const seed = new Float32Array(n), column = new Float32Array(n);
    for (let i = 0; i < n; i++) { seed[i] = (i * 0.618033) % 1; column[i] = Math.floor(i / MOTES_PER_COLUMN); }
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    g.setAttribute('aColumn', new THREE.BufferAttribute(column, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.columns = Array.from({ length: COLUMNS }, () => new THREE.Vector4(0, 0, 0, 0));
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelScale: { value: 600 },
        uColumns: { value: this.columns }, // x, z (render space), base height, radius
        uTops: { value: new Float32Array(COLUMNS) },
        uStrength: { value: new Float32Array(COLUMNS) },
        uColor: { value: new THREE.Color(1.0, 0.9, 0.55) },
      },
      vertexShader: /* glsl */ `
        attribute float aSeed;
        attribute float aColumn;
        uniform float uTime;
        uniform float uPixelScale;
        uniform vec4 uColumns[${COLUMNS}];
        uniform float uTops[${COLUMNS}];
        uniform float uStrength[${COLUMNS}];
        varying float vAlpha;
        float h1(float p) { return fract(sin(p * 127.1) * 43758.5453); }
        void main() {
          int c = int(aColumn + 0.5);
          vec4 col = uColumns[c];
          float strength = uStrength[c];
          if (strength < 0.01 || col.w < 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vAlpha = 0.0; return; }
          float height = min(uTops[c] - col.z, 420.0);
          float r = col.w * (0.12 + 0.8 * h1(aSeed * 3.1));
          float rise = 1.4 + 1.2 * h1(aSeed * 5.7);
          float y = mod(aSeed * height + uTime * rise, height);
          float angle = aSeed * 6.2832 + uTime * (0.9 - 0.6 * r / col.w) + y * 0.01;
          vec3 p = vec3(col.x + cos(angle) * r, col.z + y, col.y + sin(angle) * r);
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float dist = max(1.0, -mv.z);
          gl_PointSize = clamp(uPixelScale * 0.5 / dist, 2.0, 9.0);
          float ends = smoothstep(0.0, 0.12, y / height) * (1.0 - smoothstep(0.8, 1.0, y / height));
          vAlpha = ends * strength * (1.0 - smoothstep(500.0, 900.0, dist));
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = dot(d, d) * 4.0;
          if (r > 1.0 || vAlpha < 0.02) discard;
          gl_FragColor = vec4(uColor, vAlpha * (1.0 - r));
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    this.points.name = 'Thermal motes';
  }

  /** Columns in render space: {x, z, base, radius, top, strength 0..1}. Missing slots are switched off. */
  update(time: number, viewportHeight: number, columns: { x: number; z: number; base: number; radius: number; top: number; strength: number }[]): void {
    const u = this.material.uniforms;
    u.uTime.value = time;
    u.uPixelScale.value = viewportHeight * 0.55;
    const tops = u.uTops.value as Float32Array, strengths = u.uStrength.value as Float32Array;
    for (let i = 0; i < COLUMNS; i++) {
      const c = columns[i];
      if (c) { this.columns[i].set(c.x, c.z, c.base, c.radius); tops[i] = c.top; strengths[i] = c.strength; }
      else { this.columns[i].set(0, 0, 0, 0); tops[i] = 0; strengths[i] = 0; }
    }
    this.points.visible = this.enabled && columns.length > 0;
  }

  dispose(): void { this.points.geometry.dispose(); this.material.dispose(); }
}
