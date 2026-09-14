/**
 * Procedural low-poly vegetation library. One merged, vertex-colored geometry
 * per species, shared by every instanced mesh in the world.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SPECIES_COUNT, Species } from './biomes';

function paint(g: THREE.BufferGeometry, color: THREE.ColorRepresentation, vary = 0): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = 1 + (vary ? (Math.sin(i * 12.9898) * 43758.5453) % 1 * vary : 0);
    arr[i * 3] = c.r * v;
    arr[i * 3 + 1] = c.g * v;
    arr[i * 3 + 2] = c.b * v;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function place(g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, s: THREE.Vector3 | number = 1): THREE.BufferGeometry {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz));
  const sc = typeof s === 'number' ? new THREE.Vector3(s, s, s) : s;
  m.compose(new THREE.Vector3(x, y, z), q, sc);
  g.applyMatrix4(m);
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const nonIndexed = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  for (const p of nonIndexed) {
    // Ensure attribute sets match for merging.
    if (!p.attributes.uv) p.deleteAttribute('uv');
  }
  for (const p of nonIndexed) p.deleteAttribute('uv');
  const merged = mergeGeometries(nonIndexed, false)!;
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  for (const p of parts) p.dispose();
  return merged;
}

const BARK = '#6b4a2f';
const BARK_LIGHT = '#8a6a4a';

function oak(): THREE.BufferGeometry {
  const trunk = paint(new THREE.CylinderGeometry(0.32, 0.55, 4.6, 7), BARK);
  place(trunk, 0, 2.3, 0);
  const c1 = paint(new THREE.IcosahedronGeometry(2.8, 1), '#3f7a2c', 0.08);
  place(c1, 0, 6.4, 0, 0.2, 0.4, 0, new THREE.Vector3(1.15, 0.95, 1.1));
  const c2 = paint(new THREE.IcosahedronGeometry(2.1, 1), '#4c8a33', 0.08);
  place(c2, 1.6, 5.4, 0.9, 0, 1.1, 0.3);
  const c3 = paint(new THREE.IcosahedronGeometry(2.0, 1), '#376f27', 0.08);
  place(c3, -1.5, 5.6, -0.8, 0.3, 2.2, 0);
  const c4 = paint(new THREE.IcosahedronGeometry(1.7, 1), '#5b9a3d', 0.08);
  place(c4, 0.2, 8.1, -0.4, 0.5, 0.7, 0.2);
  return merge([trunk, c1, c2, c3, c4]);
}

function pine(): THREE.BufferGeometry {
  const trunk = paint(new THREE.CylinderGeometry(0.22, 0.42, 5.5, 6), BARK);
  place(trunk, 0, 2.75, 0);
  const t1 = paint(new THREE.ConeGeometry(2.7, 4.2, 7), '#2f6a3a', 0.08);
  place(t1, 0, 5.4, 0);
  const t2 = paint(new THREE.ConeGeometry(2.1, 3.8, 7), '#356f3e', 0.08);
  place(t2, 0, 8.0, 0, 0, 0.4, 0);
  const t3 = paint(new THREE.ConeGeometry(1.4, 3.4, 7), '#3b7a44', 0.08);
  place(t3, 0, 10.4, 0, 0, 0.8, 0);
  const t4 = paint(new THREE.ConeGeometry(0.7, 2.4, 6), '#3f8248', 0.08);
  place(t4, 0, 12.4, 0);
  return merge([trunk, t1, t2, t3, t4]);
}

function birch(): THREE.BufferGeometry {
  const trunk = paint(new THREE.CylinderGeometry(0.16, 0.28, 7.5, 6), '#e6e2d6');
  place(trunk, 0, 3.75, 0, 0, 0, 0.04);
  const c1 = paint(new THREE.IcosahedronGeometry(1.9, 1), '#8fbf4a', 0.1);
  place(c1, 0.2, 7.6, 0, 0, 0.3, 0, new THREE.Vector3(1, 1.3, 1));
  const c2 = paint(new THREE.IcosahedronGeometry(1.4, 1), '#a3cc55', 0.1);
  place(c2, -0.9, 6.4, 0.6, 0, 1.5, 0);
  const c3 = paint(new THREE.IcosahedronGeometry(1.2, 1), '#7fb043', 0.1);
  place(c3, 0.8, 9.3, -0.5, 0, 2.3, 0);
  return merge([trunk, c1, c2, c3]);
}

function palm(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // Curved trunk from stacked segments.
  let x = 0, y = 0, lean = 0;
  for (let i = 0; i < 6; i++) {
    const seg = paint(new THREE.CylinderGeometry(0.22 - i * 0.015, 0.28 - i * 0.015, 1.4, 6), BARK_LIGHT);
    place(seg, x, y + 0.7, 0, 0, 0, -lean);
    parts.push(seg);
    lean += 0.06;
    x += Math.sin(lean) * 1.3;
    y += Math.cos(lean) * 1.3;
  }
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const frond = paint(new THREE.ConeGeometry(0.55, 3.6, 4), i % 2 ? '#3f8a3c' : '#4e9a44', 0.06);
    place(frond, x + Math.cos(a) * 1.4, y + 0.5, Math.sin(a) * 1.4, Math.cos(a) * 1.25, 0, -Math.sin(a) * 1.25, new THREE.Vector3(1, 1, 0.35));
    parts.push(frond);
  }
  const top = paint(new THREE.IcosahedronGeometry(0.6, 0), '#6a4a2a');
  place(top, x, y + 0.4, 0);
  parts.push(top);
  return merge(parts);
}

function cactus(): THREE.BufferGeometry {
  const body = paint(new THREE.CylinderGeometry(0.45, 0.5, 3.6, 8), '#4f8a52', 0.05);
  place(body, 0, 1.8, 0);
  const cap = paint(new THREE.SphereGeometry(0.45, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), '#4f8a52');
  place(cap, 0, 3.6, 0);
  const armL = paint(new THREE.CylinderGeometry(0.25, 0.28, 1.4, 7), '#4a8250');
  place(armL, -0.75, 2.6, 0, 0, 0, 0);
  const elbowL = paint(new THREE.CylinderGeometry(0.27, 0.27, 0.9, 7), '#4a8250');
  place(elbowL, -0.5, 1.95, 0, 0, 0, Math.PI / 2);
  const armR = paint(new THREE.CylinderGeometry(0.22, 0.25, 1.1, 7), '#4a8250');
  place(armR, 0.7, 2.0, 0.1);
  const elbowR = paint(new THREE.CylinderGeometry(0.24, 0.24, 0.8, 7), '#4a8250');
  place(elbowR, 0.45, 1.5, 0.1, 0, 0, Math.PI / 2);
  return merge([body, cap, armL, elbowL, armR, elbowR]);
}

function deadwood(): THREE.BufferGeometry {
  const trunk = paint(new THREE.CylinderGeometry(0.18, 0.4, 5.5, 6), '#6f665c');
  place(trunk, 0, 2.75, 0, 0, 0, 0.05);
  const b1 = paint(new THREE.CylinderGeometry(0.07, 0.14, 2.6, 5), '#6f665c');
  place(b1, 0.9, 4.2, 0.2, 0, 0, -0.9);
  const b2 = paint(new THREE.CylinderGeometry(0.06, 0.12, 2.2, 5), '#6f665c');
  place(b2, -0.7, 4.9, -0.3, 0.3, 0, 0.8);
  const b3 = paint(new THREE.CylinderGeometry(0.05, 0.1, 1.6, 5), '#6f665c');
  place(b3, 0.1, 5.9, 0.6, -0.9, 0, 0.1);
  return merge([trunk, b1, b2, b3]);
}

function shrub(): THREE.BufferGeometry {
  const a = paint(new THREE.IcosahedronGeometry(1.3, 1), '#5d7d34', 0.1);
  place(a, 0, 1.0, 0, 0, 0.5, 0, new THREE.Vector3(1.1, 0.75, 1));
  const b = paint(new THREE.IcosahedronGeometry(0.9, 1), '#6d8a3a', 0.1);
  place(b, 0.9, 0.8, 0.5, 0, 1.2, 0, new THREE.Vector3(1, 0.7, 1));
  const c = paint(new THREE.IcosahedronGeometry(0.8, 1), '#557530', 0.1);
  place(c, -0.8, 0.75, -0.4, 0, 2.0, 0, new THREE.Vector3(1, 0.7, 1));
  return merge([a, b, c]);
}

function willow(): THREE.BufferGeometry {
  const trunk = paint(new THREE.CylinderGeometry(0.3, 0.5, 3.8, 7), BARK);
  place(trunk, 0, 1.9, 0, 0, 0, 0.08);
  const crown = paint(new THREE.SphereGeometry(3.0, 9, 6), '#7fa64d', 0.08);
  place(crown, 0.2, 5.4, 0, 0, 0, 0, new THREE.Vector3(1, 0.75, 1));
  const drape = paint(new THREE.ConeGeometry(3.4, 4.2, 9, 1, true), '#6f9a44', 0.08);
  place(drape, 0.2, 3.9, 0, Math.PI, 0, 0);
  return merge([trunk, crown, drape]);
}

export class VegetationLibrary {
  readonly geometries: THREE.BufferGeometry[] = [];
  readonly material: THREE.MeshLambertMaterial;

  constructor() {
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });
    const builders: (() => THREE.BufferGeometry)[] = [oak, pine, birch, palm, cactus, deadwood, shrub, willow];
    for (let i = 0; i < SPECIES_COUNT; i++) this.geometries[i] = builders[i]();
  }

  geometry(species: Species): THREE.BufferGeometry {
    return this.geometries[species];
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.material.dispose();
  }
}
