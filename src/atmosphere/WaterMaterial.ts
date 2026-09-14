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
        uniform float uTime;
        uniform vec2 uOrigin;
        varying vec3 vWorld;
        varying float vDepth;
        varying vec2 vGlobal;
        #include <fog_pars_vertex>
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vGlobal = wp.xz + uOrigin;
          // Surface stays flat: vertical displacement lets shallow seabed poke through.
          vWorld = wp.xyz;
          vDepth = depth;
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
        varying vec2 vGlobal;
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
          // Ripple strength fades with distance so far water does not alias.
          float dist = length(cameraPosition - vWorld);
          float strength = 1.6 / (1.0 + dist / 260.0);
          vec3 n = ripple(vGlobal, uTime, strength);
          vec3 viewDir = normalize(cameraPosition - vWorld);
          float depthM = max(0.0, -vDepth);
          float shallow = 1.0 - smoothstep(0.0, 14.0, depthM);
          vec3 base = mix(uDeepColor, uShallowColor, shallow);
          float fres = pow(1.0 - max(0.0, dot(viewDir, n)), 3.0);
          fres = 0.15 + 0.7 * fres;
          vec3 col = mix(base, uSkyColor, fres);
          // Sun glint
          vec3 h = normalize(uSunDir + viewDir);
          float spec = pow(max(0.0, dot(n, h)), 180.0) * max(0.0, uSunDir.y + 0.05) * 1.6;
          spec += pow(max(0.0, dot(n, h)), 24.0) * 0.12 * max(0.0, uSunDir.y);
          col += uSunColor * spec;
          // Shore foam: bright noisy band near depth 0.
          float foamBand = 1.0 - smoothstep(0.0, 1.8, depthM);
          float foamN = vnoise(vGlobal * 0.3 + vec2(uTime * 0.25, -uTime * 0.15));
          float foam = foamBand * smoothstep(0.35, 0.75, foamN + 0.35 * foamBand);
          col = mix(col, vec3(0.92, 0.95, 0.96) * uAmbient, foam * 0.75);
          col *= mix(0.55, 1.0, uAmbient);
          float alpha = mix(0.86, 0.97, 1.0 - shallow);
          alpha = mix(alpha, 0.55, foamBand * 0.4);
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
