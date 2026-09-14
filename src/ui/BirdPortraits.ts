/**
 * Portrait images of the selectable birds, rendered by the game itself from
 * the real models, so the picker always shows exactly what will fly.
 */
import * as THREE from 'three';
import { BirdModel } from '../flight/Bird';
import { BIRD_SPECIES, type BirdSpecies } from '../flight/BirdSpecies';

export const PORTRAIT_WIDTH = 320;
export const PORTRAIT_HEIGHT = 220;

export function renderBirdPortraits(renderer: THREE.WebGLRenderer): Record<BirdSpecies, string> {
  const target = new THREE.WebGLRenderTarget(PORTRAIT_WIDTH, PORTRAIT_HEIGHT, { samples: 4, colorSpace: THREE.SRGBColorSpace });
  const camera = new THREE.PerspectiveCamera(30, PORTRAIT_WIDTH / PORTRAIT_HEIGHT, 0.1, 50);
  const canvas = document.createElement('canvas');
  canvas.width = PORTRAIT_WIDTH; canvas.height = PORTRAIT_HEIGHT;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(PORTRAIT_WIDTH, PORTRAIT_HEIGHT);
  const pixels = new Uint8Array(PORTRAIT_WIDTH * PORTRAIT_HEIGHT * 4);
  const previousTarget = renderer.getRenderTarget();
  const previousClear = new THREE.Color(); renderer.getClearColor(previousClear);
  const previousAlpha = renderer.getClearAlpha();
  const previousAutoClear = renderer.autoClear;
  const out = {} as Record<BirdSpecies, string>;
  for (const species of Object.keys(BIRD_SPECIES) as BirdSpecies[]) {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#bcd7ee');
    const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
    sun.position.set(-2.5, 4, -3);
    scene.add(sun);
    const hemi = new THREE.HemisphereLight(0xcfe3f6, 0x5f6a55, 1.2);
    scene.add(hemi);
    const model = new BirdModel(species);
    // A mid-glide pose with a hint of downstroke reads better than a flat plank.
    for (let i = 0; i < 24; i++) model.update(1 / 60, { flap: 0.35, beatRate: 1, pitchInput: 0.1, turnInput: -0.2, speed: 34, brake: 0 });
    model.group.rotation.set(0.05, 0, 0.22); // a touch of bank for life
    scene.add(model.group);
    // Three-quarter front view from slightly above, far enough for the whole span.
    const span = model.wingspan;
    camera.position.set(-0.66 * span, 0.5 * span, -1.24 * span);
    camera.lookAt(0, 0, 0.02);
    renderer.setRenderTarget(target);
    renderer.autoClear = true;
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, PORTRAIT_WIDTH, PORTRAIT_HEIGHT, pixels);
    // GL rows are bottom-up.
    for (let y = 0; y < PORTRAIT_HEIGHT; y++) {
      const src = (PORTRAIT_HEIGHT - 1 - y) * PORTRAIT_WIDTH * 4, dst = y * PORTRAIT_WIDTH * 4;
      image.data.set(pixels.subarray(src, src + PORTRAIT_WIDTH * 4), dst);
    }
    ctx.putImageData(image, 0, 0);
    out[species] = canvas.toDataURL('image/png');
    scene.remove(model.group);
    model.dispose();
  }
  renderer.setRenderTarget(previousTarget);
  renderer.setClearColor(previousClear, previousAlpha);
  renderer.autoClear = previousAutoClear;
  target.dispose();
  return out;
}
