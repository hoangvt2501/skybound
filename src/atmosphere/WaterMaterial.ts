/**
 * Stylized water: depth-tinted surface with animated procedural ripples,
 * sun glints, fresnel toward the sky color and shore foam. One shared
 * ShaderMaterial; per-vertex `depth` carries terrain height under the surface.
 */
import * as THREE from 'three';

export class WaterMaterial extends THREE.ShaderMaterial {
  constructor() {
    super({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uTime: { value: 0 },
          uOrigin: { value: new THREE.Vector2(0, 0) },
          uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.2) },
          uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
          uSkyColor: { value: new THREE.Color(0.55, 0.72, 0.9) },
          uDeepColor: { value: new THREE.Color(0.04, 0.22, 0.36) },
          uShallowColor: { value: new THREE.Color(0.18, 0.56, 0.62) },
          uAmbient: { value: 1.0 },
        },
      ]),
      vertexShader: /* glsl */ `
        attribute float depth;
        attribute float exposure;
        uniform float uTime;
        uniform vec2 uOrigin;
        varying vec3 vWorld;
        varying float vDepth;
        varying float vExposure;
        varying vec2 vGlobal;
        varying float vCrest;
        varying vec2 vWaveSlope;
        #include <fog_pars_vertex>
        // Open-sea swell: three long waves whose amplitude fades in the shallows
        // (so the shoreline stays put) and on sheltered water (lakes stay calm).
        void swell(vec2 p, float t, float amp, out float h, out vec2 slope) {
          vec2 d1 = normalize(vec2(0.82, 0.57)), d2 = normalize(vec2(-0.35, 0.94)), d3 = normalize(vec2(0.6, -0.8));
          float k1 = 6.2832 / 64.0, k2 = 6.2832 / 37.0, k3 = 6.2832 / 23.0;
          float a1 = 0.7 * amp, a2 = 0.34 * amp, a3 = 0.16 * amp;
          float p1 = dot(d1, p) * k1 - t * 1.05, p2 = dot(d2, p) * k2 - t * 1.45, p3 = dot(d3, p) * k3 - t * 1.9;
          h = a1 * sin(p1) + a2 * sin(p2) + a3 * sin(p3);
          slope = d1 * a1 * k1 * cos(p1) + d2 * a2 * k2 * cos(p2) + d3 * a3 * k3 * cos(p3);
        }
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vGlobal = wp.xz + uOrigin;
          float exposure01 = clamp(exposure, 0.0, 1.0);
          float depthM = max(0.0, -depth);
          float amp = smoothstep(0.3, 0.9, exposure01) * smoothstep(0.5, 7.0, depthM);
          float h; vec2 slope;
          swell(vGlobal, uTime, amp, h, slope);
          wp.y += h;
          vWorld = wp.xyz;
          vDepth = depth;
          vExposure = exposure;
          // Crest factor for whitecaps: how close this vertex is to a wave top.
          vCrest = amp > 0.001 ? clamp(h / (0.75 * amp) * 0.5 + 0.5, 0.0, 1.0) : 0.0;
          vWaveSlope = slope;
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uSkyColor;
        uniform vec3 uDeepColor;
        uniform vec3 uShallowColor;
        uniform float uAmbient;
        varying vec3 vWorld;
        varying float vDepth;
        varying float vExposure;
        varying vec2 vGlobal;
        varying float vCrest;
        varying vec2 vWaveSlope;
        #include <fog_pars_fragment>

        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vnoise(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }
        float rippleField(vec2 p, float t) {
          return vnoise(p * 0.055 + vec2(t * 0.05, t * 0.035)) + 0.5 * vnoise(p * 0.16 - vec2(t * 0.07, t * 0.045));
        }
        vec3 ripple(vec2 p, float t, float strength) {
          float e = 0.8;
          float n0 = rippleField(p, t);
          float nx = rippleField(p + vec2(e, 0.0), t);
          float nz = rippleField(p + vec2(0.0, e), t);
          return normalize(vec3(-(nx - n0) * strength, 1.0, -(nz - n0) * strength));
        }

        void main() {
          // Exposure: 1 = open sea (wind ripples, surf), 0 = sheltered lake (calm).
          float exposure = clamp(vExposure, 0.0, 1.0);
          // Ripple strength fades with distance so far water does not alias.
          float dist = length(cameraPosition - vWorld);
          float strength = (0.5 + 1.1 * exposure) / (1.0 + dist / 260.0);
          vec3 n = ripple(vGlobal, uTime * (0.55 + 0.45 * exposure), strength);
          // Tilt the ripple normal by the swell slope so the long waves catch the light.
          n = normalize(n + vec3(-vWaveSlope.x, 0.0, -vWaveSlope.y) * 2.2);
          vec3 viewDir = normalize(cameraPosition - vWorld);
          float depthM = max(0.0, -vDepth);
          float shallow = 1.0 - smoothstep(0.0, 14.0, depthM);
          // Lakes read slightly darker and greener than the open sea.
          vec3 deep = mix(uDeepColor * vec3(0.9, 1.0, 0.85), uDeepColor, exposure);
          vec3 shallowCol = mix(uShallowColor * vec3(0.85, 0.95, 0.8), uShallowColor, exposure);
          vec3 base = mix(deep, shallowCol, shallow);
          float fres = pow(1.0 - max(0.0, dot(viewDir, n)), 3.0);
          fres = 0.15 + 0.7 * fres;
          vec3 col = mix(base, uSkyColor, fres);
          // Sun glint (softer on calm water).
          vec3 h = normalize(uSunDir + viewDir);
          float spec = pow(max(0.0, dot(n, h)), 180.0) * max(0.0, uSunDir.y + 0.05) * (0.9 + 0.9 * exposure);
          spec += pow(max(0.0, dot(n, h)), 24.0) * 0.12 * max(0.0, uSunDir.y);
          col += uSunColor * spec;
          // Surf: only on exposed shores, broken by noise. Lakes get a faint,
          // narrow wet-edge darkening instead of foam.
          float foamBand = 1.0 - smoothstep(0.0, 1.6, depthM);
          float foamN = vnoise(vGlobal * 0.3 + vec2(uTime * 0.25, -uTime * 0.15));
          float surf = foamBand * smoothstep(0.42, 0.8, foamN + 0.3 * foamBand) * smoothstep(0.35, 0.8, exposure);
          col = mix(col, vec3(0.92, 0.95, 0.96) * uAmbient, surf * 0.7);
          // Whitecaps: streaks of foam along the swell crests on open water, broken by noise.
          // Streaks of foam only at the very top of a crest: fine noise stretched along the wave direction,
          // thinned by a second octave, and faded with distance so far water stays clean.
          vec2 streakUv = vec2(vGlobal.x * 0.82 + vGlobal.y * 0.57, -vGlobal.x * 0.57 + vGlobal.y * 0.82);
          float capN = vnoise(streakUv * vec2(0.12, 0.42) + vec2(uTime * 0.6, uTime * 0.2)) * 0.65 + vnoise(streakUv * vec2(0.28, 0.95) - vec2(uTime * 0.35, 0.0)) * 0.35;
          float caps = smoothstep(0.86, 0.99, vCrest) * smoothstep(0.6, 0.78, capN) * smoothstep(0.5, 0.9, exposure) / (1.0 + dist / 500.0);
          col = mix(col, vec3(0.95, 0.97, 0.98) * uAmbient, caps * 0.45);
          col *= mix(0.55, 1.0, uAmbient);
          float alpha = mix(0.82, 0.97, 1.0 - shallow);
          alpha = mix(alpha, 0.5, foamBand * 0.45);
          // Soft shoreline: fade across the interpolated water line. Pixels
          // over land are occluded by the terrain anyway, so the fade may start
          // slightly on the land side without leaking; this keeps small ponds
          // that do not cover a water-grid vertex visible.
          alpha *= smoothstep(-1.2, 0.35, -vDepth);
          gl_FragColor = vec4(col, alpha);
          #include <fog_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      fog: true,
      side: THREE.FrontSide,
    });
  }
}
