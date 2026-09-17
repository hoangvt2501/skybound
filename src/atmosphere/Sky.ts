/**
 * Sky dome: gradient by sun elevation, sun and moon discs with glow, and a
 * seeded star field that fades in at night. The dome follows the camera.
 */
import * as THREE from 'three';
import { Rng } from '../world/noise';
import type { SkyPalette } from './DayCycle';

export class Sky {
  readonly group = new THREE.Group();
  private dome: THREE.Mesh;
  private domeMat: THREE.ShaderMaterial;
  private stars: THREE.Points;
  private starMat: THREE.PointsMaterial;

  constructor(seed: number) {
    this.domeMat = new THREE.ShaderMaterial({
      uniforms: {
        uZenith: { value: new THREE.Color('#3f7fd0') },
        uHorizon: { value: new THREE.Color('#c9dff2') },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
        uSunColor: { value: new THREE.Color('#fff6e8') },
        uDaylight: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_Position.z = gl_Position.w * 0.999999; // always at the far plane
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uZenith;
        uniform vec3 uHorizon;
        uniform vec3 uSunDir;
        uniform vec3 uMoonDir;
        uniform vec3 uSunColor;
        uniform float uDaylight;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float h = clamp(d.y, -0.2, 1.0);
          float t = pow(clamp(h, 0.0, 1.0), 0.55);
          // With the sun low, the horizon colour belongs to the sunward side: away from the sun the
          // band cools toward the zenith, so dawn and dusk have a bright side and a shaded side.
          float lowSun = 1.0 - smoothstep(0.12, 0.45, abs(uSunDir.y));
          vec2 toSun = normalize(uSunDir.xz + vec2(1e-4, 0.0));
          float away = 0.5 - 0.5 * dot(normalize(d.xz + vec2(1e-4, 0.0)), toSun);
          vec3 horizon = mix(uHorizon, mix(uHorizon, uZenith, 0.4), away * lowSun * (1.0 - t));
          vec3 col = mix(horizon, uZenith, t);
          // Below the horizon: darken toward a haze so the far plane never shows.
          col = mix(col, horizon * 0.85, smoothstep(0.0, -0.2, d.y));
          float sd = max(0.0, dot(d, uSunDir));
          // Sunward horizon warmth, stronger while the sun is low.
          col += uSunColor * pow(sd, 6.0) * (0.18 + 0.2 * lowSun) * (1.0 - t) * (0.4 + 0.6 * uDaylight);
          // Sun disc and glow.
          float disc = smoothstep(0.9993, 0.9997, sd);
          float glow = pow(sd, 240.0) * 0.8 + pow(sd, 32.0) * 0.14;
          float sunVis = smoothstep(-0.08, 0.03, uSunDir.y);
          col += (uSunColor * (disc * 3.0 + glow)) * sunVis;
          // Moon: a softer pale disc.
          float md = max(0.0, dot(d, uMoonDir));
          float mdisc = smoothstep(0.9994, 0.9998, md);
          float mglow = pow(md, 300.0) * 0.35;
          float moonVis = smoothstep(-0.05, 0.05, uMoonDir.y) * (1.0 - uDaylight * 0.7);
          col += vec3(0.85, 0.9, 1.0) * (mdisc * 1.6 + mglow) * moonVis;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), this.domeMat);
    this.dome.scale.setScalar(9000);
    this.dome.renderOrder = -100;
    this.dome.frustumCulled = false;
    this.group.add(this.dome);

    // Stars
    const rng = new Rng(seed ^ 0x5741);
    const n = 1400;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = rng.next(), v = rng.next();
      const theta = u * Math.PI * 2;
      const phi = Math.acos(1 - v * 1.02); // mostly above the horizon
      const r = 8000;
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.cos(phi);
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
      const w = 0.6 + rng.next() * 0.4;
      const tint = rng.next();
      col[i * 3] = w * (tint < 0.2 ? 1 : 0.9);
      col[i * 3 + 1] = w * 0.92;
      col[i * 3 + 2] = w * (tint > 0.8 ? 1 : 0.95);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.starMat = new THREE.PointsMaterial({ size: 14, sizeAttenuation: true, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, depthTest: false, fog: false });
    this.stars = new THREE.Points(g, this.starMat);
    this.stars.renderOrder = -99;
    this.stars.frustumCulled = false;
    this.group.add(this.stars);
  }

  update(cameraPos: THREE.Vector3, palette: SkyPalette, sunDir: THREE.Vector3, moonDir: THREE.Vector3, time: number): void {
    this.group.position.copy(cameraPos);
    const u = this.domeMat.uniforms;
    (u.uZenith.value as THREE.Color).copy(palette.zenith);
    (u.uHorizon.value as THREE.Color).copy(palette.horizon);
    (u.uSunDir.value as THREE.Vector3).copy(sunDir);
    (u.uMoonDir.value as THREE.Vector3).copy(moonDir);
    (u.uSunColor.value as THREE.Color).copy(palette.sunColor);
    u.uDaylight.value = palette.daylight;
    this.starMat.opacity = palette.starAlpha * 0.9;
    this.stars.visible = palette.starAlpha > 0.01;
    this.stars.rotation.y = time * 0.002;
  }

  dispose(): void {
    this.dome.geometry.dispose();
    this.domeMat.dispose();
    this.stars.geometry.dispose();
    this.starMat.dispose();
  }
}
