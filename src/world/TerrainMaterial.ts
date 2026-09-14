/**
 * Terrain material: MeshLambert with a procedural detail pass in the fragment
 * shader. Vertex colors carry the biome base color; a per-vertex `aux`
 * attribute carries (snow altitude factor, rockiness, wetness, aridness).
 * The shader adds, per pixel and distance-aware:
 *  - grain / grass variation in the near and mid field,
 *  - rock on steep faces using the interpolated normal (no vertex sawtooth),
 *    with strata bands and cracks, tinted red in the arid biome,
 *  - snow that collects on gentle shelves and sheds on steep faces, broken
 *    up by noise so boundaries are irregular rather than jagged,
 *  - wet, darkened banks near the water line.
 * Color math is done in linear space (vertex colors are linearized upstream).
 */
import * as THREE from 'three';

export class TerrainMaterial extends THREE.MeshLambertMaterial {
  readonly terrainUniforms = {
    uOrigin: { value: new THREE.Vector2(0, 0) },
    uDetail: { value: 1 },
  };

  constructor() {
    super({ vertexColors: true });
    this.onBeforeCompile = (shader) => {
      shader.uniforms.uOrigin = this.terrainUniforms.uOrigin;
      shader.uniforms.uDetail = this.terrainUniforms.uDetail;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute vec4 aux;
          uniform vec2 uOrigin;
          varying vec4 vAux;
          varying vec3 vWPos;
          varying vec3 vWNormal;`,
        )
        .replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>
          vAux = aux;
          {
            vec4 wp4 = modelMatrix * vec4(transformed, 1.0);
            vWPos = vec3(wp4.x + uOrigin.x, wp4.y, wp4.z + uOrigin.y);
            vWNormal = normalize(mat3(modelMatrix) * objectNormal);
          }`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uDetail;
          varying vec4 vAux;
          varying vec3 vWPos;
          varying vec3 vWNormal;
          float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float tNoise(vec2 p) {
            vec2 i = floor(p); vec2 f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            float a = tHash(i), b = tHash(i + vec2(1.0, 0.0)), c = tHash(i + vec2(0.0, 1.0)), d = tHash(i + vec2(1.0, 1.0));
            return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
          }`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          {
            vec3 col = diffuseColor.rgb;
            vec3 wn = normalize(vWNormal);
            float steep = 1.0 - wn.y;
            float dist = length(vViewPosition);
            float nearFade = (1.0 - smoothstep(180.0, 700.0, dist)) * uDetail;
            float midFade = 1.0 - smoothstep(900.0, 3200.0, dist);
            // Grain: fine near-field grain (near pixels only) and a broader mid-field mottle.
            float n1 = nearFade > 0.001 ? tNoise(vWPos.xz * 0.45) : 0.5;
            float n2 = tNoise(vWPos.xz * 0.06 + 3.1);
            float n3 = tNoise(vWPos.xz * 0.012 + 9.7);
            col *= 1.0 + (n1 - 0.5) * 0.16 * nearFade + (n2 - 0.5) * 0.12 * midFade + (n3 - 0.5) * 0.08;
            // Rock on steep faces, using the interpolated normal. The strata and
            // crack work only runs where rock is actually visible.
            float rockMask = smoothstep(0.22, 0.46, steep + vAux.y * 0.16 + (n2 - 0.5) * 0.1);
            if (rockMask > 0.003) {
              vec3 rockA = vec3(0.155, 0.135, 0.115);
              vec3 rockB = vec3(0.30, 0.27, 0.235);
              vec3 rockCol = mix(rockA, rockB, n3);
              // Strata: gently warped bands, broken by grain so they never read as contour lines.
              float strata = 0.5 + 0.5 * sin(vWPos.y * 0.3 + (n2 - 0.5) * 6.0 + (n3 - 0.5) * 3.0 + vWPos.x * 0.002);
              // Break the bands with the 16 m mottle (and near grain) so they
              // read as weathered layers, not contour lines, at every distance.
              strata *= (0.35 + 0.65 * n2) * (0.6 + 0.4 * n1);
              rockCol *= 0.92 + 0.12 * strata * midFade;
              if (nearFade > 0.001) {
                // Cracks: two rotated noise octaves so no lattice repeats.
                vec2 cp = vWPos.xz * 0.6 + vec2(vWPos.y * 0.25, -vWPos.y * 0.15);
                vec2 cr = vec2(cp.x * 0.866 - cp.y * 0.5, cp.x * 0.5 + cp.y * 0.866) * 1.9 + 7.3;
                float crackN = tNoise(cp) * 0.6 + tNoise(cr) * 0.4;
                float crack = smoothstep(0.64, 0.72, crackN);
                rockCol *= 1.0 - 0.2 * crack * nearFade;
              }
              // Arid strata are warm red/orange and keep their banding.
              vec3 aridRock = rockCol * vec3(1.9, 1.05, 0.62);
              rockCol = mix(rockCol, aridRock, vAux.w);
              col = mix(col, rockCol, rockMask);
            }
            // Snow: altitude factor from the sampler, slope from the pixel normal,
            // exposure (north-facing keeps a little more), noisy edge.
            // Snow collects on gentle shelves and sheds on steeper faces; a
            // 16 m mottle and altitude drive the patchy edge instead of a band.
            float exposure = 0.05 * clamp(-wn.z, 0.0, 1.0);
            float snowSlope = 1.0 - smoothstep(0.16, 0.5, steep + (n2 - 0.5) * 0.34 - exposure);
            float snow = clamp(vAux.x + exposure, 0.0, 1.0) * snowSlope;
            snow = smoothstep(0.18, 0.72, snow + (n1 - 0.5) * 0.14 * nearFade);
            col = mix(col, vec3(0.70, 0.75, 0.86), snow);
            // Wet banks near the water line.
            col = mix(col, col * vec3(0.58, 0.56, 0.5), vAux.z);
            diffuseColor.rgb = col;
          }`,
        );
    };
    this.customProgramCacheKey = () => 'skybound-terrain-v1';
  }

  setOrigin(x: number, z: number): void {
    this.terrainUniforms.uOrigin.value.set(x, z);
  }
}
