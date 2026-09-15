/**
 * Water contact effects: spray droplets (a points cloud whose ballistic path is
 * evaluated on the GPU from spawn data) and expanding ripple rings on the
 * surface. Both live in ring buffers; the CPU only writes the slots it spawns,
 * so a skim that emits a few droplets per frame uploads a handful of floats.
 * Positions are stored in global coordinates; a uniform carries the origin.
 */
import * as THREE from 'three';
import { SEA_LEVEL } from '../core/config';

const DROPLETS = 720;
const RINGS = 32;

export class SplashEffects {
  readonly group = new THREE.Group();
  private droplets: THREE.Points;
  private dropletMaterial: THREE.ShaderMaterial;
  private dSpawn: THREE.BufferAttribute; // x, y, z (global), birth time
  private dVel: THREE.BufferAttribute; // vx, vy, vz, life
  private dHead = 0;
  private rings: THREE.InstancedMesh;
  private ringMaterial: THREE.ShaderMaterial;
  private rSpawn: THREE.InstancedBufferAttribute; // x, z (global), birth, size
  private rHead = 0;
  private time = 0;
  private originX = 0;
  private originZ = 0;

  constructor() {
    // --- Droplets -------------------------------------------------------------
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(DROPLETS * 3), 3)); // unused, keeps three.js happy
    this.dSpawn = new THREE.BufferAttribute(new Float32Array(DROPLETS * 4).fill(-1e9), 4);
    this.dVel = new THREE.BufferAttribute(new Float32Array(DROPLETS * 4), 4);
    this.dSpawn.setUsage(THREE.DynamicDrawUsage); this.dVel.setUsage(THREE.DynamicDrawUsage);
    dg.setAttribute('aSpawn', this.dSpawn);
    dg.setAttribute('aVel', this.dVel);
    dg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.dropletMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uOrigin: { value: new THREE.Vector2() }, uColor: { value: new THREE.Color(0.86, 0.94, 1.0) }, uPixelScale: { value: 600 } },
      vertexShader: /* glsl */ `
        attribute vec4 aSpawn;
        attribute vec4 aVel;
        uniform float uTime;
        uniform vec2 uOrigin;
        uniform float uPixelScale;
        varying float vAlpha;
        void main() {
          float age = uTime - aSpawn.w;
          float life = aVel.w;
          if (age < 0.0 || age > life) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vAlpha = 0.0; return; }
          vec3 p = aSpawn.xyz + aVel.xyz * age + vec3(0.0, -9.8 * 0.5 * age * age, 0.0);
          p.y = max(p.y, ${SEA_LEVEL.toFixed(1)} - 0.05); // droplets end on the surface
          vec4 mv = viewMatrix * vec4(p.x - uOrigin.x, p.y, p.z - uOrigin.y, 1.0);
          gl_Position = projectionMatrix * mv;
          float t = age / life;
          gl_PointSize = clamp(uPixelScale * (0.05 + 0.12 * t) / max(1.0, -mv.z), 1.5, 14.0);
          vAlpha = (1.0 - t) * (1.0 - t) * 0.9;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = dot(d, d) * 4.0;
          if (r > 1.0) discard;
          float soft = 1.0 - r;
          gl_FragColor = vec4(uColor, vAlpha * soft * soft);
        }`,
      transparent: true, depthWrite: false, blending: THREE.NormalBlending,
    });
    this.droplets = new THREE.Points(dg, this.dropletMaterial);
    this.droplets.frustumCulled = false;
    this.droplets.renderOrder = 4;
    this.group.add(this.droplets);

    // --- Ripple rings ------------------------------------------------------------
    const rg = new THREE.PlaneGeometry(1, 1);
    rg.rotateX(-Math.PI / 2);
    this.rSpawn = new THREE.InstancedBufferAttribute(new Float32Array(RINGS * 4).fill(-1e9), 4);
    this.rSpawn.setUsage(THREE.DynamicDrawUsage);
    rg.setAttribute('aRing', this.rSpawn);
    this.ringMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uOrigin: { value: new THREE.Vector2() } },
      vertexShader: /* glsl */ `
        attribute vec4 aRing;
        uniform float uTime;
        uniform vec2 uOrigin;
        varying vec2 vUv;
        varying float vT;
        void main() {
          float age = uTime - aRing.z;
          float life = 2.2;
          vT = age / life;
          if (age < 0.0 || age > life) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vUv = vec2(0.0); return; }
          float radius = aRing.w * (0.6 + 5.5 * vT);
          vUv = uv;
          vec3 p = vec3(aRing.x - uOrigin.x + position.x * radius * 2.0, ${SEA_LEVEL.toFixed(1)} + 0.06, aRing.y - uOrigin.y + position.z * radius * 2.0);
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying float vT;
        void main() {
          float r = length(vUv - 0.5) * 2.0; // 0 centre, 1 edge
          float band = 1.0 - smoothstep(0.0, 0.14, abs(r - 0.86));
          float inner = 1.0 - smoothstep(0.0, 0.22, abs(r - 0.55)) * 0.0;
          float a = band * (1.0 - vT) * (1.0 - vT) * 0.55 + (1.0 - smoothstep(0.0, 0.5, r)) * (1.0 - vT) * 0.12;
          if (a < 0.01) discard;
          gl_FragColor = vec4(0.9, 0.96, 1.0, a);
        }`,
      transparent: true, depthWrite: false,
    });
    this.rings = new THREE.InstancedMesh(rg, this.ringMaterial, RINGS);
    this.rings.frustumCulled = false;
    this.rings.renderOrder = 3;
    const m = new THREE.Matrix4();
    for (let i = 0; i < RINGS; i++) this.rings.setMatrixAt(i, m);
    this.group.add(this.rings);
    this.group.name = 'Water effects';
  }

  /** A burst of droplets and a ring: `strength` 0..1 scales count, speed and ring size. */
  splash(x: number, z: number, strength: number, dirX = 0, dirZ = 0, speed = 0): void {
    const n = Math.round(18 + strength * 70);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random();
      const up = 2 + strength * 9 * Math.sqrt(r), out = 1.5 + strength * 5 * (1 - r);
      this.emit(x, z, Math.cos(a) * out + dirX * speed * 0.25 * Math.random(), up, Math.sin(a) * out + dirZ * speed * 0.25 * Math.random(), 0.6 + Math.random() * 0.7);
    }
    this.ring(x, z, 1.2 + strength * 2.6);
    if (strength > 0.5) this.ring(x, z, 0.6 + strength);
  }

  /** Continuous spray while skimming: a few droplets thrown back and up from the wake. */
  skim(x: number, z: number, dirX: number, dirZ: number, speed: number, intensity: number): void {
    const n = Math.round(2 + intensity * 5);
    for (let i = 0; i < n; i++) {
      const side = (Math.random() - 0.5) * 2;
      const lateral = 1.5 + Math.random() * 2.5;
      this.emit(x - dirX * 1.2, z - dirZ * 1.2, -dirZ * side * lateral + dirX * speed * 0.15, 2.5 + Math.random() * 3.5 * intensity, dirX * side * lateral + dirZ * speed * 0.15, 0.35 + Math.random() * 0.4);
    }
  }

  ring(x: number, z: number, size: number): void {
    this.rSpawn.setXYZW(this.rHead, x, z, this.time, size);
    this.rSpawn.addUpdateRange(this.rHead * 4, 4);
    this.rSpawn.needsUpdate = true;
    this.rHead = (this.rHead + 1) % RINGS;
  }

  private emit(x: number, z: number, vx: number, vy: number, vz: number, life: number): void {
    const i = this.dHead;
    this.dSpawn.setXYZW(i, x, SEA_LEVEL + 0.1, z, this.time);
    this.dVel.setXYZW(i, vx, vy, vz, life);
    this.dSpawn.addUpdateRange(i * 4, 4); this.dVel.addUpdateRange(i * 4, 4);
    this.dSpawn.needsUpdate = true; this.dVel.needsUpdate = true;
    this.dHead = (this.dHead + 1) % DROPLETS;
  }

  update(time: number, originX: number, originZ: number, viewportHeight: number): void {
    this.time = time;
    this.originX = originX; this.originZ = originZ;
    this.dropletMaterial.uniforms.uTime.value = time;
    (this.dropletMaterial.uniforms.uOrigin.value as THREE.Vector2).set(originX, originZ);
    this.dropletMaterial.uniforms.uPixelScale.value = viewportHeight * 0.55;
    this.ringMaterial.uniforms.uTime.value = time;
    (this.ringMaterial.uniforms.uOrigin.value as THREE.Vector2).set(originX, originZ);
    // Update ranges accumulate until the next upload; clear them once uploaded.
    if (!this.dSpawn.needsUpdate) this.dSpawn.clearUpdateRanges();
    if (!this.dVel.needsUpdate) this.dVel.clearUpdateRanges();
    if (!this.rSpawn.needsUpdate) this.rSpawn.clearUpdateRanges();
  }

  dispose(): void {
    this.droplets.geometry.dispose(); this.dropletMaterial.dispose();
    this.rings.geometry.dispose(); this.ringMaterial.dispose(); this.rings.dispose();
  }
}
