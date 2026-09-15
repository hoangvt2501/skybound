/**
 * Render-scale without resizing the canvas. At scale 1 the scene renders
 * straight to the drawing buffer as before. Below 1 it renders into a
 * multisampled render target of the scaled size and a full-screen blit
 * upsamples it onto the canvas. Changing the scale then only resizes that
 * target (a millisecond or so) instead of the browser's swap chain, which
 * cost 20-40 ms per change on integrated GPUs and made the adaptive
 * resolution itself a source of hitches.
 *
 * The target is flagged as an XR target so three applies tone mapping and
 * the sRGB output transfer while rendering into it (three stores the encoded
 * bytes in a linear RGBA8 texture for XR targets); the blit copies them
 * unchanged.
 */
import * as THREE from 'three';

export class ScaledFrame {
  private target: THREE.WebGLRenderTarget | null = null;
  private targetWidth = 0;
  private targetHeight = 0;
  private width = 1;
  private height = 1;
  private scale = 1;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: { tFrame: { value: null }, uScale: { value: new THREE.Vector2(1, 1) } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tFrame;
        uniform vec2 uScale;
        varying vec2 vUv;
        void main() { gl_FragColor = texture2D(tFrame, vUv * uScale); }`,
      depthTest: false, depthWrite: false, toneMapped: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.quadScene.add(quad);
  }

  /** Drawing-buffer size of the canvas (device pixels). */
  setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
  }

  setScale(scale: number): void {
    this.scale = Math.min(1, Math.max(0.1, scale));
  }

  getScale(): number { return this.scale; }

  /** Size of the buffer the scene is actually rendered into. */
  bufferSize(): { width: number; height: number } {
    if (this.scale >= 0.999) return { width: this.width, height: this.height };
    return { width: Math.max(1, Math.round(this.width * this.scale)), height: Math.max(1, Math.round(this.height * this.scale)) };
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    if (this.scale >= 0.999) {
      renderer.render(scene, camera);
      return;
    }
    const { width, height } = this.bufferSize();
    const target = this.ensureTarget(width, height);
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    this.material.uniforms.tFrame.value = target.texture;
    (this.material.uniforms.uScale.value as THREE.Vector2).set(1, 1);
    renderer.render(this.quadScene, this.quadCamera);
  }

  /** Compile the blit program ahead of the first scaled frame. */
  warm(renderer: THREE.WebGLRenderer): void {
    const target = this.ensureTarget(4, 4);
    this.material.uniforms.tFrame.value = target.texture;
    renderer.compile(this.quadScene, this.quadCamera);
  }

  private ensureTarget(width: number, height: number): THREE.WebGLRenderTarget {
    if (this.target && this.targetWidth === width && this.targetHeight === height) return this.target;
    if (!this.target) {
      // Only the colour buffer is resolved after the frame: nothing reads the target's depth, and on
      // ANGLE/D3D11 resolving the multisampled depth buffer as well (three's default) cost 2.5 ms per
      // frame at 1344x756, a fifth of the whole scene pass.
      this.target = new THREE.WebGLRenderTarget(width, height, {
        samples: 4, depthBuffer: true, stencilBuffer: false, generateMipmaps: false,
        resolveDepthBuffer: false, resolveStencilBuffer: false,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, colorSpace: THREE.SRGBColorSpace,
      });
      // XR flag: materials apply tone mapping and the sRGB transfer while rendering into the target.
      // An explicit RGBA8 storage keeps the resolve texture and the multisample renderbuffer in the
      // same format (three would otherwise pick SRGB8_ALPHA8 for one and RGBA8 for the other and the
      // multisample resolve blit fails); the encoded bytes are copied unchanged by the blit.
      (this.target as unknown as { isXRRenderTarget: boolean }).isXRRenderTarget = true;
      this.target.texture.internalFormat = 'RGBA8';
    } else {
      this.target.setSize(width, height);
    }
    this.targetWidth = width; this.targetHeight = height;
    return this.target;
  }

  dispose(): void {
    this.target?.dispose();
    this.target = null;
    this.material.dispose();
  }
}
