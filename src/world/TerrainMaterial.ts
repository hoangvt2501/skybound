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
 *
 * Geomorph: a per-vertex `aMorph` attribute (parent height, parent normal)
 * holds the coarser representation's surface; `uMorph` blends from it (0) to
 * this LOD's own surface (1). Only chunks in transition carry a material twin
 * with their own `uMorph`; settled chunks share one material at 1.
 */
import * as THREE from 'three';
import { NOISE_CELLS, noiseTexture } from './NoiseTexture';

/**
 * Aerial perspective, shared by the terrain and vegetation materials: from a few hundred metres out the
 * lit colour loses saturation and contrast toward the fog colour, well before the scene fog itself
 * takes over, so far slopes read as pale masses behind the near ground rather than as more of it.
 * Runs after tone mapping, right before the fog mix, and only when the scene has fog.
 */
export function aerialFragment(start: number, end: number, strength: number): string {
  return /* glsl */ `
  #ifdef USE_FOG
  {
    float aerial = smoothstep(${start.toFixed(1)}, ${end.toFixed(1)}, vFogDepth);
    float lum = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    vec3 pale = mix(vec3(lum), fogColor, 0.7);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, pale, aerial * ${strength.toFixed(2)});
  }
  #endif
`;
}
/** Terrain and full-geometry trees: paling from 300 m, half strength at ~1.6 km. */
export const AERIAL_FRAGMENT = aerialFragment(300, 3000, 0.45);

export interface TerrainUniforms {
  uOrigin: { value: THREE.Vector2 };
  uDetail: { value: number };
  uNoise: { value: THREE.Texture };
}

export class TerrainMaterial extends THREE.MeshLambertMaterial {
  readonly terrainUniforms: TerrainUniforms;
  /** Geomorph progress for the meshes using this material instance: 0 = parent surface, 1 = own surface. */
  readonly morphUniform = { value: 1 };

  constructor(uniforms?: TerrainUniforms) {
    super({ vertexColors: true });
    this.terrainUniforms = uniforms ?? { uOrigin: { value: new THREE.Vector2(0, 0) }, uDetail: { value: 1 }, uNoise: { value: noiseTexture() } };
    this.onBeforeCompile = (shader) => {
      shader.uniforms.uOrigin = this.terrainUniforms.uOrigin;
      shader.uniforms.uDetail = this.terrainUniforms.uDetail;
      shader.uniforms.uNoise = this.terrainUniforms.uNoise;
      shader.uniforms.uMorph = this.morphUniform;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute vec4 aux;
          attribute vec4 aMorph;
          uniform vec2 uOrigin;
          uniform float uMorph;
          varying vec4 vAux;
          varying vec3 vWPos;
          varying vec3 vWNormal;`,
        )
        .replace(
          '#include <beginnormal_vertex>',
          `#include <beginnormal_vertex>
          objectNormal = normalize(mix(aMorph.yzw, objectNormal, uMorph));`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          transformed.y = mix(aMorph.x, transformed.y, uMorph);`,
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
          uniform sampler2D uNoise;
          varying vec4 vAux;
          varying vec3 vWPos;
          varying vec3 vWNormal;
          // Baked, tileable value noise (see NoiseTexture): one filtered fetch per lookup.
          float tNoise(vec2 p) { return texture2D(uNoise, p * ${(1 / NOISE_CELLS).toFixed(8)}).r; }`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          // Sea bed more than 3 m under the surface: the water above hides all detail, so skip it
          // (over open sea the bed and the far shell under the water were a third of the fill cost).
          if (vWPos.y < -3.0) {
            diffuseColor.rgb *= 0.85;
          } else {
            vec3 col = diffuseColor.rgb;
            vec3 wn = normalize(vWNormal);
            float steep = 1.0 - wn.y;
            float dist = length(vViewPosition);
            float nearFade = (1.0 - smoothstep(180.0, 700.0, dist)) * uDetail;
            // The mid-field mottle fades out sooner than before: past ~2 km the ground should read as
            // broad masses of colour, not texture.
            float midFade = 1.0 - smoothstep(500.0, 2200.0, dist);
            // Grain: fine near-field grain (near pixels only) and a broader mid-field mottle.
            float n1 = nearFade > 0.001 ? tNoise(vWPos.xz * 0.45) : 0.5;
            // The mid-field mottle carries a finer octave: the old sine-hash noise picked up grain from
            // float imprecision at large coordinates, and without it the 16 m blobs read too clean.
            float n2 = tNoise(vWPos.xz * 0.06 + 3.1) * 0.7 + tNoise(vWPos.xz * 0.21 + 5.7) * 0.3;
            float n3 = tNoise(vWPos.xz * 0.012 + 9.7);
            // Mottle contrast is lower than with the old sine hash: at large coordinates that hash lost
            // precision and clustered its values, so the baked noise reads stronger for the same weight.
            col *= 1.0 + (n1 - 0.5) * 0.16 * nearFade + (n2 - 0.5) * 0.06 * midFade + (n3 - 0.5) * 0.035;
            // Soil: as the ground steepens the grass thins to a dusty brown before bare rock takes over,
            // so grass, soil and rock blend over a wide band instead of meeting at one edge.
            float soil = smoothstep(0.07, 0.30, steep + (n2 - 0.5) * 0.08) * (1.0 - vAux.w) * (1.0 - vAux.x);
            col = mix(col, mix(col, vec3(0.19, 0.155, 0.115), 0.55), soil * 0.75);
            // Rock on steep faces, using the interpolated normal. The strata and
            // crack work only runs where rock is actually visible.
            float rockMask = smoothstep(0.20, 0.52, steep + vAux.y * 0.16 + (n2 - 0.5) * 0.1);
            if (rockMask > 0.003) {
              vec3 rockA = vec3(0.155, 0.135, 0.115);
              vec3 rockB = vec3(0.30, 0.27, 0.235);
              vec3 rockCol = mix(rockA, rockB, 0.25 + 0.5 * n3);
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
            float snowSlope = 1.0 - smoothstep(0.14, 0.55, steep + (n2 - 0.5) * 0.34 - exposure);
            float snow = clamp(vAux.x + exposure, 0.0, 1.0) * snowSlope;
            snow = smoothstep(0.12, 0.8, snow + (n1 - 0.5) * 0.14 * nearFade);
            col = mix(col, vec3(0.70, 0.75, 0.86), snow);
            // Wet banks near the water line.
            col = mix(col, col * vec3(0.58, 0.56, 0.5), vAux.z);
            diffuseColor.rgb = col;
          }`,
        )
        .replace('#include <fog_fragment>', `${AERIAL_FRAGMENT}\n#include <fog_fragment>`);
    };
    this.customProgramCacheKey = () => 'skybound-terrain-v7';
  }

  /** A material instance for one morphing chunk: same program and shared uniforms, its own `uMorph`. */
  morphTwin(): TerrainMaterial {
    return new TerrainMaterial(this.terrainUniforms);
  }

  setOrigin(x: number, z: number): void {
    this.terrainUniforms.uOrigin.value.set(x, z);
  }
}
