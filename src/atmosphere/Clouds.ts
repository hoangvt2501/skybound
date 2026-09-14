/**
 * Clouds: cumulus clusters made of soft billboard puffs (visible thickness,
 * darker undersides, sun-facing highlights), plus one high thin cirrus sheet.
 *
 * Cloud masses are placed deterministically on a 2 km lattice around the
 * camera (seeded, so the same sky recurs at the same place) and drift with
 * the wind. Puffs are one InstancedMesh sorted back-to-front per frame; they
 * fade when the camera gets close so crossing a cloud never shows a hard
 * plane, and they take the scene fog so they match the sky at any hour.
 */
import * as THREE from 'three';
import { Rng, Simplex2, hash2 } from '../world/noise';

interface Puff {
  ox: number; // offset from mass center (m)
  oy: number;
  oz: number;
  size: number;
  /** 0 = underside/shaded, 1 = sunlit top. */
  light: number;
  variant: number;
  rot: number;
}

interface CloudMass {
  key: string;
  x: number; // global center (before drift)
  y: number;
  z: number;
  puffs: Puff[];
  seed: number;
}

const CELL = 2000;
const RADIUS_CELLS = 4;
const WIND = new THREE.Vector2(0.83, 0.56);
const WIND_SPEED = 2.4; // m/s
const SPRITES = 4;

