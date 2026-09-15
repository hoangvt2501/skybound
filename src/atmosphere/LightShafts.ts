/**
 * Sun shafts for the mist valley: a handful of long, soft, additive planes
 * anchored along the valley, each billboarded around the sun-ray axis so the
 * beam always faces the camera. Brightness comes from the app (sun elevation,
 * alignment of the sun with the valley, mist amount) and is zero elsewhere.
 *
 * The billboarding runs in the vertex shader from per-instance anchors, so no
 * buffer is re-uploaded per frame (per-frame instance uploads stall the GPU on
 * ANGLE/D3D11; see the wildlife notes).
 */
import * as THREE from 'three';

export interface ShaftAnchor { x: number; y: number; z: number; length: number; width: number; seed: number }

export class LightShafts {
  readonly mesh: THREE.InstancedMesh;
  private material: THREE.ShaderMaterial;
  private aAnchor: THREE.InstancedBufferAttribute;
  private aSize: THREE.InstancedBufferAttribute;

  constructor(maxShafts = 12) {
    const g = new THREE.PlaneGeometry(1, 1, 1, 8); // subdivided along the beam for a soft length fade
    this.aAnchor = new THREE.InstancedBufferAttribute(new Float32Array(maxShafts * 3), 3);
    this.aSize = new THREE.InstancedBufferAttribute(new Float32Array(maxShafts * 3), 3); // width, length, seed
    g.setAttribute('aAnchor', this.aAnchor);
    g.setAttribute('aSize', this.aSize);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uStrength: { value: 0 },
        uColor: { value: new THREE.Color(1.0, 0.92, 0.74) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uOrigin: { value: new THREE.Vector2(0, 0) },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aAnchor;   // global x, y, z
        attribute vec3 aSize;     // width, length, seed
        uniform vec3 uSunDir;
        uniform vec2 uOrigin;
        varying vec2 vUv;
        varying float vSeed;
        void main() {
          vUv = uv; vSeed = aSize.z;
          vec3 axis = normalize(uSunDir);                       // local +Y: toward the sun
          vec3 anchor = vec3(aAnchor.x - uOrigin.x, aAnchor.y, aAnchor.z - uOrigin.y);
          vec3 toCam = cameraPosition - anchor;
          vec3 right = cross(axis, toCam);
          right = dot(right, right) < 1e-6 ? vec3(1.0, 0.0, 0.0) : normalize(right);
          // The anchor sits at the lower quarter of the beam so most of it hangs above the valley floor.
          vec3 center = anchor + axis * (aSize.y * 0.3);
          vec3 world = center + right * (position.x * aSize.x) + axis * (position.y * aSize.y);
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uStrength;
        uniform vec3 uColor;
        varying vec2 vUv;
        varying float vSeed;
        void main() {
          float across = 1.0 - abs(vUv.x * 2.0 - 1.0);           // soft edges across the beam
          float along = smoothstep(0.0, 0.25, vUv.y) * (1.0 - smoothstep(0.55, 1.0, vUv.y)); // fades toward the ground and the top
          float flicker = 0.8 + 0.2 * sin(uTime * 0.35 + vSeed * 6.28 + vUv.y * 4.0);
          float a = pow(across, 1.8) * along * flicker * uStrength;
          gl_FragColor = vec4(uColor * a, a);
        }`,
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: false,
    });
    this.mesh = new THREE.InstancedMesh(g, this.material, maxShafts);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.name = 'Sun shafts';
    this.mesh.visible = false;
  }

  /** Anchors are written once; the shader positions and orients the beams every frame. */
  setAnchors(anchors: ShaftAnchor[]): void {
    const n = Math.min(anchors.length, this.aAnchor.count);
    for (let i = 0; i < n; i++) {
      const a = anchors[i];
      this.aAnchor.setXYZ(i, a.x, a.y, a.z);
      this.aSize.setXYZ(i, a.width, a.length, a.seed);
    }
    this.aAnchor.needsUpdate = true;
    this.aSize.needsUpdate = true;
    this.mesh.count = n;
  }

  /**
   * `strength` 0..1 is computed by the caller; the beams hang from a point
   * above each anchor down along the sun-ray direction so they read as light
   * falling into the valley.
   */
  update(time: number, sunDir: THREE.Vector3, _cameraRender: THREE.Vector3, originX: number, originZ: number, strength: number): void {
    const u = this.material.uniforms;
    u.uTime.value = time;
    u.uStrength.value = strength;
    (u.uSunDir.value as THREE.Vector3).copy(sunDir);
    (u.uOrigin.value as THREE.Vector2).set(originX, originZ);
    this.mesh.visible = strength > 0.005 && this.mesh.count > 0;
  }

  dispose(): void { this.mesh.geometry.dispose(); this.material.dispose(); this.mesh.dispose(); }
}
