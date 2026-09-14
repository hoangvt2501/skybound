/**
 * Cloud layers: two large translucent planes with procedural noise textures
 * that drift with the wind. UVs are derived from global coordinates so the
 * clouds stay fixed to the world while the planes follow the camera.
 */
import * as THREE from 'three';
import { Simplex2 } from '../world/noise';

function makeCloudTexture(seed: number, size = 512, coverage = 0.5): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const n = new Simplex2(seed);
  const n2 = new Simplex2(seed ^ 0x9e37);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Tileable via 4D-ish trick: sample on a torus using two angles.
      const ax = (x / size) * Math.PI * 2, ay = (y / size) * Math.PI * 2;
      const px = Math.cos(ax) * 1.6, py = Math.sin(ax) * 1.6, pz = Math.cos(ay) * 1.6, pw = Math.sin(ay) * 1.6;
      let v = 0, amp = 1, norm = 0, f = 1;
      for (let o = 0; o < 5; o++) {
        v += amp * (n.noise(px * f + pz * f * 0.7, py * f + pw * f * 0.7) * 0.5 + n2.noise(pz * f - px * f * 0.3, pw * f + py * f * 0.3) * 0.5);
        norm += amp;
        amp *= 0.5;
        f *= 2;
      }
      v = v / norm; // -1..1
      const e0 = 0.34 - coverage * 0.6;
      let a = THREE.MathUtils.smoothstep(v, e0, e0 + 0.42);
      a = Math.pow(a, 1.15);
      const i = (y * size + x) * 4;
      img.data[i] = 255;
      img.data[i + 1] = 255;
      img.data[i + 2] = 255;
      img.data[i + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

class CloudLayer {
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
          uShade: { value: new THREE.Color(0.7, 0.75, 0.85) },
          uOpacity: { value: opacity },
          uSunDir: { value: new THREE.Vector3(0, 1, 0) },
          uCamBelow: { value: 1 },
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
        uniform vec3 uShade;
        uniform float uOpacity;
        uniform vec3 uSunDir;
        uniform float uCamBelow;
        varying vec2 vGlobal;
        varying vec3 vWorld;
        #include <fog_pars_fragment>
        void main() {
          vec2 uv = vGlobal / uRepeat + uSpeed * uTime;
          float a = texture2D(uMap, uv).a;
          float a2 = texture2D(uMap, uv * 2.7 + vec2(0.3, 0.7) + uSpeed * uTime * 1.6).a;
          a = a * (0.75 + 0.25 * a2);
          // Fade at the plane's edge so the boundary never shows.
          float edge = 1.0 - smoothstep(0.55, 1.0, length(vWorld.xz - cameraPosition.xz) / (uRepeat * 3.2));
          // Lit from above: underside is shaded when viewed from below.
          float lit = 0.55 + 0.45 * clamp(uSunDir.y * 1.4 + 0.2, 0.0, 1.0);
          vec3 col = mix(uShade, uColor, mix(0.55, 1.0, uCamBelow < 0.5 ? 1.0 : 0.35)) * lit;
          gl_FragColor = vec4(col, a * uOpacity * edge);
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
    this.mesh.renderOrder = 5;
    this.mesh.frustumCulled = false;
  }
}

export class Clouds {
  readonly group = new THREE.Group();
  private layers: CloudLayer[] = [];
  private textures: THREE.Texture[] = [];
  readonly altitudes = [820, 1350];

  constructor(seed: number) {
    const t1 = makeCloudTexture(seed ^ 0x1111, 512, 0.5);
    const t2 = makeCloudTexture(seed ^ 0x2222, 512, 0.32);
    this.textures.push(t1, t2);
    this.layers.push(new CloudLayer(t1, 26000, this.altitudes[0], 2600, new THREE.Vector2(0.0022, 0.0009), 0.92));
    this.layers.push(new CloudLayer(t2, 30000, this.altitudes[1], 4200, new THREE.Vector2(0.0013, -0.0006), 0.7));
    for (const l of this.layers) this.group.add(l.mesh);
  }

  set visible(v: boolean) {
    this.group.visible = v;
  }

  update(cameraRender: THREE.Vector3, originX: number, originZ: number, time: number, sunDir: THREE.Vector3, sunColor: THREE.Color, daylight: number, fogColor: THREE.Color): void {
    for (const l of this.layers) {
      l.mesh.position.x = cameraRender.x;
      l.mesh.position.z = cameraRender.z;
      const u = l.material.uniforms;
      (u.uOrigin.value as THREE.Vector2).set(originX, originZ);
      u.uTime.value = time;
      (u.uSunDir.value as THREE.Vector3).copy(sunDir);
      const lit = new THREE.Color(1, 1, 1).lerp(sunColor, 0.35).multiplyScalar(THREE.MathUtils.lerp(0.22, 1, daylight));
      (u.uColor.value as THREE.Color).copy(lit);
      (u.uShade.value as THREE.Color).copy(fogColor).multiplyScalar(THREE.MathUtils.lerp(0.5, 0.85, daylight));
      u.uCamBelow.value = cameraRender.y < l.mesh.position.y ? 1 : 0;
    }
  }

  dispose(): void {
    for (const l of this.layers) {
      l.mesh.geometry.dispose();
      l.material.dispose();
    }
    for (const t of this.textures) t.dispose();
  }
}