function makeSpriteAtlas(seed: number): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size * SPRITES;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(canvas.width, size);
  for (let v = 0; v < SPRITES; v++) {
    const n = new Simplex2(seed ^ (v * 7919 + 13));
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = (x + 0.5) / size - 0.5, w = (y + 0.5) / size - 0.5;
        const r = Math.hypot(u, w) * 2; // 0 center .. 1 edge
        let f = 0, amp = 1, fr = 3;
        for (let o = 0; o < 4; o++) {
          f += amp * n.noise(u * fr + v * 3.1, w * fr - v * 1.7);
          amp *= 0.5;
          fr *= 2;
        }
        // Soft radial falloff broken by noise; bottom slightly flatter.
        const edge = 1 - THREE.MathUtils.smoothstep(r + f * 0.28 + (w > 0.15 ? (w - 0.15) * 0.8 : 0), 0.35, 1.0);
        const a = Math.pow(Math.max(0, edge), 1.35);
        const i = (y * canvas.width + x + v * size) * 4;
        img.data[i] = 255;
        img.data[i + 1] = 255;
        img.data[i + 2] = 255;
        img.data[i + 3] = a * 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

class CirrusLayer {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  constructor(texture: THREE.Texture, size: number, altitude: number, repeat: number, speed: THREE.Vector2, opacity: number) {
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uMap: { value: texture },
          uOrigin: { value: new THREE.Vector2() },
          uTime: { value: 0 },
          uSpeed: { value: speed },
          uRepeat: { value: repeat },
          uColor: { value: new THREE.Color(1, 1, 1) },
          uOpacity: { value: opacity },
        },
      ]),
      vertexShader: /* glsl */ `
        uniform vec2 uOrigin;
        varying vec2 vGlobal;
        varying vec3 vWorld;
        #include <fog_pars_vertex>
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vGlobal = wp.xz + uOrigin;
          vWorld = wp.xyz;
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform float uTime;
        uniform vec2 uSpeed;
        uniform float uRepeat;
        uniform vec3 uColor;
        uniform float uOpacity;
        varying vec2 vGlobal;
        varying vec3 vWorld;
        #include <fog_pars_fragment>
        void main() {
          vec2 uv = vGlobal / uRepeat + uSpeed * uTime;
          float a = texture2D(uMap, uv).a * texture2D(uMap, uv * 2.3 + vec2(0.4, 0.1) - uSpeed * uTime * 0.6).a;
          float edge = 1.0 - smoothstep(0.5, 1.0, length(vWorld.xz - cameraPosition.xz) / (uRepeat * 3.5));
          gl_FragColor = vec4(uColor, a * uOpacity * edge);
          #include <fog_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    });
    const g = new THREE.PlaneGeometry(size, size, 1, 1);
    g.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.position.y = altitude;
    this.mesh.renderOrder = 4;
    this.mesh.frustumCulled = false;
  }
}

function makeCirrusTexture(seed: number, size = 512): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const n = new Simplex2(seed);
  const n2 = new Simplex2(seed ^ 0x9e37);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ax = (x / size) * Math.PI * 2, ay = (y / size) * Math.PI * 2;
      const px = Math.cos(ax) * 1.6, py = Math.sin(ax) * 1.6, pz = Math.cos(ay) * 1.6, pw = Math.sin(ay) * 1.6;
      let v = 0, amp = 1, norm = 0, f = 1;
      for (let o = 0; o < 5; o++) {
        v += amp * (n.noise(px * f + pz * f * 0.7, py * f + pw * f * 0.7) * 0.5 + n2.noise(pz * f - px * f * 0.3, pw * f + py * f * 0.3) * 0.5);
        norm += amp;
        amp *= 0.5;
        f *= 2;
      }
      v /= norm;
      const a = Math.pow(THREE.MathUtils.smoothstep(v, 0.12, 0.62), 1.3);
      const i = (y * size + x) * 4;
      img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255; img.data[i + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Clouds {
  readonly group = new THREE.Group();
  readonly altitudes = [1050, 2800];
  private seed: number;
  private lastUpload = -Infinity;
  private uploadOriginX = NaN;
  private uploadOriginZ = NaN;
  private uploadCamera = new THREE.Vector3(Infinity, Infinity, Infinity);
  private uploadMatrix = new THREE.Matrix4();
  private puffMesh: THREE.InstancedMesh;
  private puffMaterial: THREE.ShaderMaterial;
  private sprite: THREE.Texture;
  private cirrus: CirrusLayer;
  private cirrusTex: THREE.Texture;
  private masses = new Map<string, CloudMass>();
  private lastCell = { x: NaN, z: NaN };
  private maxPuffs: number;
  private aLight: THREE.InstancedBufferAttribute;
  private aVariant: THREE.InstancedBufferAttribute;
  private order: { d: number; mass: CloudMass; puff: Puff; x: number; y: number; z: number }[] = [];

  constructor(seed: number, maxPuffs = 700) {
    this.seed = seed;
    this.maxPuffs = maxPuffs;
    this.sprite = makeSpriteAtlas(seed ^ 0x3c1d);
    this.puffMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uMap: { value: this.sprite },
          uLit: { value: new THREE.Color(1, 1, 1) },
          uShade: { value: new THREE.Color(0.6, 0.65, 0.75) },
          uSprites: { value: SPRITES },
        },
      ]),
      vertexShader: /* glsl */ `
        attribute float aLight;
        attribute float aVariant;
        uniform float uSprites;
        varying vec2 vUv;
        varying float vLight;
        varying float vNear;
        #include <fog_pars_vertex>
        void main() {
          vec3 center = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          float size = length(instanceMatrix[0].xyz);
          vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          float rot = fract(aVariant) * 6.2831;
          float cr = cos(rot), sr = sin(rot);
          vec2 p = vec2(position.x * cr - position.y * sr, position.x * sr + position.y * cr);
          vec3 wp = center + (right * p.x + up * p.y) * size;
          vUv = vec2((uv.x + floor(aVariant)) / uSprites, uv.y);
          vLight = aLight;
          vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
          vNear = -mvPosition.z;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform vec3 uLit;
        uniform vec3 uShade;
        varying vec2 vUv;
        varying float vLight;
        varying float vNear;
        #include <fog_pars_fragment>
        void main() {
          float a = texture2D(uMap, vUv).a;
          // Inside the puff the sprite is denser; fade when the camera is close.
          a *= smoothstep(25.0, 140.0, vNear);
          if (a < 0.02) discard;
          vec3 col = mix(uShade, uLit, vLight);
          gl_FragColor = vec4(col, a * 0.92);
          #include <fog_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: true,
    });
    const quad = new THREE.PlaneGeometry(1, 1, 1, 1);
    this.puffMesh = new THREE.InstancedMesh(quad, this.puffMaterial, maxPuffs);
    this.puffMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.aLight = new THREE.InstancedBufferAttribute(new Float32Array(maxPuffs), 1);
    this.aVariant = new THREE.InstancedBufferAttribute(new Float32Array(maxPuffs), 1);
    this.aLight.setUsage(THREE.DynamicDrawUsage);
    this.aVariant.setUsage(THREE.DynamicDrawUsage);
    quad.setAttribute('aLight', this.aLight);
    quad.setAttribute('aVariant', this.aVariant);
    this.puffMesh.frustumCulled = false;
    this.puffMesh.renderOrder = 6;
    this.puffMesh.count = 0;
    this.group.add(this.puffMesh);

    this.cirrusTex = makeCirrusTexture(seed ^ 0x2222);
    this.cirrus = new CirrusLayer(this.cirrusTex, 34000, this.altitudes[1], 5200, new THREE.Vector2(0.0011, -0.0005), 0.42);
    this.group.add(this.cirrus.mesh);
  }

  set visible(v: boolean) {
    this.group.visible = v;
  }

  setBudget(maxPuffs: number): void {
    this.maxPuffs = Math.min(maxPuffs, this.puffMesh.instanceMatrix.count);
    this.lastUpload = -Infinity;
  }

  private massFor(cx: number, cz: number): CloudMass | null {
    const key = `${cx},${cz}`;
    const cached = this.masses.get(key);
    if (cached) return cached;
    const h = hash2(cx, cz, this.seed ^ 0xc10d);
    if (h / 4294967296 > 0.7) {
      return null;
    }
    const rng = new Rng(h);
    const x = (cx + 0.15 + rng.next() * 0.7) * CELL;
    const z = (cz + 0.15 + rng.next() * 0.7) * CELL;
    const y = this.altitudes[0] + (rng.next() - 0.3) * 260;
    const rx = 260 + rng.next() * 420;
    const rz = rx * (0.7 + rng.next() * 0.5);
    const ry = 90 + rng.next() * 110;
    const count = 9 + rng.int(9);
    const puffs: Puff[] = [];
    for (let i = 0; i < count; i++) {
      // Ellipsoid distribution with a flatter bottom.
      const a = rng.next() * Math.PI * 2;
      const rr = Math.sqrt(rng.next());
      const ox = Math.cos(a) * rr * rx, oz = Math.sin(a) * rr * rz;
      const t = rng.next();
      const oy = (t * t * 1.35 - 0.3) * ry * (1 - rr * 0.5);
      const size = (150 + rng.next() * 190) * (1 - rr * 0.35) * (0.8 + 0.4 * (oy / ry + 0.3));
      puffs.push({ ox, oy, oz, size, light: 0, variant: rng.int(SPRITES) + rng.next() * 0.999, rot: rng.next() });
    }
    const mass: CloudMass = { key, x, y, z, puffs, seed: h };
    this.masses.set(key, mass);
    if (this.masses.size > 400) {
      // Bounded cache: drop the oldest entry.
      const first = this.masses.keys().next().value;
      if (first !== undefined) this.masses.delete(first);
    }
    return mass;
  }

  update(cameraRender: THREE.Vector3, originX: number, originZ: number, time: number, sunDir: THREE.Vector3, sunColor: THREE.Color, daylight: number, fogColor: THREE.Color): void {
    // Cirrus follows the camera; UVs are world anchored.
    this.cirrus.mesh.position.x = cameraRender.x;
    this.cirrus.mesh.position.z = cameraRender.z;
    const cu = this.cirrus.material.uniforms;
    (cu.uOrigin.value as THREE.Vector2).set(originX, originZ);
    cu.uTime.value = time;
    (cu.uColor.value as THREE.Color).copy(fogColor).lerp(new THREE.Color(1, 1, 1), 0.7 * daylight + 0.1);

    // Puff colors for the hour.
    const lit = new THREE.Color(1, 1, 1).lerp(sunColor, 0.45).multiplyScalar(THREE.MathUtils.lerp(0.28, 1.0, daylight));
    const shade = fogColor.clone().multiplyScalar(THREE.MathUtils.lerp(0.55, 0.78, daylight));
    (this.puffMaterial.uniforms.uLit.value as THREE.Color).copy(lit);
    (this.puffMaterial.uniforms.uShade.value as THREE.Color).copy(shade);

    // Color changes remain smooth; cloud geometry/order only needs 15 Hz.
    // Force upload on rebasing/teleport so cached render-space positions stay valid.
    if (time >= this.lastUpload && time - this.lastUpload < 1 / 15 &&
        originX === this.uploadOriginX && originZ === this.uploadOriginZ &&
        this.uploadCamera.distanceToSquared(cameraRender) < 2500) return;
    this.lastUpload = time;
    this.uploadOriginX = originX; this.uploadOriginZ = originZ;
    this.uploadCamera.copy(cameraRender);
    // Gather visible masses around the camera (global coords).
    const camGX = cameraRender.x + originX, camGZ = cameraRender.z + originZ;
    const driftX = WIND.x * WIND_SPEED * time, driftZ = WIND.y * WIND_SPEED * time;
    const ccx = Math.floor((camGX - driftX) / CELL), ccz = Math.floor((camGZ - driftZ) / CELL);
    this.order.length = 0;
    const maxDist = CELL * (RADIUS_CELLS + 0.5);
    for (let dz = -RADIUS_CELLS; dz <= RADIUS_CELLS; dz++) {
      for (let dx = -RADIUS_CELLS; dx <= RADIUS_CELLS; dx++) {
        const mass = this.massFor(ccx + dx, ccz + dz);
        if (!mass) continue;
        const mx = mass.x + driftX, mz = mass.z + driftZ;
        const md = Math.hypot(mx - camGX, mz - camGZ);
        if (md > maxDist) continue;
        for (const p of mass.puffs) {
          const gx = mx + p.ox, gy = mass.y + p.oy, gz = mz + p.oz;
          const rx = gx - originX, rz = gz - originZ;
          const d = Math.hypot(rx - cameraRender.x, gy - cameraRender.y, rz - cameraRender.z);
          // Lighting: height within the mass plus sun-facing side.
          const len = Math.hypot(p.ox, p.oy, p.oz) || 1;
          const facing = (p.ox / len) * sunDir.x + (p.oy / len) * sunDir.y + (p.oz / len) * sunDir.z;
          p.light = THREE.MathUtils.clamp(0.35 + 0.5 * (p.oy / 140 + 0.3) + 0.3 * facing, 0, 1);
          this.order.push({ d, mass, puff: p, x: rx, y: gy, z: rz });
        }
      }
    }
    // Back-to-front for alpha blending; keep within budget (drop the farthest).
    this.order.sort((a, b) => b.d - a.d);
    if (this.order.length > this.maxPuffs) this.order.splice(0, this.order.length - this.maxPuffs);
    const m = this.uploadMatrix;
    let i = 0;
    for (const e of this.order) {
      m.makeScale(e.puff.size, e.puff.size, e.puff.size);
      m.setPosition(e.x, e.y, e.z);
      this.puffMesh.setMatrixAt(i, m);
      this.aLight.setX(i, e.puff.light);
      this.aVariant.setX(i, e.puff.variant);
      i++;
    }
    this.puffMesh.count = i;
    this.puffMesh.instanceMatrix.needsUpdate = true;
    this.aLight.needsUpdate = true;
    this.aVariant.needsUpdate = true;
    void this.lastCell;
  }

  dispose(): void {
    this.puffMesh.geometry.dispose();
    this.puffMaterial.dispose();
    this.sprite.dispose();
    this.cirrus.mesh.geometry.dispose();
    this.cirrus.material.dispose();
    this.cirrusTex.dispose();
  }
}
